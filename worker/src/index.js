// ============================================================================
// beerstock-api
//
// Ein einziger Worker mit vier Routen. Kein Framework: der Router unten ist
// zwanzig Zeilen lang und macht genau das, was hier gebraucht wird - eine
// Abhaengigkeit dafuer waere mehr Pflege als Nutzen.
//
// Aufbau der Antworten: immer JSON, immer mit CORS-Kopf, Fehler immer als
// { fehler: "..." }. Damit muss die Seite nie zwei Formen unterscheiden.
//
// In der Datenbank steht nichts, was jemanden handlungsfaehig macht: Token und
// Einladungscodes liegen ausschliesslich als SHA-256-Hex.
// ============================================================================

/* Nur die eigene Seite darf die API im Browser aufrufen. Der Kopf schuetzt
   nicht davor, dass jemand mit curl vorbeikommt - das tut kein CORS-Kopf -,
   aber er verhindert, dass eine fremde Seite den Browser eines Angemeldeten
   fuer sich arbeiten laesst. Der eigentliche Schutz sind Token und Grenzen. */
const ERLAUBTE_HERKUNFT = new Set([
  'https://schnix84.github.io',
  'http://localhost:8788',   // lokale Vorschau
]);

// Grenzen. Ernst gemeint, nicht kosmetisch: ohne Obergrenze schreibt der erste
// Spassvogel 2^53 Biere und die Bestenliste ist erledigt.
const MAX_BIERE   = 999;
const MIN_GRAD    = -30;
const MAX_GRAD    = 30;
const MELDESPERRE = 60;      // Sekunden zwischen zwei Meldungen desselben Nutzers
const VERLAUF_TAGE = 30;

// Ohne I, O, 0, 1 - die verwechselt man beim Abtippen aus einem Chat.
const CODE_ZEICHEN = /[A-HJ-NP-Z2-9]/;

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------
function koepfe(request) {
  const herkunft = request.headers.get('Origin');
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  };
  if (herkunft && ERLAUBTE_HERKUNFT.has(herkunft)) {
    h['Access-Control-Allow-Origin'] = herkunft;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const antwort = (request, daten, status = 200, extra = {}) =>
  new Response(JSON.stringify(daten), {
    status,
    headers: { ...koepfe(request), ...extra },
  });

const fehler = (request, text, status = 400) =>
  antwort(request, { fehler: text }, status);

async function hash(text) {
  const roh = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(roh)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Codes duerfen so ankommen, wie sie im Chat standen: Kleinschreibung,
   Bindestriche, Leerzeichen. Gehasht wird immer dieselbe nackte Form. */
const normCode = s =>
  [...String(s).toUpperCase()].filter(c => CODE_ZEICHEN.test(c)).join('');

async function json(request) {
  try { return await request.json(); } catch { return null; }
}

/* Der Traeger des Tokens ist der Nutzer - mehr Anmeldung gibt es nicht. */
async function nutzer(request, env) {
  const kopf = request.headers.get('Authorization') || '';
  const token = kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
  if (!token) return null;
  return env.DB.prepare(
    'SELECT id, name, quelle FROM users WHERE token_hash = ?'
  ).bind(await hash(token)).first();
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------
const ROUTEN = {

  'GET /api/health': async (request, env) => {
    /* Meldet auch, ob die Datenbank haengt - eine Bereitschaftsmeldung, die
       nur den Worker prueft, geht genau dann noch gut, wenn es darauf ankommt. */
    let db = 'nicht eingerichtet';
    if (env.DB) {
      try {
        await env.DB.prepare('SELECT 1').first();
        db = 'ok';
      } catch (e) {
        db = 'fehler: ' + e.message;
      }
    }
    return antwort(request, { ok: true, dienst: 'beerstock-api', db });
  },

  // -------------------------------------------------------------------------
  'POST /api/register': async (request, env) => {
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const code = normCode(daten.code || '');
    if (code.length < 6) return fehler(request, 'Einladungscode fehlt');

    const name = String(daten.name || '').trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N} _.\-]{2,20}$/u.test(name)) {
      return fehler(request,
        'Name: 2 bis 20 Zeichen, Buchstaben, Ziffern, Leerzeichen, - . _');
    }

    /* Den Code zuerst BELEGEN, dann den Nutzer anlegen. Andersherum koennten
       zwei gleichzeitige Anmeldungen denselben Code verbrauchen: beide sehen
       ihn frei, beide legen an. Das UPDATE unten ist die eine Stelle, an der
       die Datenbank die Entscheidung faellt - `changes === 1` gewinnt.
       `verbraucht_am` ist die Belegung, `verbraucht_von` kommt erst danach. */
    const belegt = await env.DB.prepare(`
      UPDATE invites SET verbraucht_am = datetime('now')
      WHERE code_hash = ?
        AND verbraucht_am IS NULL
        AND (laeuft_ab IS NULL OR laeuft_ab > datetime('now'))
    `).bind(await hash(code)).run();

    if (belegt.meta.changes !== 1) {
      // Absichtlich dieselbe Auskunft fuer "gibt es nicht", "schon benutzt"
      // und "abgelaufen": sonst ist die Fehlermeldung ein Code-Orakel.
      return fehler(request, 'Dieser Einladungscode gilt nicht (mehr)', 403);
    }

    const token = [...crypto.getRandomValues(new Uint8Array(32))]
      .map(b => b.toString(16).padStart(2, '0')).join('');

    try {
      const neu = await env.DB.prepare(`
        INSERT INTO users (name, name_klein, token_hash)
        VALUES (?, ?, ?) RETURNING id
      `).bind(name, name.toLowerCase(), await hash(token)).first();

      await env.DB.prepare('UPDATE invites SET verbraucht_von = ? WHERE code_hash = ?')
        .bind(neu.id, await hash(code)).run();

      return antwort(request, { token, name }, 201);
    } catch (e) {
      // Name schon vergeben o. ae. - der Code muss zurueck in den Topf, sonst
      // verbrennt ein Tippfehler eine Einladung.
      await env.DB.prepare(
        'UPDATE invites SET verbraucht_am = NULL WHERE code_hash = ? AND verbraucht_von IS NULL'
      ).bind(await hash(code)).run();

      if (String(e.message || '').includes('UNIQUE')) {
        return fehler(request, 'Den Namen gibt es schon - nimm einen anderen', 409);
      }
      throw e;
    }
  },

  // -------------------------------------------------------------------------
  /* Wer bin ich? Die Seite braucht das nach jedem Neuladen, um die eigene
     Zeile hervorzuheben - und um zu merken, dass ein Token nicht mehr gilt.
     Absichtlich mager: Name und Herkunft, sonst nichts. */
  'GET /api/me': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    return antwort(request, { name: ich.name, gemessen: ich.quelle === 'ha' });
  },

  // -------------------------------------------------------------------------
  'POST /api/report': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const biere = Number(daten.biere);
    if (!Number.isInteger(biere) || biere < 0 || biere > MAX_BIERE) {
      return fehler(request, `Biere: ganze Zahl zwischen 0 und ${MAX_BIERE}`);
    }
    // Komma erlaubt: die Seite zeigt "4,9 °C", also tippt man das auch so.
    const temperatur = Number(String(daten.temperatur).replace(',', '.'));
    if (!Number.isFinite(temperatur) || temperatur < MIN_GRAD || temperatur > MAX_GRAD) {
      return fehler(request, `Grad: Zahl zwischen ${MIN_GRAD} und ${MAX_GRAD}`);
    }

    /* Eine Meldung pro Minute. Nicht gegen Angreifer - gegen den Freund, der
       den Knopf zehnmal drueckt, weil er nichts passieren sieht. */
    const letzte = await env.DB.prepare(`
      SELECT gemeldet_am FROM reports
      WHERE user_id = ? AND gemeldet_am > datetime('now', ?)
      ORDER BY id DESC LIMIT 1
    `).bind(ich.id, `-${MELDESPERRE} seconds`).first();
    if (letzte) return fehler(request, 'Zu schnell - eine Meldung pro Minute', 429);

    await env.DB.batch([
      env.DB.prepare('INSERT INTO reports (user_id, biere, temperatur) VALUES (?, ?, ?)')
        .bind(ich.id, biere, Math.round(temperatur * 10) / 10),
      env.DB.prepare("UPDATE users SET zuletzt = datetime('now') WHERE id = ?").bind(ich.id),
    ]);

    /* Der Rang gleich mit: die Seite kann ihn sofort anzeigen, ohne die ganze
       Bestenliste noch einmal zu holen. */
    const rang = await env.DB.prepare(`
      SELECT count(*) + 1 AS rang FROM (
        SELECT user_id, max(id) AS id FROM reports GROUP BY user_id
      ) j JOIN reports r ON r.id = j.id
      WHERE r.biere > ? AND j.user_id <> ?
    `).bind(biere, ich.id).first();

    return antwort(request, { ok: true, name: ich.name, biere, rang: rang.rang }, 201);
  },

  // -------------------------------------------------------------------------
  'GET /api/leaderboard': async (request, env) => {
    /* Drei Abfragen in einem Rutsch: aktueller Stand, Bestmarke, Verlauf.
       Der aktuelle Stand ist die juengste Meldung je Nutzer - deshalb wird
       nie ueberschrieben, der Verlauf faellt dabei von selbst an. */
    const [stand, best, verlauf] = await env.DB.batch([
      env.DB.prepare(`
        SELECT u.id, u.name, u.quelle, r.biere, r.temperatur, r.gemeldet_am
        FROM users u
        JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j
          ON j.user_id = u.id
        JOIN reports r ON r.id = j.id
        ORDER BY r.biere DESC, r.gemeldet_am ASC
      `),
      env.DB.prepare('SELECT user_id, max(biere) AS best FROM reports GROUP BY user_id'),
      // Ein Wert je Tag und Nutzer: der letzte des Tages.
      env.DB.prepare(`
        SELECT r.user_id, date(r.gemeldet_am) AS tag, r.biere
        FROM reports r
        JOIN (
          SELECT user_id, date(gemeldet_am) AS tag, max(id) AS id
          FROM reports
          WHERE gemeldet_am > datetime('now', ?)
          GROUP BY user_id, date(gemeldet_am)
        ) j ON j.id = r.id
        ORDER BY r.user_id, tag
      `).bind(`-${VERLAUF_TAGE} days`),
    ]);

    const bestmarke = new Map(best.results.map(r => [r.user_id, r.best]));
    const kurve = new Map();
    for (const z of verlauf.results) {
      if (!kurve.has(z.user_id)) kurve.set(z.user_id, []);
      kurve.get(z.user_id).push(z.biere);
    }

    const feld = stand.results.map(r => ({
      name: r.name,
      biere: r.biere,
      temperatur: r.temperatur,
      // Immer mit Z: die Seite rechnet daraus "aktuell" oder "vor N Tagen",
      // und ohne Zonenangabe verschiebt sich das je nach Betrachter.
      gemeldet: r.gemeldet_am.replace(' ', 'T') + 'Z',
      gemessen: r.quelle === 'ha',
      best: bestmarke.get(r.id) ?? r.biere,
      verlauf: kurve.get(r.id) || [r.biere],
    }));

    // Eine halbe Minute Cache: die Seite wird oefter geladen als gemeldet.
    return antwort(request, { feld }, 200, {
      'Cache-Control': 'public, max-age=30',
    });
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Vorabfrage des Browsers vor jedem POST mit Authorization-Kopf.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: koepfe(request) });
    }

    const treffer = ROUTEN[`${request.method} ${url.pathname}`];
    if (!treffer) return fehler(request, 'Route gibt es nicht', 404);

    try {
      return await treffer(request, env, ctx);
    } catch (e) {
      /* Der Fehlertext geht ins Log, nicht an den Aufrufer: er kann
         Tabellennamen oder Werte enthalten. */
      console.error('unerwartet:', e && e.stack || e);
      return fehler(request, 'Da ist etwas schiefgegangen', 500);
    }
  },
};
