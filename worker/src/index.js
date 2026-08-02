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

import { Tafel } from './tafel.js';
export { Tafel };

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

/* Das Gluecksrad. Gewichtet nach Bestand, weil das die Zahl ist, um die sich
   die ganze Seite dreht: wer mehr kalt hat, wird oefter gezogen. Der Deckel
   verhindert, dass einer mit 200 gemeldeten Bieren das Rad besitzt. */
/* Kein Verfallsdatum auf einer Meldung: wer Bier eingetragen hat, spielt mit,
   egal wie alt der Eintrag ist. Hier stand einmal ein 24-Stunden-Fenster - das
   hat den ausgeschlossen, der oben auf der Tafel steht, weil er seit zwei
   Tagen nicht nachgetragen hat. Wer nichts mehr hat, meldet null; das ist der
   ehrliche Weg hier raus, nicht das Schweigen. */
const LOS_MIN     = 1;    // ohne kaltes Bier kein Gastgeber
const LOS_DECKEL  = 24;   // Gewicht = min(biere, 24), ein Kasten ist die Obergrenze
const LOS_MINDEST = 2;    // unter zweien gibt es nichts auszulosen

/* Wer gezogen wurde, sagt zu oder ab - und wer gar nicht antwortet, darf den
   Tag nicht besitzen. Nach dieser Frist gilt das Los als verfallen und der Tag
   ist wieder frei. Kein Cron dahinter: der naechste Dreher traegt es nach
   (siehe verfallStmt). Wichtig fuer den gemessenen Melder aus Home Assistant -
   der kann von sich aus ueberhaupt nicht antworten. */
const LOS_FRIST   = 3;    // Stunden
/* Ab der zweiten Drehung eines Tages genuegt EINER im Topf. Sonst sperrt eine
   einzige Absage bei genau zwei Meldern den ganzen Abend. */
const LOS_MINDEST_WEITER = 1;
const GRUND_MAX   = 120;  // Zeichen fuer "Heute nicht, weil ..."

/* Termine. Der Abend, der aus einer Zusage entsteht - oder von Hand eingetragen
   wird, denn nicht jeder Bierabend faellt aus einer Ziehung. */
const TERMIN_VORAUS      = 90;   // Tage, so weit darf einer im Voraus liegen
const TERMIN_RUECK       = 24;   // Stunden, so weit darf er zurueckliegen
const TERMINE_PRO_TAG    = 3;    // je Nutzer und Tag, gegen das Vollschreiben
const TERMIN_TITEL_MAX   = 60;   // Zeichen
const TERMINE_RUECKBLICK = 14;   // Tage, so weit reicht die Liste zurueck
/* Wenn ein Client bei der Zusage keine Uhrzeit mitschickt. 17:00 UTC ist 19:00
   deutscher Sommerzeit - eine Annahme, die hier bewusst steht, weil der Worker
   kein ICU hat. Seite und Home Assistant rechnen selbst um und schicken fertig,
   der Wert greift also nur bei einem Client, der es nicht tut. */
const TERMIN_VORGABE_UTC = '17:00:00';

/* Die Sternkategorien. Sie stehen HIER und nicht in der Datenbank: vier Zeilen
   Stammdaten waeren ein Join je Abruf, und unbekannte Schluessel weist die
   Route ohnehin ab. Die Beschriftung reist mit, damit die Seite sie nicht ein
   zweites Mal fuehren muss - zwei Fassungen laufen auseinander. */
const KATEGORIEN = {
  user: [
    ['kaltstellen',     'Kaltstellen'],
    ['auswahl',         'Auswahl'],
    ['gastfreundschaft', 'Gastfreundschaft'],
    ['verlaesslichkeit', 'Verlässlichkeit'],
  ],
  termin: [
    ['versorgung', 'Versorgung'],
    ['location',   'Location'],
    ['stimmung',   'Stimmung'],
    ['ausklang',   'Ausklang'],
  ],
};
const BEWERTSPERRE = 10;   // Sekunden zwischen zwei Bewertungen desselben Nutzers

/* Kommentare. Eine Antwortebene, mehr nicht - auf dem Handy ist bei Stufe drei
   die Spalte vierzig Pixel breit. Genau wie WhatsApp. */
const KOMMENTAR_MAX    = 400;  // Zeichen
const KOMMENTARE_TAG   = 30;   // je Nutzer und Tag
const KOMMENTARSPERRE  = 10;   // Sekunden zwischen zweien desselben Nutzers
const KOMMENTARE_ZIEL  = 200;  // je Ziel; aeltere fallen weg, sonst waechst es unbegrenzt
const REAKTIONEN = new Set(['daumen_hoch', 'daumen_runter', 'herz', 'bier']);

/* Fotos an Kommentaren. Verkleinert wird im BROWSER (lange Kante 1600 px,
   JPEG 0.8) - aus 4 MB Handyfoto werden ~250 kB. Damit faellt alles weg, was
   sonst teuer waere: keine Bildverarbeitung hier, kein Multipart, keine
   grossen Ruempfe. Der Deckel steht trotzdem, denn der Worker redet nicht nur
   mit unserem Browser. */
const BILD_MAX     = 2 * 1024 * 1024;  // Bytes
const BILDSPERRE   = 10;               // Sekunden zwischen zwei Uploads desselben Nutzers
const BILDER_TAG   = 30;               // je Nutzer und Tag, wie KOMMENTARE_TAG

/* Der Bierabend-Tag endet nicht um Mitternacht, sondern sechs Stunden spaeter
   (07:00 bzw. 08:00 Ortszeit) - sonst faellt die Drehung um kurz nach eins auf
   den naechsten Tag, obwohl sie zu demselben Abend gehoert. Bewusst in UTC
   gerechnet statt ueber eine Zeitzone: die Stunde Sommerzeit-Drift ist an
   dieser Grenze egal, eine ICU-Abhaengigkeit waere es nicht. */
const LOS_GRENZE = 6;
const bierTag = () => new Date(Date.now() - LOS_GRENZE * 3600e3).toISOString().slice(0, 10);

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
    // X-Tab ist die zufaellige Kennung des schreibenden Tabs, siehe `anstoss`.
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Tab';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const antwort = (request, daten, status = 200, extra = {}) =>
  new Response(JSON.stringify(daten), { status, headers: { ...koepfe(request), ...extra } });

const fehler = (request, text, status = 400) => antwort(request, { fehler: text }, status);

/* Den offenen Seiten sagen, dass sich etwas geaendert hat (siehe src/tafel.js).
   Steht in JEDER Schreibroute genau vor dem `return`, und zwar von Hand: eine
   Automatik im Router wuesste nicht, WELCHES Ziel betroffen ist, und
   'user:5' ist der halbe Nutzen.

   `waitUntil`, weil der Anstoss die Antwort nicht aufhalten darf - wer
   geschrieben hat, wartet nicht darauf, dass die anderen es erfahren. Und
   deshalb auch stumm im Fehlerfall: eine gescheiterte Meldung ist kein
   gescheiterter Schreibvorgang, die Seiten fassen spaetestens per Zeitgeber
   nach. */
function anstoss(request, env, ctx, ...marken) {
  if (!ctx || !env.TAFEL) return;
  const stub = env.TAFEL.get(env.TAFEL.idFromName('tafel'));
  const von = request.headers.get('X-Tab') || null;
  ctx.waitUntil(stub.melden(marken, von)
    .catch(e => console.error('anstoss:', e && e.stack || e)));
}

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
// Gluecksrad
// ---------------------------------------------------------------------------

/* Wer heute im Topf ist. Beide Aufrufer benutzen DIESE Abfrage - die
   Bestenliste zum Zeichnen des Rades, die Ziehung zum Ziehen. Zwei Fassungen
   derselben Regel liefen frueher oder spaeter auseinander, und dann zeigt das
   Rad ein Feld, aus dem gar nicht gezogen wurde. */
const losFeldStmt = env => env.DB.prepare(`
  SELECT u.id, u.name, u.quelle, r.biere
  FROM users u
  JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j ON j.user_id = u.id
  JOIN reports r ON r.id = j.id
  WHERE u.name IS NOT NULL
    AND r.biere >= ?
  ORDER BY r.biere DESC, u.name ASC
`).bind(LOS_MIN);

/* ALLE Lose eines Tages, nicht nur das geltende - seit der Zusage kann es je
   Tag mehrere geben. `abgelaufen` rechnet die Frist gleich mit aus, damit
   Lesen und Schreiben dieselbe Grenze benutzen: der Verfall wird nur beim
   Schreiben in die Datenbank eingetragen, gelten muss er sofort. */
const losTagStmt = (env, tag) => env.DB.prepare(`
  SELECT l.id, l.tag, l.user_id, l.biere, l.feld, l.gedreht_am,
         l.status, l.grund, l.entschieden_am,
         u.name AS gewinner, g.name AS von,
         (l.status = 'offen' AND l.gedreht_am < datetime('now', ?)) AS abgelaufen
  FROM los l
  JOIN users u ON u.id = l.user_id
  LEFT JOIN users g ON g.id = l.gedreht_von
  WHERE l.tag = ?
  ORDER BY l.id
`).bind(`-${LOS_FRIST} hours`, tag);

/* Der Verfall, festgeschrieben. Gehoert vor jede Schreibhandlung am Los und
   IN DENSELBEN batch: die Anweisungen laufen der Reihe nach in einer
   Transaktion, die Abfragen danach sehen das Ergebnis also schon. */
const verfallStmt = (env, tag) => env.DB.prepare(`
  UPDATE los SET status = 'verfallen', entschieden_am = datetime('now')
  WHERE tag = ? AND status = 'offen' AND gedreht_am < datetime('now', ?)
`).bind(tag, `-${LOS_FRIST} hours`);

/* Die Lage des Tages aus diesen Zeilen: was gilt, wer raus ist, wie gross der
   Topf mindestens sein muss. EINE Auswertung fuer Bestenliste, Ziehung und
   Antwort - zwei Fassungen derselben Regel liefen frueher oder spaeter
   auseinander, und dann zeigt die Seite etwas anderes an, als der Worker
   entscheidet. */
function tagesLage(zeilen) {
  // 'offen' und 'zugesagt' belegen den Tag - solange die Frist laeuft.
  const gueltig = zeilen.find(z =>
    z.status === 'zugesagt' || (z.status === 'offen' && !z.abgelaufen)) || null;
  /* Wer heute abgesagt hat oder nicht reagiert hat, wird nicht wieder gezogen.
     Ueberschneiden kann sich das nicht: was hier steht, ist nie `gueltig`. */
  const raus = zeilen.filter(z =>
    z.status === 'abgelehnt' || z.status === 'verfallen' || z.abgelaufen);
  return {
    gueltig, raus,
    rausIds: new Set(raus.map(z => z.user_id)),
    // Erstdrehung des Tages: zwei. Jede weitere: einer.
    mindest: zeilen.length ? LOS_MINDEST_WEITER : LOS_MINDEST,
  };
}

const gewicht = biere => Math.min(biere, LOS_DECKEL);

/* Gewichtet gezogen, aus echtem Zufall statt aus Math.random - es geht um die
   Frage, wer heute den Abend ausrichtet, da ist ein vorhersagbarer Generator
   die falsche Zutat. */
function ziehe(feld) {
  const summe = feld.reduce((a, p) => a + gewicht(p.biere), 0);
  const wurf = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * summe;
  let r = wurf;
  for (const p of feld) { r -= gewicht(p.biere); if (r < 0) return p; }
  return feld[feld.length - 1];
}

// Was die Seite braucht, um das Rad zu zeichnen - egal ob schon gedreht wurde.
const losSegmente = feld =>
  feld.map(p => ({ name: p.name, gewicht: gewicht(p.biere), gemessen: p.quelle === 'ha' }));

/* Wer heute noch gezogen werden kann. Bewusst hier in JS und nicht als
   Unterabfrage im SQL: der Verfall wird erst beim naechsten Schreiben
   eingetragen, steht beim Lesen also noch als 'offen' in der Tabelle. Eine
   SQL-Fassung wuerde ihn dort uebersehen und in der Bestenliste einen anderen
   Topf zeigen als bei der Ziehung. */
const losTopf = (feld, lage) => feld.filter(p => !lage.rausIds.has(p.id));

// Immer mit Z, wie bei den Meldungen: die Seite rechnet daraus eine Uhrzeit.
const utc = s => s ? s.replace(' ', 'T') + 'Z' : null;

// ---------------------------------------------------------------------------
// Termine
// ---------------------------------------------------------------------------

/* Der Client schickt ISO-8601 in UTC, die Datenbank schreibt
   'YYYY-MM-DD HH:MM:SS' - dieselbe Form wie `datetime('now')`. Nur so
   vergleicht SQLite Zeichenkette gegen Zeichenkette und bekommt das Richtige
   heraus. Sekundenbruchteile fliegen dabei raus, die interessiert hier keiner. */
const alsDbZeit = d => d.toISOString().slice(0, 19).replace('T', ' ');

/* Gibt den Datumswert zurueck oder einen fertigen Fehlertext - nie beides.
   Ohne Obergrenze traegt der erste Spassvogel den Bierabend ins Jahr 2200 ein,
   und die Liste der kommenden Termine ist erledigt. */
function pruefeBeginn(roh) {
  const d = new Date(String(roh || ''));
  if (isNaN(d)) return { fehler: 'Zeitpunkt: ISO-8601 in UTC, etwa 2026-08-02T17:00:00Z' };
  const jetzt = Date.now();
  if (d.getTime() > jetzt + TERMIN_VORAUS * 864e5) {
    return { fehler: `Höchstens ${TERMIN_VORAUS} Tage im Voraus` };
  }
  if (d.getTime() < jetzt - TERMIN_RUECK * 36e5) {
    return { fehler: 'Das liegt zu weit zurück — Termine trägt man vorher ein' };
  }
  return { d };
}

/* Kommende Termine plus ein Rueckblick: der letzte Abend soll noch dastehen,
   damit man ihn bewerten kann. Abgesagte bleiben in der Liste, sie tragen ihre
   Absage sichtbar - sonst verschwindet ein Abend, unter dem Kommentare stehen. */
const termineStmt = env => env.DB.prepare(`
  SELECT t.id, t.gastgeber_id, t.beginnt_am, t.titel, t.los_id, t.abgesagt_am,
         t.erstellt_von, u.name AS gastgeber, e.name AS eingetragen_von
  FROM termine t
  JOIN users u ON u.id = t.gastgeber_id
  LEFT JOIN users e ON e.id = t.erstellt_von
  WHERE t.beginnt_am > datetime('now', ?)
  ORDER BY t.beginnt_am
`).bind(`-${TERMINE_RUECKBLICK} days`);

/* `von` steht dabei, damit die Seite den Absagen-Knopf ohne Rueckfrage setzen
   kann: aendern darf Gastgeber ODER Eintragender, und die Seite soll nicht
   erst am 403 merken, dass sie ihn nicht haette zeigen duerfen. */
const terminAntwort = (t, noten, wieViele) => ({
  id: t.id,
  gastgeber: t.gastgeber,
  von: t.eingetragen_von || null,
  beginnt_am: utc(t.beginnt_am),
  titel: t.titel || null,
  aus_ziehung: !!t.los_id,
  abgesagt: !!t.abgesagt_am,
  /* Nur wo die Schnitte mitgerechnet wurden - die Termin-Routen selbst
     schicken die Liste ohne, dort interessiert sie niemanden.
     Auf `instanceof Map` geprueft und nicht bloss auf Wahrheit: ein
     `results.map(terminAntwort)` reicht den INDEX als zweites Argument
     durch, und eine Zahl haette hier klaglos `noten.get` gerufen. Genau
     das ist einmal passiert (500er auf /api/termin, 2026-08-02). */
  ...(noten instanceof Map ? {
    bewertung: schnittAntwort(noten.get('termin:' + t.id)),
    kommentare: (wieViele instanceof Map && wieViele.get('termin:' + t.id)) || 0,
  } : {}),
});

/* Eine Form fuer alle Antworten rund um das Los: die Seite muss nicht mehrere
   Faelle unterscheiden. `gewinner === null` heisst "heute ist gerade nichts
   gezogen" - entweder noch gar nicht, oder das letzte Los ist abgelehnt bzw.
   verfallen. In beiden Faellen traegt `feld` den aktuellen Topf statt des
   eingefrorenen, und `zuletzt` sagt, warum wieder gedreht werden darf. */
function losAntwort(tag, lage, topf, termine = []) {
  const z = lage.gueltig;
  const gemeinsam = {
    tag,
    mindestens: lage.mindest,
    // Wer heute schon raus ist - fuer "Raus fuer heute: ..." unter dem Rad.
    abgesagt: lage.raus.map(r => r.gewinner),
    /* Die letzte Absage bzw. der letzte Verfall des Tages - die Seite braucht
       sie fuer den Satz, warum wieder gedreht werden darf. Steht ein gueltiges
       Los daneben, ist sie ueberholt; die Seite liest sie dann auch nicht. */
    zuletzt: lage.raus.length ? (r => ({
      name: r.gewinner,
      status: r.abgelaufen && r.status === 'offen' ? 'verfallen' : r.status,
      grund: r.grund || null,
    }))(lage.raus[lage.raus.length - 1]) : null,
  };

  if (!z) {
    const genug = topf.length >= lage.mindest;
    return {
      ...gemeinsam, gewinner: null, status: null, feld: losSegmente(topf),
      // `offen` heisst seit jeher "es kann gedreht werden"; `darf_drehen` ist
      // derselbe Wert unter dem Namen, der ihn erklaert.
      offen: genug, darf_drehen: genug,
    };
  }

  // Der Abend, den die Zusage angelegt hat. Die Seite schreibt daraus die
  // Uhrzeit hinter den Namen: "Maike hat zugesagt - 19 Uhr".
  const t = termine.find(x => x.los_id === z.id) || null;

  return {
    ...gemeinsam,
    gewinner: z.gewinner,
    biere: z.biere,
    feld: JSON.parse(z.feld),
    von: z.von,
    gedreht: utc(z.gedreht_am),
    termin_id: t ? t.id : null,
    beginnt_am: t ? utc(t.beginnt_am) : null,
    status: z.status,                       // 'offen' oder 'zugesagt'
    grund: z.grund || null,
    entschieden: utc(z.entschieden_am),
    // Bis wann der Gewinner antworten kann. NULL, sobald er es getan hat.
    frist: z.status === 'offen'
      ? new Date(new Date(utc(z.gedreht_am)).getTime() + LOS_FRIST * 3600e3).toISOString()
      : null,
    offen: false, darf_drehen: false,
  };
}

// ---------------------------------------------------------------------------
// Bewertungen
// ---------------------------------------------------------------------------

/* Ein Ziel kommt als "art:id" ueber die Leitung - eine Zeichenkette statt
   zweier Felder, weil sie so auch als Schluessel einer Map taugt und in einem
   Query-Parameter steht. */
function zielAus(roh) {
  const [art, id] = String(roh || '').split(':');
  if (!KATEGORIEN[art]) return null;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? { art, id: n } : null;
}

/* Prueft und normalisiert die Sterne. Nicht bewertete Kategorien stehen
   danach als `null` drin - so ist an der Zeile ablesbar, dass sie bewusst
   leer sind, und `avg()` uebergeht sie von selbst. */
function pruefeSterne(art, roh) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    return { fehler: 'sterne: ein Objekt mit den Kategorien' };
  }
  const erlaubt = new Set(KATEGORIEN[art].map(k => k[0]));
  for (const k of Object.keys(roh)) {
    if (!erlaubt.has(k)) return { fehler: `Unbekannte Kategorie: ${k}` };
  }
  const sterne = {};
  let gesetzt = 0;
  for (const [k] of KATEGORIEN[art]) {
    const v = roh[k];
    if (v === null || v === undefined || v === '') { sterne[k] = null; continue; }
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      return { fehler: `${k}: 1 bis 5 Sterne oder nichts` };
    }
    sterne[k] = v; gesetzt++;
  }
  // Eine Bewertung ganz ohne Stern ist keine - dafuer gibt es das Loeschen.
  if (!gesetzt) return { fehler: 'Mindestens eine Kategorie bewerten' };
  return { sterne };
}

/* Die Schnitte. Bewusst in JS statt als SQL-Aggregat: der Ausdruck haette die
   Kategorienamen ein zweites Mal enthalten, und dann stehen sie an zwei
   Stellen. Die Zeilenzahl ist die einer Kneipenrunde, nicht die eines
   Rechenzentrums - das Sortieren kostet hier nichts. */
function schnitte(zeilen) {
  const m = new Map();
  for (const z of zeilen) {
    const k = z.ziel_art + ':' + z.ziel_id;
    let e = m.get(k);
    if (!e) m.set(k, e = { summe: 0, zahl: 0, anzahl: 0, je: new Map() });
    e.anzahl++;
    let s;
    try { s = JSON.parse(z.sterne); } catch { continue; }
    for (const [feld, wert] of Object.entries(s)) {
      if (!Number.isFinite(wert)) continue;
      e.summe += wert; e.zahl++;
      const j = e.je.get(feld) || { summe: 0, zahl: 0 };
      j.summe += wert; j.zahl++;
      e.je.set(feld, j);
    }
  }
  return m;
}

// Eine Kommastelle reicht: "4,2" liest sich, "4,1666" nicht.
const note = (summe, zahl) => zahl ? Math.round(summe / zahl * 10) / 10 : null;

const schnittAntwort = e =>
  e ? { schnitt: note(e.summe, e.zahl), anzahl: e.anzahl } : { schnitt: null, anzahl: 0 };

/* Nur, was auf der Seite auch gezeigt wird: alle Nutzer und die Termine im
   Rueckblickfenster. Sonst waechst die Abfrage mit jedem je bewerteten Abend. */
const bewertungenStmt = env => env.DB.prepare(`
  SELECT ziel_art, ziel_id, sterne FROM bewertungen
  WHERE ziel_art = 'user'
     OR ziel_id IN (SELECT id FROM termine WHERE beginnt_am > datetime('now', ?))
`).bind(`-${TERMINE_RUECKBLICK} days`);

// ---------------------------------------------------------------------------
// Kommentare
// ---------------------------------------------------------------------------

/* Der Typ kommt aus den ERSTEN BYTES, nicht aus dem Content-Type: den setzt
   der Absender, und wer eine Datei ablegen will, die kein Bild ist, setzt ihn
   passend. Gibt den Mime-Typ und die Endung zurueck, oder null. */
function bildTyp(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return ['image/jpeg', 'jpg'];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return ['image/png', 'png'];
  // RIFF....WEBP - die vier Bytes dazwischen sind die Laenge.
  const wort = i => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (wort(0) === 'RIFF' && wort(8) === 'WEBP') return ['image/webp', 'webp'];
  return null;
}

/* Was aus dem Upload zurueckkommt und beim Abschicken wieder hereinkommt.
   Streng geprueft, weil der Wert ungeprueft in einen R2-Aufruf ginge. */
const BILD_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/* Aus dem Schluessel wird erst hier eine Adresse. Steht BILDER_URL nicht (der
   Bucket ist noch nicht oeffentlich geschaltet), gibt es lieber gar kein Bild
   als eine Adresse, hinter der nichts liegt. */
const bildUrl = (env, key) =>
  key && env.BILDER_URL ? `${env.BILDER_URL.replace(/\/+$/, '')}/${key}` : null;

/* Das `bild`-Feld der beiden Schreibrouten. Beide pruefen dasselbe, deshalb
   steht es einmal hier. Dass der Schluessel wirklich im Bucket liegt, wird
   nachgesehen - sonst haengt an der Zeile eine Adresse ins Leere, und das
   faellt erst dem Leser auf. Gibt { key } oder { fehler, status } zurueck. */
async function pruefeBild(env, roh) {
  if (roh == null || roh === '') return { key: null };
  const key = String(roh);
  if (!BILD_KEY.test(key)) return { fehler: 'Das ist kein Bildschlüssel', status: 400 };
  if (!env.BILDER) return { fehler: 'Bilder sind nicht eingerichtet', status: 503 };
  const da = await env.BILDER.head(key);
  if (!da) return { fehler: 'Das Bild gibt es nicht (mehr)', status: 404 };
  return { key };
}

/* Dass das Ziel existiert, prueft der Worker - einen Fremdschluessel kann es
   auf ein polymorphes Paar nicht geben. Gibt den Fehlertext zurueck oder null. */
async function zielFehlt(env, ziel) {
  if (ziel.art === 'user') {
    const u = await env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND name IS NOT NULL')
      .bind(ziel.id).first();
    return u ? null : 'Den gibt es nicht';
  }
  const t = await env.DB.prepare('SELECT 1 FROM termine WHERE id = ?').bind(ziel.id).first();
  return t ? null : 'Den Termin gibt es nicht';
}

/* Der Baum, fertig zusammengesteckt. Drei Abfragen in einem batch, weil eine
   verschachtelte SQL-Fassung dieselbe Arbeit in einer schlechter lesbaren Form
   taete: Kommentare, die Reaktionen gezaehlt, und die eigenen davon. */
const baumStmts = (env, ziel, ichId) => [
  /* `k.sterne` ist der Schnappschuss aus dem Moment des Absendens, kein Join
     auf `bewertungen` - die Zeile dort wird ueberschrieben, die Karte hier
     soll stehen bleiben (siehe 0009_sterne_am_kommentar.sql). */
  env.DB.prepare(`
    SELECT k.id, k.autor_id, k.antwort_auf, k.text, k.erstellt, k.geaendert,
           k.geloescht_am, k.bild_key, k.sterne, u.name AS autor
    FROM kommentare k
    JOIN users u ON u.id = k.autor_id
    WHERE k.ziel_art = ? AND k.ziel_id = ?
    ORDER BY k.id DESC
    LIMIT ?
  `).bind(ziel.art, ziel.id, KOMMENTARE_ZIEL),
  env.DB.prepare(`
    SELECT r.kommentar_id, r.art, count(*) AS anzahl
    FROM reaktionen r
    JOIN kommentare k ON k.id = r.kommentar_id
    WHERE k.ziel_art = ? AND k.ziel_id = ?
    GROUP BY r.kommentar_id, r.art
  `).bind(ziel.art, ziel.id),
  env.DB.prepare(`
    SELECT r.kommentar_id, r.art
    FROM reaktionen r
    JOIN kommentare k ON k.id = r.kommentar_id
    WHERE k.ziel_art = ? AND k.ziel_id = ? AND r.autor_id = ?
  `).bind(ziel.art, ziel.id, ichId),
];

function baumBauen(zeilen, reaktionen, eigene, ichId, env) {
  const meine = new Set(eigene.map(r => r.kommentar_id + ':' + r.art));
  const proKommentar = new Map();
  for (const r of reaktionen) {
    if (!proKommentar.has(r.kommentar_id)) proKommentar.set(r.kommentar_id, []);
    proKommentar.get(r.kommentar_id).push({
      art: r.art, anzahl: r.anzahl, meins: meine.has(r.kommentar_id + ':' + r.art),
    });
  }

  const karte = z => {
    const weg = !!z.geloescht_am;
    let sterne = null;
    if (z.sterne) { try { sterne = JSON.parse(z.sterne); } catch { sterne = null; } }
    return {
      id: z.id,
      autor: z.autor,
      // Der Text eines geloeschten Kommentars verlaesst den Worker nicht.
      text: weg ? null : z.text,
      // Dasselbe fuer das Foto - und im Bucket liegt es dann auch nicht mehr,
      // darum kuemmert sich POST /api/kommentar/aendern.
      bild: weg ? null : bildUrl(env, z.bild_key),
      geloescht: weg,
      erstellt: utc(z.erstellt),
      geaendert: utc(z.geaendert),
      meins: z.autor_id === ichId,
      sterne: weg ? null : sterne,
      reaktionen: proKommentar.get(z.id) || [],
      antworten: [],
    };
  };

  /* Aelteste zuerst: gelesen wird ein Thread von oben nach unten. Abgefragt
     wurde absteigend, damit bei mehr als 200 die JUENGSTEN uebrig bleiben. */
  const nachAlter = [...zeilen].reverse();
  const wurzeln = [], nachId = new Map();
  for (const z of nachAlter) {
    if (z.antwort_auf) continue;
    const k = karte(z);
    nachId.set(z.id, k);
    wurzeln.push(k);
  }
  for (const z of nachAlter) {
    if (!z.antwort_auf) continue;
    const w = nachId.get(z.antwort_auf);
    // Haengt die Wurzel jenseits der 200er-Grenze, faellt die Antwort mit weg.
    if (w) w.antworten.push(karte(z));
  }
  return wurzeln;
}

/* Die Grenzen fuer eine NEUE Kommentarzeile. Sie stehen hier und nicht in der
   Route, weil es zwei Wege zu einer solchen Zeile gibt: /api/kommentar und der
   Text neben den Sternen an /api/bewerten. Haengen die Grenzen nur am ersten,
   ist der zweite der Weg an ihnen vorbei - und der ist nicht theoretisch, das
   UPSERT dort darf beliebig oft laufen und legt jedes Mal einen neuen
   Kommentar an. Gibt { fehler, status } zurueck oder null. */
async function kommentarGrenze(env, ichId) {
  const [sperre, heute] = await env.DB.batch([
    env.DB.prepare("SELECT 1 FROM kommentare WHERE autor_id = ? AND erstellt > datetime('now', ?) LIMIT 1")
      .bind(ichId, `-${KOMMENTARSPERRE} seconds`),
    env.DB.prepare("SELECT count(*) AS n FROM kommentare WHERE autor_id = ? AND erstellt > datetime('now','-1 day')")
      .bind(ichId),
  ]);
  if (sperre.results.length) return { fehler: 'Zu schnell — kurz durchatmen', status: 429 };
  if (heute.results[0].n >= KOMMENTARE_TAG) {
    return { fehler: `Höchstens ${KOMMENTARE_TAG} Kommentare am Tag`, status: 429 };
  }
  return null;
}

/* Wie viele Kommentare an welchem Ziel haengen - fuer die Zaehler in der
   Liste, damit ein "4,2 · 3" ohne den Detailabruf gezeichnet werden kann. */
const kommentarZaehlerStmt = env => env.DB.prepare(`
  SELECT ziel_art, ziel_id, count(*) AS anzahl FROM kommentare
  WHERE geloescht_am IS NULL
    AND (ziel_art = 'user'
         OR ziel_id IN (SELECT id FROM termine WHERE beginnt_am > datetime('now', ?)))
  GROUP BY ziel_art, ziel_id
`).bind(`-${TERMINE_RUECKBLICK} days`);

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
    /* Der Bucket allein reicht nicht: ohne oeffentliche Adresse kaeme jedes
       hochgeladene Bild als `bild: null` heraus, und das saehe von aussen wie
       ein Fehler im Browser aus. Hier steht, woran es liegt. */
    const bilder = !env.BILDER ? 'nicht eingerichtet'
      : !env.BILDER_URL ? 'Bucket da, aber BILDER_URL fehlt'
      : 'ok';

    return antwort(request, {
      ok: true, dienst: 'beerstock-api', db, bilder,
      mail: env.AGENTMAIL_KEY ? 'Schluessel liegt an' : 'KEIN SCHLUESSEL',
      inbox: env.AGENTMAIL_INBOX || null,
      tafel: env.TAFEL ? 'ok' : 'nicht eingerichtet',
    });
  },

  // -------------------------------------------------------------------------
  /* Die Leitung, ueber die sich die Seite von selbst erfaehrt, dass etwas
     passiert ist. Kein Token noetig: es reisen nur Marken, keine Daten (siehe
     src/tafel.js), und der eigentliche Abruf dahinter prueft wie immer.

     Der Origin wird hier von Hand geprueft. Ein WebSocket-Handshake
     unterliegt KEINEM CORS - der Browser fragt nicht vorher, er verbindet.
     Der Kopf `koepfe()` traegt hier also nichts bei, die Pruefung schon. */
  'GET /api/strom': async (request, env) => {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return fehler(request, 'Diese Route spricht nur WebSocket', 426);
    }
    const herkunft = request.headers.get('Origin');
    if (herkunft && !ERLAUBTE_HERKUNFT.has(herkunft)) {
      return fehler(request, 'Nicht von hier', 403);
    }
    if (!env.TAFEL) return fehler(request, 'Verteiler nicht eingerichtet', 503);

    return env.TAFEL.get(env.TAFEL.idFromName('tafel')).fetch(request);
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
  'POST /api/name': async (request, env, ctx) => {
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
    // Der Name steht in der Liste - ein Namenloser, der sich benennt, ist fuer
    // die anderen eine neue Zeile.
    anstoss(request, env, ctx, 'tafel');
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
  'POST /api/report': async (request, env, ctx) => {
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

    /* Auch die Meldung aus Home Assistant landet hier - die schickt kein
       X-Tab, ihr Anstoss geht also an wirklich alle. Genau richtig: dort sitzt
       niemand vor der Seite, der die Antwort schon gesehen haette. */
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, { ok: true, name: ich.name, biere, rang: rang.rang }, 201);
  },

  // -------------------------------------------------------------------------
  /* Das Rad drehen. Braucht ein Token: wer nicht mitspielt, soll den Tag nicht
     verbrauchen - und "gedreht von Basti" ist die Zeile, die aus der Ziehung
     eine Handlung macht. Ein zweiter Aufruf am selben Tag ist kein Fehler, er
     bekommt schlicht dasselbe Ergebnis mit `schon: true`. */
  'POST /api/drehen': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const tag = bierTag();
    /* Der Verfallslauf laeuft VOR dem Lesen und im selben batch: wer seit drei
       Stunden nicht geantwortet hat, gibt den Tag hier frei - und die beiden
       Abfragen dahinter sehen das bereits. */
    const [verfallen, tagRoh, feld, termine] = await env.DB.batch([
      verfallStmt(env, tag), losTagStmt(env, tag), losFeldStmt(env), termineStmt(env),
    ]);
    const lage = tagesLage(tagRoh.results);
    const topf = losTopf(feld.results, lage);

    // Es gilt schon eines? Dann gilt das, egal wer fragt.
    if (lage.gueltig) {
      /* Hier hat zwar niemand gezogen, aber der Verfallslauf oben kann etwas
         umgeschrieben haben - dann steht bei den anderen noch ein Los, das es
         nicht mehr gibt. Ohne diese Aenderung schweigt die Leitung. */
      if (verfallen.meta.changes) anstoss(request, env, ctx, 'tafel');
      return antwort(request,
        { ...losAntwort(tag, lage, topf, termine.results), schon: true });
    }
    if (topf.length < lage.mindest) {
      return fehler(request, lage.raus.length
        ? 'Heute hat abgesagt, wer da war.'
        : `Zu wenig gemeldet — das Rad braucht mindestens ${lage.mindest}, ` +
          'die heute etwas Kaltes haben.', 409);
    }

    const gewinner = ziehe(topf);
    /* Das Rennen zweier gleichzeitiger Dreher entscheidet der partielle
       Unique-Index `los_gueltig`: wer nicht geschrieben hat, liest gleich
       darauf das fremde Ergebnis und zeigt es an. Kein Sperren, keine
       Transaktion ueber zwei Anfragen. Die WHERE-Klausel muss wortwoertlich
       der Index-Bedingung entsprechen, sonst findet SQLite den Index nicht. */
    const gesetzt = await env.DB.prepare(`
      INSERT INTO los (tag, user_id, biere, feld, gedreht_von) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tag) WHERE status IN ('offen','zugesagt') DO NOTHING
    `).bind(tag, gewinner.id, gewinner.biere,
            JSON.stringify(losSegmente(topf)), ich.id).run();

    const [tagRoh2, feld2, termine2] = await env.DB.batch([
      losTagStmt(env, tag), losFeldStmt(env), termineStmt(env),
    ]);
    const lage2 = tagesLage(tagRoh2.results);
    const selbst = gesetzt.meta.changes === 1;
    /* Der Anstoss geht auch dann raus, wenn ein anderer schneller war: dessen
       Ziehung kennen die uebrigen Seiten ja auch noch nicht, wenn sein eigener
       Anstoss unterwegs verlorenging. Zweimal dieselbe Marke kostet die
       Empfaenger nichts - sie laden und vergleichen. */
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, {
      ...losAntwort(tag, lage2, losTopf(feld2.results, lage2), termine2.results),
      schon: !selbst,
    }, selbst ? 201 : 200);
  },

  // -------------------------------------------------------------------------
  /* Zusagen oder absagen. Darf nur der Gezogene selbst, und nur solange sein
     Los offen ist - eine Zusage nimmt man nicht zurueck, indem man die Route
     zweimal ruft. Eine Absage gibt den Tag sofort wieder frei; der Absager
     bleibt danach draussen, sonst zieht ihn dieselbe Flasche gleich noch
     einmal. */
  'POST /api/los/antwort': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const ja = daten.antwort === 'ja';
    if (!ja && daten.antwort !== 'nein') return fehler(request, "antwort: 'ja' oder 'nein'");

    let grund = String(daten.grund ?? '').trim().replace(/\s+/g, ' ');
    if (grund.length > GRUND_MAX) {
      return fehler(request, `Der Grund darf höchstens ${GRUND_MAX} Zeichen haben`);
    }
    if (ja) grund = null;            // ein Grund gehoert zur Absage, nicht zur Zusage

    /* Die Uhrzeit des Abends kommt vom Client, fertig in UTC gerechnet - der
       Browser kennt die Ortszeit, der Worker nicht. Fehlt sie, greift die
       Vorgabe auf dem Bierabend-Tag selbst; deshalb hier nur die Pruefung und
       das Einsetzen erst weiter unten, wenn `tag` feststeht. */
    let beginn = null;
    if (ja && daten.beginnt_am != null) {
      const p = pruefeBeginn(daten.beginnt_am);
      if (p.fehler) return fehler(request, p.fehler);
      beginn = alsDbZeit(p.d);
    }

    const tag = bierTag();
    const [, tagRoh] = await env.DB.batch([verfallStmt(env, tag), losTagStmt(env, tag)]);
    const lage = tagesLage(tagRoh.results);
    const z = lage.gueltig;

    if (!z) return fehler(request, 'Heute ist gerade nichts zu entscheiden.', 409);
    if (z.user_id !== ich.id) {
      return fehler(request, 'Antworten darf nur, wen die Flasche getroffen hat.', 403);
    }
    if (z.status !== 'offen') return fehler(request, 'Das steht schon fest.', 409);

    /* `changes === 1` gewinnt, wie beim Einloesen des Magic Links: zwei
       gleichzeitige Antworten (Handy und Laptop) duerfen nicht beide gelten. */
    const gesetzt = await env.DB.prepare(`
      UPDATE los SET status = ?, entschieden_am = datetime('now'), grund = ?
      WHERE id = ? AND status = 'offen'
    `).bind(ja ? 'zugesagt' : 'abgelehnt', grund || null, z.id).run();
    if (gesetzt.meta.changes !== 1) return fehler(request, 'Das steht schon fest.', 409);

    /* Erst die Zusage macht aus der Ziehung einen Abend - deshalb entsteht der
       Termin hier und nicht schon beim Drehen. Getrennt vom UPDATE, weil dessen
       `changes === 1` die Entscheidung traegt; gegen einen doppelten Termin aus
       einem wiederholten Ruf steht `termine.los_id UNIQUE`. */
    if (ja) {
      await env.DB.prepare(`
        INSERT INTO termine (gastgeber_id, beginnt_am, los_id, erstellt_von)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(los_id) DO NOTHING
      `).bind(ich.id, beginn || `${tag} ${TERMIN_VORGABE_UTC}`, z.id, ich.id).run();
    }

    const [tagRoh2, feld, termine] = await env.DB.batch([
      losTagStmt(env, tag), losFeldStmt(env), termineStmt(env),
    ]);
    const lage2 = tagesLage(tagRoh2.results);
    // Zusage wie Absage aendern Rad, Liste und Termine auf einen Schlag.
    anstoss(request, env, ctx, 'tafel');
    /* Die Terminliste faehrt mit: sonst muesste die Seite gleich darauf die
       Bestenliste nachladen, nur damit der eben angelegte Abend dasteht. */
    return antwort(request, {
      ...losAntwort(tag, lage2, losTopf(feld.results, lage2), termine.results),
      termine: termine.results.map(t => terminAntwort(t)),
    });
  },

  // -------------------------------------------------------------------------
  /* Einen Abend von Hand eintragen. Jeder Angemeldete darf jeden als Gastgeber
     eintragen - eine Bestaetigung durch den Gastgeber waere mehr Mechanik, als
     eine Runde braucht, die sich kennt. Wer sich vertut, aendert es wieder. */
  'POST /api/termin': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const p = pruefeBeginn(daten.beginnt_am);
    if (p.fehler) return fehler(request, p.fehler);

    const titel = String(daten.titel ?? '').trim().replace(/\s+/g, ' ');
    if (titel.length > TERMIN_TITEL_MAX) {
      return fehler(request, `Der Titel darf höchstens ${TERMIN_TITEL_MAX} Zeichen haben`);
    }

    // Der Gastgeber kommt als Name aus der Liste - Ids stehen nirgends auf der Seite.
    const wer = String(daten.gastgeber ?? '').trim().toLowerCase();
    const gast = wer
      ? await env.DB.prepare('SELECT id, name FROM users WHERE name_klein = ?').bind(wer).first()
      : null;
    if (!gast) return fehler(request, 'Den Gastgeber gibt es nicht');

    /* Wie die Meldesperre: gegen den Freund, der zehnmal drueckt. Gezaehlt wird
       am Eintragenden, nicht am Gastgeber - sonst sperrt einer den anderen. */
    const schon = await env.DB.prepare(`
      SELECT count(*) AS n FROM termine
      WHERE erstellt_von = ? AND erstellt > datetime('now','-1 day')
    `).bind(ich.id).first();
    if (schon.n >= TERMINE_PRO_TAG) {
      return fehler(request, `Höchstens ${TERMINE_PRO_TAG} Termine am Tag`, 429);
    }

    const neu = await env.DB.prepare(`
      INSERT INTO termine (gastgeber_id, beginnt_am, titel, erstellt_von)
      VALUES (?, ?, ?, ?) RETURNING id
    `).bind(gast.id, alsDbZeit(p.d), titel || null, ich.id).first();

    const alle = await termineStmt(env).all();
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true, id: neu.id, gastgeber: gast.name,
      termine: alle.results.map(t => terminAntwort(t)),
    }, 201);
  },

  // -------------------------------------------------------------------------
  /* Verschieben, umbenennen, absagen. Nur Gastgeber oder Eintragender, und nur
     BEVOR der Abend angefangen hat - was gelaufen ist, bleibt stehen, sonst
     verschiebt jemand nachtraeglich den Abend, den die anderen schon bewertet
     haben. */
  'POST /api/termin/aendern': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const t = await env.DB.prepare(`
      SELECT id, gastgeber_id, erstellt_von, los_id, beginnt_am, abgesagt_am,
             (beginnt_am <= datetime('now')) AS laeuft
      FROM termine WHERE id = ?
    `).bind(Number(daten.id)).first();
    if (!t) return fehler(request, 'Den Termin gibt es nicht', 404);
    if (t.gastgeber_id !== ich.id && t.erstellt_von !== ich.id) {
      return fehler(request, 'Ändern darf nur der Gastgeber oder wer ihn eingetragen hat', 403);
    }
    if (t.laeuft) return fehler(request, 'Der Abend hat schon angefangen', 409);
    if (t.abgesagt_am) return fehler(request, 'Der Termin ist schon abgesagt', 409);

    if (daten.absagen) {
      /* Haengt der Termin an einer Ziehung, faellt mit ihm auch die Zusage -
         sonst belegt ein abgesagter Abend den Tag weiter, und die Flasche
         bleibt liegen. Der Absagende ist damit fuer heute raus, genau wie bei
         einer Absage am Rad. */
      const schritte = [
        env.DB.prepare("UPDATE termine SET abgesagt_am = datetime('now') WHERE id = ? AND abgesagt_am IS NULL")
          .bind(t.id),
      ];
      if (t.los_id) {
        schritte.push(env.DB.prepare(`
          UPDATE los SET status = 'abgelehnt', entschieden_am = datetime('now')
          WHERE id = ? AND status = 'zugesagt'
        `).bind(t.los_id));
      }
      await env.DB.batch(schritte);
      const alle = await termineStmt(env).all();
      anstoss(request, env, ctx, 'tafel');
      return antwort(request, {
        ok: true, abgesagt: true,
        // Hing eine Zusage daran, ist der Tag jetzt wieder frei - die Seite
        // muss also auch das Rad neu zeichnen und holt sich alles.
        los_frei: !!t.los_id,
        termine: alle.results.map(t => terminAntwort(t)),
      });
    }

    const setzt = [], werte = [];
    if (daten.beginnt_am != null) {
      const p = pruefeBeginn(daten.beginnt_am);
      if (p.fehler) return fehler(request, p.fehler);
      setzt.push('beginnt_am = ?'); werte.push(alsDbZeit(p.d));
    }
    if (daten.titel != null) {
      const titel = String(daten.titel).trim().replace(/\s+/g, ' ');
      if (titel.length > TERMIN_TITEL_MAX) {
        return fehler(request, `Der Titel darf höchstens ${TERMIN_TITEL_MAX} Zeichen haben`);
      }
      setzt.push('titel = ?'); werte.push(titel || null);
    }
    if (!setzt.length) return fehler(request, 'Nichts zu ändern');

    await env.DB.prepare(`UPDATE termine SET ${setzt.join(', ')} WHERE id = ?`)
      .bind(...werte, t.id).run();
    const alle = await termineStmt(env).all();
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, { ok: true, termine: alle.results.map(t => terminAntwort(t)) });
  },

  // -------------------------------------------------------------------------
  /* Sterne setzen oder ueberschreiben. Ein UPSERT, keine zweite Zeile: eine
     Bewertung je Autor und Ziel, sonst waere der Schnitt eine Frage des
     Fleisses. Sich selbst bewerten geht nicht - das ist die einzige Regel, die
     hier ueberhaupt noetig ist, der Name steht ja dran. */
  'POST /api/bewerten': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const ziel = zielAus(`${daten.ziel_art}:${daten.ziel_id}`);
    if (!ziel) return fehler(request, "ziel_art: 'user' oder 'termin', ziel_id: eine Zahl");

    const s = pruefeSterne(ziel.art, daten.sterne);
    if (s.fehler) return fehler(request, s.fehler);

    /* Auch hier, nicht nur an der Kommentarroute: der Fall "5 Sterne, ein Satz
       und ein Foto vom Kühlschrank" kommt als EINE Anfrage genau hier an - die
       Seite schickt einen Wurzelkommentar mit Sternen ueber diese Route. Hinge
       das Feld nur am Kommentar, waere ausgerechnet der Fall der eine, der
       nicht geht. Vor dem UPSERT geprueft, damit ein falscher Schluessel nicht
       die Sterne schon geschrieben hat. */
    const bi = await pruefeBild(env, daten.bild);
    if (bi.fehler) return fehler(request, bi.fehler, bi.status);

    if (ziel.art === 'user') {
      if (ziel.id === ich.id) return fehler(request, 'Sich selbst bewerten gilt nicht', 403);
      const wer = await env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND name IS NOT NULL')
        .bind(ziel.id).first();
      if (!wer) return fehler(request, 'Den gibt es nicht', 404);
    } else {
      /* Ein Abend wird bewertet, nachdem er stattgefunden hat. Vorher waere es
         eine Erwartung, keine Bewertung - und ein abgesagter Abend hat gar
         nicht stattgefunden. */
      const t = await env.DB.prepare(`
        SELECT abgesagt_am, (beginnt_am <= datetime('now')) AS gewesen
        FROM termine WHERE id = ?
      `).bind(ziel.id).first();
      if (!t) return fehler(request, 'Den Termin gibt es nicht', 404);
      if (t.abgesagt_am) return fehler(request, 'Der Abend ist abgesagt worden', 409);
      if (!t.gewesen) return fehler(request, 'Der Abend hat noch nicht angefangen', 409);
    }

    // Wie die Meldesperre: gegen den, der zehnmal drueckt, weil nichts blinkt.
    const letzte = await env.DB.prepare(`
      SELECT 1 FROM bewertungen
      WHERE autor_id = ? AND coalesce(geaendert, erstellt) > datetime('now', ?) LIMIT 1
    `).bind(ich.id, `-${BEWERTSPERRE} seconds`).first();
    if (letzte) return fehler(request, 'Zu schnell — kurz durchatmen', 429);

    /* Steht ein Text oder ein Foto daneben, entsteht gleich ein Kommentar -
       und dann gelten dessen Grenzen, dieselben wie an /api/kommentar. Alles
       davon VOR dem UPSERT: ein abgewiesener Kommentar darf die Sterne nicht
       schon geschrieben haben. Genau das war hier der Fall, die Laengenpruefung
       stand hinter dem Schreiben. */
    const text = String(daten.text ?? '').trim();
    if (text || bi.key) {
      if (text.length > KOMMENTAR_MAX) {
        return fehler(request, `Der Kommentar darf höchstens ${KOMMENTAR_MAX} Zeichen haben`);
      }
      const grenze = await kommentarGrenze(env, ich.id);
      if (grenze) return fehler(request, grenze.fehler, grenze.status);
    }

    const b = await env.DB.prepare(`
      INSERT INTO bewertungen (autor_id, ziel_art, ziel_id, sterne) VALUES (?, ?, ?, ?)
      ON CONFLICT(autor_id, ziel_art, ziel_id)
        DO UPDATE SET sterne = excluded.sterne, geaendert = datetime('now')
      RETURNING id
    `).bind(ich.id, ziel.art, ziel.id, JSON.stringify(s.sterne)).first();

    /* Ein Text daneben wird ein eigener Wurzelkommentar, verbunden ueber
       `bewertung_id`. Zwei Zeilen, weil ein Kommentar eine eigene Adresse
       braucht, sobald Antworten und Reaktionen daran haengen - und weil eine
       geaenderte Note ihn sonst mitreissen wuerde.

       Die Sterne reisen als SCHNAPPSCHUSS mit in die Zeile. Ueber
       `bewertung_id` nachzusehen waere bequemer und falsch: dort steht dann
       laengst die naechste Note, und die Karte truege eine, die zu ihrem Text
       nie gehoert hat. */
    if (text || bi.key) {
      await env.DB.prepare(`
        INSERT INTO kommentare (ziel_art, ziel_id, autor_id, bewertung_id, text, bild_key, sterne)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(ziel.art, ziel.id, ich.id, b.id, text, bi.key, JSON.stringify(s.sterne)).run();
    }

    /* Zwei Marken: der Schnitt steht auch in der Liste bzw. am Termin, der
       Thread selbst ist das Ziel. Wer beides offen hat, laedt beides. */
    anstoss(request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
    return antwort(request, { ok: true, sterne: s.sterne });
  },

  // -------------------------------------------------------------------------
  /* Ein Foto ablegen. ROHE BYTES im Rumpf, kein JSON und kein Multipart - die
     Seite verkleinert vorher selbst, es geht also nur ein fertiges Bild ueber
     die Leitung und `json(request)` wird hier nicht gebraucht.

     Zurueck kommt nur der Schluessel. Erst das Abschicken des Kommentars
     verbindet ihn mit einer Zeile; wer hochlaedt und es sich dann anders
     ueberlegt, hinterlaesst ein Objekt ohne Kommentar - siehe die Anmerkung in
     `0008_bilder.sql`, warum dafuer kein Cron laeuft. */
  'POST /api/bild': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);
    if (!env.BILDER) return fehler(request, 'Bilder sind nicht eingerichtet', 503);

    /* Zweimal messen: der Kopf spart das Lesen bei einem ehrlichen Absender,
       gelogen ist er aber schnell - der zweite Blick gilt den Bytes selbst. */
    const angesagt = Number(request.headers.get('Content-Length') || 0);
    if (angesagt > BILD_MAX) return fehler(request, 'Das Bild ist zu groß', 413);

    /* Die eigene Sperre ist noetig, weil das Hochladen VOR dem Abschicken
       laeuft: die Kommentarsperre greift erst danach und haelt hier nichts
       auf. Vor dem Lesen des Rumpfes, sonst ist die Arbeit schon getan. */
    const [sperre, heute] = await env.DB.batch([
      env.DB.prepare("SELECT 1 FROM bild_uploads WHERE autor_id = ? AND erstellt > datetime('now', ?) LIMIT 1")
        .bind(ich.id, `-${BILDSPERRE} seconds`),
      env.DB.prepare("SELECT count(*) AS n FROM bild_uploads WHERE autor_id = ? AND erstellt > datetime('now','-1 day')")
        .bind(ich.id),
    ]);
    if (sperre.results.length) return fehler(request, 'Zu schnell — kurz durchatmen', 429);
    if (heute.results[0].n >= BILDER_TAG) {
      return fehler(request, `Höchstens ${BILDER_TAG} Fotos am Tag`, 429);
    }

    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return fehler(request, 'Kein Bild im Rumpf');
    if (bytes.byteLength > BILD_MAX) return fehler(request, 'Das Bild ist zu groß', 413);

    const typ = bildTyp(bytes);
    if (!typ) return fehler(request, 'Das ist kein JPEG, PNG oder WebP', 415);
    const [mime, endung] = typ;

    const key = `${crypto.randomUUID()}.${endung}`;
    await env.BILDER.put(key, bytes, {
      httpMetadata: {
        contentType: mime,
        // Der Schluessel ist eine UUID, das Objekt darunter aendert sich nie -
        // also darf es liegen bleiben, so lange der Browser will.
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });

    /* Erst nach dem put: eine Zeile ohne Objekt waere eine Sperre gegen den
       Nutzer fuer ein Bild, das gar nicht angekommen ist. */
    await env.DB.prepare('INSERT INTO bild_uploads (autor_id, bild_key) VALUES (?, ?)')
      .bind(ich.id, key).run();

    return antwort(request, { key, bild: bildUrl(env, key) }, 201);
  },

  // -------------------------------------------------------------------------
  /* Schreiben. Auf SICH SELBST ausdruecklich erlaubt - sonst kann der
     Gastgeber im eigenen Thread nicht antworten. Auf einen Termin jederzeit,
     auch vorher ("bring Chips mit"); nur bewertet wird erst hinterher. */
  'POST /api/kommentar': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const ziel = zielAus(`${daten.ziel_art}:${daten.ziel_id}`);
    if (!ziel) return fehler(request, "ziel_art: 'user' oder 'termin', ziel_id: eine Zahl");

    /* Ein Foto allein ist ein gueltiger Kommentar - "so sah es aus" braucht
       keinen Satz dazu. Leer bleiben duerfen aber nicht beide. */
    const b = await pruefeBild(env, daten.bild);
    if (b.fehler) return fehler(request, b.fehler, b.status);

    const text = String(daten.text ?? '').trim();
    if (!text && !b.key) return fehler(request, 'Ohne Text kein Kommentar');
    if (text.length > KOMMENTAR_MAX) {
      return fehler(request, `Höchstens ${KOMMENTAR_MAX} Zeichen`);
    }

    const fehlt = await zielFehlt(env, ziel);
    if (fehlt) return fehler(request, fehlt, 404);

    /* Genau eine Antwortebene: zeigt `antwort_auf` auf eine Antwort, haengt
       der Kommentar an DEREN Wurzel. Der Absender muss davon nichts wissen. */
    let wurzel = null;
    if (daten.antwort_auf != null) {
      const auf = await env.DB.prepare(`
        SELECT id, antwort_auf, ziel_art, ziel_id FROM kommentare WHERE id = ?
      `).bind(Number(daten.antwort_auf)).first();
      if (!auf) return fehler(request, 'Den Kommentar gibt es nicht', 404);
      if (auf.ziel_art !== ziel.art || auf.ziel_id !== ziel.id) {
        return fehler(request, 'Der Kommentar gehört woandershin');
      }
      wurzel = auf.antwort_auf || auf.id;
    }

    const grenze = await kommentarGrenze(env, ich.id);
    if (grenze) return fehler(request, grenze.fehler, grenze.status);

    const neu = await env.DB.prepare(`
      INSERT INTO kommentare (ziel_art, ziel_id, autor_id, antwort_auf, text, bild_key)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `).bind(ziel.art, ziel.id, ich.id, wurzel, text, b.key).first();

    // 'tafel' wegen des Zaehlers an der Zeile, das Ziel wegen des Threads.
    anstoss(request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
    return antwort(request, { ok: true, id: neu.id, antwort_auf: wurzel }, 201);
  },

  // -------------------------------------------------------------------------
  /* Aendern oder loeschen, beides nur durch den Autor. Geloescht wird WEICH:
     der Text verschwindet, die Karte bleibt als "gelöscht" stehen - sonst
     haengen die Antworten darunter in der Luft. */
  'POST /api/kommentar/aendern': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    // ziel_art/ziel_id stehen hier nur fuer den Anstoss mit dabei - die Seite
    // bekommt sie nicht, sie kennt ihr Ziel selbst.
    const k = await env.DB.prepare(
      'SELECT id, autor_id, geloescht_am, bild_key, ziel_art, ziel_id FROM kommentare WHERE id = ?')
      .bind(Number(daten.id)).first();
    if (!k) return fehler(request, 'Den Kommentar gibt es nicht', 404);
    if (k.autor_id !== ich.id) return fehler(request, 'Das ist nicht deiner', 403);
    if (k.geloescht_am) return fehler(request, 'Der ist schon gelöscht', 409);

    if (daten.loeschen) {
      /* Das Objekt zuerst, die Zeile danach. Gelaengen sie in der anderen
         Reihenfolge und der zweite Schritt scheiterte, bliebe das Foto eines
         geloeschten Kommentars unter seiner Adresse abrufbar - und genau
         dieser Fall ist der, fuer den geloescht wird. So bleibt im
         schlechteren Fall eine Karte mit totem Bildlink stehen: sichtbar,
         wiederholbar, und nichts liegt mehr offen. */
      if (k.bild_key && env.BILDER) await env.BILDER.delete(k.bild_key);
      /* Auch die Sterne der Karte gehen weg: die Antwort zeigt sie ohnehin
         nicht mehr, und was nicht mehr gezeigt wird, soll auch nicht mehr
         herumliegen. Die BEWERTUNG selbst bleibt - sie zaehlt weiter auf den
         Schnitt, geloescht wurde ein Kommentar, keine Note. */
      await env.DB.prepare(`
        UPDATE kommentare
        SET geloescht_am = datetime('now'), text = '', bild_key = NULL, sterne = NULL
        WHERE id = ?
      `).bind(k.id).run();
      // Ein geloeschter Kommentar zaehlt nicht mehr mit - also auch 'tafel'.
      anstoss(request, env, ctx, 'tafel', `${k.ziel_art}:${k.ziel_id}`);
      return antwort(request, { ok: true, geloescht: true });
    }

    // Haengt ein Foto daran, darf der Text beim Aendern auch ganz weg.
    const text = String(daten.text ?? '').trim();
    if (!text && !k.bild_key) return fehler(request, 'Ohne Text kein Kommentar');
    if (text.length > KOMMENTAR_MAX) return fehler(request, `Höchstens ${KOMMENTAR_MAX} Zeichen`);

    await env.DB.prepare("UPDATE kommentare SET text = ?, geaendert = datetime('now') WHERE id = ?")
      .bind(text, k.id).run();
    // Nur der Thread: an der Zahl der Kommentare aendert ein neuer Text nichts.
    anstoss(request, env, ctx, `${k.ziel_art}:${k.ziel_id}`);
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Reagieren. Ein Schalter: derselbe Druck nimmt zurueck - das traegt der
     Primaerschluessel der Tabelle, hier steht nur, welcher der beiden Faelle
     gerade eingetreten ist. */
  'POST /api/reaktion': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const art = String(daten.art || '');
    if (!REAKTIONEN.has(art)) return fehler(request, 'Diese Reaktion gibt es nicht');

    const id = Number(daten.kommentar_id);
    // ziel_art/ziel_id nur fuer den Anstoss, siehe /api/kommentar/aendern.
    const k = await env.DB.prepare(
      'SELECT id, geloescht_am, ziel_art, ziel_id FROM kommentare WHERE id = ?')
      .bind(id).first();
    if (!k) return fehler(request, 'Den Kommentar gibt es nicht', 404);
    if (k.geloescht_am) return fehler(request, 'Der ist gelöscht', 409);

    /* Erst einfuegen, dann - wenn es die Zeile schon gab - loeschen. Die
       Reihenfolge ist der ganze Punkt: andersherum loeschen zwei gleichzeitige
       Taps desselben Nutzers (zwei Geraete, oder ein zweiter Druck bei lahmer
       Leitung) beide nichts und fuegen beide ein, und der zweite laeuft in den
       Primaerschluessel und damit in einen 500er. So ist jeder der beiden
       Schritte fuer sich idempotent: die Taps ueberholen sich hoechstens
       gegenseitig, und das Ergebnis ist immer ein gueltiger Zustand. */
    const rein = await env.DB.prepare(`
      INSERT INTO reaktionen (kommentar_id, autor_id, art) VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(id, ich.id, art).run();
    const meins = rein.meta.changes === 1;
    if (!meins) {
      await env.DB.prepare(
        'DELETE FROM reaktionen WHERE kommentar_id = ? AND autor_id = ? AND art = ?')
        .bind(id, ich.id, art).run();
    }

    const n = await env.DB.prepare(
      'SELECT count(*) AS anzahl FROM reaktionen WHERE kommentar_id = ? AND art = ?')
      .bind(id, art).first();
    /* Nur das Ziel: Reaktionen zaehlen nicht in die Liste. Der Daumen ist die
       kleinste Handlung auf der ganzen Seite - und die, bei der das
       Nacheinander am meisten stoert. */
    anstoss(request, env, ctx, `${k.ziel_art}:${k.ziel_id}`);
    return antwort(request, { art, anzahl: n.anzahl, meins });
  },

  // -------------------------------------------------------------------------
  /* Was zu einem Ziel vorliegt: Schnitt je Kategorie und die eigene Abgabe.
     Das Token ist OPTIONAL - ohne eines liest man mit, nur `meins` fehlt dann.
     Die Kategorien reisen mit, damit die Seite sie nicht ein zweites Mal
     fuehrt. */
  'GET /api/bewertungen': async (request, env) => {
    const url = new URL(request.url);
    const ziel = zielAus(url.searchParams.get('ziel'));
    if (!ziel) return fehler(request, 'ziel: etwa user:5 oder termin:12');

    const ich = await nutzer(request, env);

    const ichId = ich ? ich.id : 0;
    const [alle, meins, roh, reakt, eigene] = await env.DB.batch([
      env.DB.prepare('SELECT ziel_art, ziel_id, sterne FROM bewertungen WHERE ziel_art = ? AND ziel_id = ?')
        .bind(ziel.art, ziel.id),
      env.DB.prepare('SELECT sterne FROM bewertungen WHERE autor_id = ? AND ziel_art = ? AND ziel_id = ?')
        .bind(ichId, ziel.art, ziel.id),
      ...baumStmts(env, ziel, ichId),
    ]);

    const e = schnitte(alle.results).get(`${ziel.art}:${ziel.id}`);
    const kategorien = KATEGORIEN[ziel.art].map(([feld, name]) => {
      const j = e && e.je.get(feld);
      return { feld, name, schnitt: j ? note(j.summe, j.zahl) : null, anzahl: j ? j.zahl : 0 };
    });

    let eigeneSterne = null;
    if (meins.results.length) {
      try { eigeneSterne = JSON.parse(meins.results[0].sterne); } catch { eigeneSterne = null; }
    }

    return antwort(request, {
      ziel: `${ziel.art}:${ziel.id}`,
      ...schnittAntwort(e),
      kategorien,
      meins: eigeneSterne,
      // Sich selbst bewertet niemand - die Seite soll das Formular gar nicht
      // erst zeigen, statt am 403 hängenzubleiben.
      darf: !!(ich && ich.name) && !(ziel.art === 'user' && ich.id === ziel.id),
      // Schreiben darf man ueberall, auch bei sich selbst: sonst kann der
      // Gastgeber im eigenen Thread nicht antworten.
      darf_schreiben: !!(ich && ich.name),
      kommentare: baumBauen(roh.results, reakt.results, eigene.results, ichId, env),
    });
  },

  // -------------------------------------------------------------------------
  'GET /api/leaderboard': async (request, env) => {
    /* Alles fuer eine Seitenansicht in einem Rutsch: aktueller Stand,
       Bestmarke, Verlauf, das Gluecksrad (Ziehung des Tages + wer heute im
       Topf ist) und die Termine. Der aktuelle Stand ist die juengste Meldung
       je Nutzer - deshalb wird nie ueberschrieben, der Verlauf faellt dabei
       von selbst an.
       Alles reitet hier mit statt auf eigenen Routen: eine Runde weniger, ein
       Cache-Verhalten weniger, und die Seite fragt ohnehin im Minutentakt nach. */
    const tag = bierTag();
    const [stand, best, verlauf, los, losFeld, termine, bewertungen, zaehler] =
      await env.DB.batch([
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
      /* Bewusst OHNE Verfallslauf: das hier ist eine gecachte Leseroute, die
         soll nichts schreiben. `losTagStmt` rechnet die Frist ohnehin mit aus,
         eingetragen wird sie beim naechsten Dreh. */
      losTagStmt(env, tag),
      losFeldStmt(env),
      termineStmt(env),
      bewertungenStmt(env),
      kommentarZaehlerStmt(env),
    ]);

    const bestmarke = new Map(best.results.map(r => [r.user_id, r.best]));
    const kurve = new Map();
    for (const z of verlauf.results) {
      if (!kurve.has(z.user_id)) kurve.set(z.user_id, []);
      kurve.get(z.user_id).push(z.biere);
    }

    /* Die Schnitte einmal rechnen, dann zweimal abgreifen: Nutzer und Termine
       kommen aus derselben Tabelle. Termin-Bewertungen zaehlen dabei NICHT auf
       den Nutzer ein - sonst zaehlte ein einziger Abend doppelt. */
    const noten = schnitte(bewertungen.results);
    const wieViele = new Map(zaehler.results.map(z => [z.ziel_art + ':' + z.ziel_id, z.anzahl]));

    const feld = stand.results.map(r => ({
      // Die Id, damit die Seite eine Bewertung adressieren kann. Ohne Token
      // faengt niemand etwas damit an.
      id: r.id,
      bewertung: schnittAntwort(noten.get('user:' + r.id)),
      kommentare: wieViele.get('user:' + r.id) || 0,
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

    /* Eine halbe Minute Cache: die Seite wird oefter geladen als gemeldet. Das
       gilt auch fuer das Rad - wer selbst dreht, sieht es sofort aus der
       Antwort auf POST /api/drehen, alle anderen binnen einer halben Minute. */
    const lage = tagesLage(los.results);
    return antwort(request, {
      feld,
      los: losAntwort(tag, lage, losTopf(losFeld.results, lage), termine.results),
      termine: termine.results.map(t => terminAntwort(t, noten, wieViele)),
    }, 200, { 'Cache-Control': 'public, max-age=30' });
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
