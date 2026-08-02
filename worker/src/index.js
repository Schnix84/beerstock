// ============================================================================
// beerstock-api
//
// Kein Framework: der Router unten ist zwanzig Zeilen lang und macht genau das,
// was hier gebraucht wird. Antworten immer JSON, immer mit CORS-Kopf, Fehler
// immer als { fehler: "..." } - so muss die Seite nie zwei Formen unterscheiden.
//
// ANMELDUNG: Die Mailadresse ist die Identitaet, es gibt kein Passwort. Wer
// rein will, tippt seine Adresse ein und klickt den Link in der Mail - auf
// jedem Geraet, beliebig oft. Damit gibt es nichts zu vergessen, nichts zu
// speichern, was gestohlen werden koennte, und "ausgesperrt" ist kein Zustand,
// aus dem man nicht selbst wieder herauskommt.
//
// In der Datenbank steht nichts, was jemanden handlungsfaehig macht: Geraete-
// Token und Magic Links liegen ausschliesslich als SHA-256-Hex.
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
const MAX_BIERE    = 999;
const MIN_GRAD     = -30;
const MAX_GRAD     = 30;
const MELDESPERRE  = 60;    // Sekunden zwischen zwei Meldungen desselben Nutzers
const VERLAUF_TAGE = 30;

// Magic Links. Kurz gueltig, weil eine Mail im Posteingang liegen bleibt.
const LINK_MINUTEN = 15;
/* Die Missbrauchsbremse. Offener Zugang plus Mailversand heisst: ohne diese
   Zahlen ist der Posteingang ein Versandknopf im Netz, mit dem ein Fremder
   beliebige Leute zumuellen kann - bis AgentMail das Konto dichtmacht. */
const LINKS_PRO_ADRESSE = 3;    // je Stunde
const LINKS_GESAMT      = 30;   // je Stunde, ueber alle Adressen

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------
function koepfe(request) {
  const herkunft = request.headers.get('Origin');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin' };
  if (herkunft && ERLAUBTE_HERKUNFT.has(herkunft)) {
    h['Access-Control-Allow-Origin'] = herkunft;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const antwort = (request, daten, status = 200, extra = {}) =>
  new Response(JSON.stringify(daten), { status, headers: { ...koepfe(request), ...extra } });

const fehler = (request, text, status = 400) => antwort(request, { fehler: text }, status);

async function hash(text) {
  const roh = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(roh)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const wuerfel = () => [...crypto.getRandomValues(new Uint8Array(32))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

async function json(request) {
  try { return await request.json(); } catch { return null; }
}

/* Absichtlich nachsichtig: eine Adresse, die hier durchkommt, aber nicht
   existiert, bekommt schlicht keine Mail. Strenge Regexe lehnen dagegen
   regelmaessig gueltige Adressen ab, und das merkt niemand rechtzeitig. */
const istMail = s => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;

const normMail = s => String(s || '').trim().toLowerCase();

/* Der Traeger eines Geraete-Tokens ist der Nutzer. Ein Nutzer kann mehrere
   haben - Handy und Laptop sollen sich nicht gegenseitig ausloggen. */
async function nutzer(request, env) {
  const kopf = request.headers.get('Authorization') || '';
  const token = kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
  if (!token) return null;
  const h = await hash(token);
  const u = await env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.quelle FROM tokens t
    JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
  `).bind(h).first();
  if (u) {
    // Nebenbei, ohne die Antwort aufzuhalten: wann war dieses Geraet zuletzt da.
    u._token_hash = h;
  }
  return u;
}

// ---------------------------------------------------------------------------
// Mailversand ueber AgentMail. Reine HTTP-API, kein SMTP.
// ---------------------------------------------------------------------------
async function schickeLink(env, empfaenger, link) {
  const text =
`Hier entlang, dann bist du drin:

${link}

Der Link gilt ${LINK_MINUTEN} Minuten und genau einmal. Hast du ihn nicht
angefordert, ist nichts passiert - dann wirf die Mail einfach weg.`;

  const html =
`<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>Hier entlang, dann bist du drin:</p>
  <p><a href="${link}" style="display:inline-block;background:#2f5d4a;color:#e3d8c1;
     padding:12px 22px;border-radius:3px;text-decoration:none;letter-spacing:.15em;
     text-transform:uppercase;font-size:13px">Anmelden</a></p>
  <p style="font-size:13px;color:#6f6653">Der Link gilt ${LINK_MINUTEN} Minuten und genau
     einmal. Hast du ihn nicht angefordert, ist nichts passiert &ndash; dann wirf
     die Mail einfach weg.</p>
</div>`;

  const r = await fetch(
    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(env.AGENTMAIL_INBOX)}/messages/send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AGENTMAIL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: empfaenger,
        subject: 'Dein Link zum Bierranking',
        text, html,
      }),
    });

  if (!r.ok) {
    const grund = await r.text().catch(() => '');
    throw new Error(`AgentMail ${r.status}: ${grund.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------
const ROUTEN = {

  'GET /api/health': async (request, env) => {
    let db = 'nicht eingerichtet';
    if (env.DB) {
      try { await env.DB.prepare('SELECT 1').first(); db = 'ok'; }
      catch (e) { db = 'fehler: ' + e.message; }
    }
    return antwort(request, {
      ok: true, dienst: 'beerstock-api', db,
      mail: env.AGENTMAIL_KEY ? 'Schluessel liegt an' : 'KEIN SCHLUESSEL',
      inbox: env.AGENTMAIL_INBOX || null,
    });
  },

  // -------------------------------------------------------------------------
  /* Schritt 1 der Anmeldung: Adresse rein, Link raus. Gilt fuer Neue und
     Wiederkehrende gleichermassen - es gibt nur diesen einen Weg. */
  'POST /api/anmelden': async (request, env) => {
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const email = normMail(daten.email);
    if (!istMail(email)) return fehler(request, 'Das sieht nicht nach einer Mailadresse aus');
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);

    const [proAdresse, gesamt] = await env.DB.batch([
      env.DB.prepare("SELECT count(*) AS n FROM magic WHERE email = ? AND erstellt > datetime('now','-1 hour')").bind(email),
      env.DB.prepare("SELECT count(*) AS n FROM magic WHERE erstellt > datetime('now','-1 hour')"),
    ]);
    if (proAdresse.results[0].n >= LINKS_PRO_ADRESSE) {
      return fehler(request, 'Für diese Adresse ging gerade schon ein Link raus. Schau ins Postfach, auch im Spam.', 429);
    }
    if (gesamt.results[0].n >= LINKS_GESAMT) {
      return fehler(request, 'Gerade zu viel Andrang. Versuch es in einer Stunde nochmal.', 429);
    }

    const token = wuerfel();
    await env.DB.prepare(`
      INSERT INTO magic (token_hash, email, laeuft_ab)
      VALUES (?, ?, datetime('now', ?))
    `).bind(await hash(token), email, `+${LINK_MINUTEN} minutes`).run();

    const link = `${env.SEITE}#anmelden=${token}`;
    try {
      await schickeLink(env, email, link);
    } catch (e) {
      console.error('Mailversand:', e.message);
      return fehler(request, 'Die Mail ging nicht raus. Das liegt an uns, nicht an dir.', 502);
    }

    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Schritt 2: der Link wird eingeloest. Die Seite schickt den Wert aus ihrem
     Adressfragment hierher und bekommt ein Geraete-Token zurueck. */
  'POST /api/magic': async (request, env) => {
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const roh = String(daten.token || '');
    if (roh.length < 32) return fehler(request, 'Link unvollständig', 400);

    const h = await hash(roh);
    /* Einloesen heisst BELEGEN: `changes === 1` gewinnt. Sonst koennten zwei
       Klicks auf denselben Link zwei Sitzungen erzeugen. */
    const belegt = await env.DB.prepare(`
      UPDATE magic SET verbraucht_am = datetime('now')
      WHERE token_hash = ? AND verbraucht_am IS NULL AND laeuft_ab > datetime('now')
    `).bind(h).run();
    if (belegt.meta.changes !== 1) {
      return fehler(request, 'Dieser Link ist abgelaufen oder schon benutzt. Fordere einen neuen an.', 403);
    }

    const zeile = await env.DB.prepare('SELECT email FROM magic WHERE token_hash = ?').bind(h).first();
    const email = zeile.email;

    let u = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
    if (!u) {
      // Neu. Der Name fuer die Liste kommt gleich danach, in einem eigenen
      // Schritt - hier weiss die Seite noch gar nicht, wer das ist.
      u = await env.DB.prepare('INSERT INTO users (email) VALUES (?) RETURNING id, name')
        .bind(email).first();
    }

    const token = wuerfel();
    await env.DB.prepare('INSERT INTO tokens (token_hash, user_id) VALUES (?, ?)')
      .bind(await hash(token), u.id).run();

    return antwort(request, { token, name: u.name, braucht_namen: !u.name });
  },

  // -------------------------------------------------------------------------
  'GET /api/me': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    return antwort(request, {
      name: ich.name,
      braucht_namen: !ich.name,
      gemessen: ich.quelle === 'ha',
    });
  },

  // -------------------------------------------------------------------------
  /* Den Namen fuer die Liste setzen oder aendern. Getrennt vom Einloesen,
     weil der Nutzer beim Klick auf den Link noch nichts eingetippt hat. */
  'POST /api/name': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const name = String(daten.name || '').trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N} _.\-]{2,20}$/u.test(name)) {
      return fehler(request, 'Name: 2 bis 20 Zeichen, Buchstaben, Ziffern, Leerzeichen, - . _');
    }
    try {
      await env.DB.prepare('UPDATE users SET name = ?, name_klein = ? WHERE id = ?')
        .bind(name, name.toLowerCase(), ich.id).run();
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return fehler(request, 'Den Namen gibt es schon - nimm einen anderen', 409);
      }
      throw e;
    }
    return antwort(request, { ok: true, name });
  },

  // -------------------------------------------------------------------------
  /* Abmelden wirft NUR dieses Geraet raus. Die anderen bleiben angemeldet,
     und der Eintrag in der Liste bleibt sowieso - abmelden ist kein Austritt. */
  'POST /api/abmelden': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return antwort(request, { ok: true });   // schon weg, auch gut
    await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?').bind(ich._token_hash).run();
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  'POST /api/report': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

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
      SELECT 1 FROM reports WHERE user_id = ? AND gemeldet_am > datetime('now', ?) LIMIT 1
    `).bind(ich.id, `-${MELDESPERRE} seconds`).first();
    if (letzte) return fehler(request, 'Zu schnell - eine Meldung pro Minute', 429);

    await env.DB.batch([
      env.DB.prepare('INSERT INTO reports (user_id, biere, temperatur) VALUES (?, ?, ?)')
        .bind(ich.id, biere, Math.round(temperatur * 10) / 10),
      env.DB.prepare("UPDATE users SET zuletzt = datetime('now') WHERE id = ?").bind(ich.id),
      env.DB.prepare("UPDATE tokens SET zuletzt = datetime('now') WHERE token_hash = ?").bind(ich._token_hash),
    ]);

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
        WHERE u.name IS NOT NULL
        ORDER BY r.biere DESC, r.gemeldet_am ASC
      `),
      env.DB.prepare('SELECT user_id, max(biere) AS best FROM reports GROUP BY user_id'),
      // Ein Wert je Tag und Nutzer: der letzte des Tages.
      env.DB.prepare(`
        SELECT r.user_id, date(r.gemeldet_am) AS tag, r.biere
        FROM reports r
        JOIN (
          SELECT user_id, date(gemeldet_am) AS tag, max(id) AS id
          FROM reports WHERE gemeldet_am > datetime('now', ?)
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
    return antwort(request, { feld }, 200, { 'Cache-Control': 'public, max-age=30' });
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
         Tabellennamen, Adressen oder Werte enthalten. */
      console.error('unerwartet:', e && e.stack || e);
      return fehler(request, 'Da ist etwas schiefgegangen', 500);
    }
  },
};
