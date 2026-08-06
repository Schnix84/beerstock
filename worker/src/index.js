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
/* BLEIBT bei 60, waehrend Kommentar-, Bild- und Bewertsperre 2026-08-06 auf 3
   heruntergingen. Der Unterschied ist nicht die Bedienung, sondern was dahinter
   steht: hinter Kommentaren und Fotos liegt mit KOMMENTARE_TAG/BILDER_TAG eine
   Tagesgrenze, die Flut wirklich abfaengt - hinter `reports` liegt KEINE. Jede
   Meldung ist eine neue Zeile (der Verlauf lebt davon), und diese Minute ist
   das einzige Netz, das es dort gibt. Wer sie senkt, braucht vorher ein
   Tagesbudget fuer Meldungen. */
const MELDESPERRE  = 60;    // Sekunden zwischen zwei Meldungen desselben Nutzers
const VERLAUF_TAGE = 30;

/* Die Bestenliste faellt seit der Tuer je nach `Authorization` anders aus, und
   damit darf sie kein gemeinsamer Speicher mehr weiterreichen: `public` haette
   die Antwort eines Angemeldeten an den naechsten Fremden ausliefern koennen,
   und andersherum den beschnittenen Stand an einen Angemeldeten. `private`
   laesst nur den Browser des Aufrufers behalten; `Vary` sagt es jedem
   Zwischenspeicher noch einmal ausdruecklich. `Origin` steht mit drin, weil
   `koepfe()` es setzt - dieser Kopf ersetzt ihn, statt sich dazuzustellen. */
const KEIN_FREMDER_CACHE = {
  'Cache-Control': 'private, max-age=30',
  'Vary': 'Origin, Authorization',
};

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
/* Wie lange ein Abend dauert, wenn niemand etwas anderes sagt. Beide Wege -
   Zusage am Rad und Eintrag von Hand - belegen `endet_am` damit vor, und der
   Wert steht HIER statt als DEFAULT in der Tabelle, damit es nur eine Fassung
   gibt (siehe 0010_termin_ende.sql).

   Das Ende ist eine Anzeige, keine Prophezeiung: es sagt, bis wann der Abend
   als "laeuft gerade" gilt. Wer laenger sitzt, sitzt laenger. Sperre und
   Bewertung haengen unveraendert am ANFANG - sonst koennte einer den Abend
   noch verschieben, waehrend die anderen schon darunter kommentieren. */
const TERMIN_DAUER_STD = 4;      // Stunden
const TERMIN_DAUER_MAX = 24;     // Stunden, gegen den Abend, der eine Woche dauert
/* Die Chronik dahinter kennt kein Fenster - sie blaettert, statt abzuschneiden.
   `SEITE` ist, was ohne Wunsch herauskommt, `MAX` die Obergrenze auf einen
   Griff: die Seite fordert beim stillen Nachladen so viele an, wie sie gerade
   zeigt, und das darf nicht ins Unbegrenzte wachsen. */
const CHRONIK_SEITE = 20;
const CHRONIK_MAX   = 100;
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
/* Die Sperre gilt nur gegen den, der von Ziel zu Ziel springt - NICHT gegen
   den, der gerade dieses eine Blatt ausfuellt. Vier Kategorien sind vier Taps
   und damit vier Rufe, und die Sperre stand vorher auf 10 Sekunden je NUTZER:
   die erste Reihe ging durch, die zweite bis vierte holten sich "Zu schnell",
   und die eben getippten Sterne sprangen wieder aus. Genau die Bedienung, fuer
   die die Seite gebaut ist, war der Fall, den sie abwies.

   Dass Nachbessern am selben Ziel frei ist, kostet nichts: `bewertungen` hat
   UNIQUE (autor_id, ziel_art, ziel_id), jeder weitere Tap trifft per UPSERT
   dieselbe eine Zeile. Wachsen kann nur, wer neue ZIELE bewertet - und genau
   das bremst die Sperre. Drei Sekunden reichen dafuer; ein Mensch, der zwei
   verschiedene Abende bewertet, braucht laenger, um das Blatt zu wechseln. */
const BEWERTSPERRE = 3;    // Sekunden, bis das naechste ANDERE Ziel drankommt

/* Wrapped: der Jahresrueckblick. "Tage auf Platz 1" (Eiskoenig) und die
   Kalt-Serie tragen einen gemeldeten Bestand ueber den Kalender fort, bis
   eine neue Meldung kommt (Tagesende-Stand). Ohne Grenze wuerde EINE einzige
   fruehe Meldung (hoch gemeldet, dann Funkstille) den Rest des Jahres
   dominieren - abgesichert per Opus-Unteragent an einer Testdatenbank
   (ideas/PROJECT-MEMORY.md), mit dem Nutzer abgestimmt. Sieben Tage kosten
   echte, regelmaessige Melder kaum etwas. */
const WRAPPED_VERFALL_TAGE = 7;
/* Dieselbe Grenze wie STUFEN[1] ("kalt") in index.html, dort steht die
   Ampel - hier nur die Zahl. Zwei Fassungen liefen sonst auseinander. */
const WRAPPED_KALT_GRAD = 6;

/* Kommentare. Eine Antwortebene, mehr nicht - auf dem Handy ist bei Stufe drei
   die Spalte vierzig Pixel breit. Genau wie WhatsApp. */
const KOMMENTAR_MAX    = 400;  // Zeichen
const KOMMENTARE_TAG   = 30;   // je Nutzer und Tag
/* 3 Sekunden, nicht 10 (geaendert 2026-08-06). Zehn war gegen Flut gedacht und
   traf den Normalfall: zwei Saetze hintereinander, oder der Nachtrag "ach, und
   Kohle bringe ich mit". Genau dieser Fehler steckte schon einmal in der
   BEWERTSPERRE - dort steht die Geschichte dazu. Das Netz gegen echte Flut ist
   KOMMENTARE_TAG, nicht diese Sekundenzahl; die bremst nur den Doppeltipp und
   die Maschine. */
const KOMMENTARSPERRE  = 3;    // Sekunden zwischen zweien desselben Nutzers
const KOMMENTARE_ZIEL  = 200;  // je Ziel; aeltere fallen weg, sonst waechst es unbegrenzt
/* Reaktionen: das Emoji selbst ist der Schluessel, seit Migration 0019. Die
   Liste steht hier und nicht mehr im CHECK der Tabelle - eine weitere Reaktion
   ist damit eine Zeile Code statt eines Schemaschritts.

   Sie ist eine ALLOWLIST und kein Muster: was gespeichert wird, ist immer das
   Zeichen aus DIESER Liste, nie das vom Client geschickte. Damit ist die
   Normalisierung geschenkt - '❤' (ohne U+FE0F) und '❤️' (mit) waeren sonst zwei
   verschiedene Zeilen im Primaerschluessel, und ein Herz koennte sich nicht
   mehr zuruecknehmen lassen, weil es unter dem anderen Namen laege.

   Die Reihenfolge ist die des Waehlers auf der Seite; index.html haelt
   dieselbe Liste (EMOJI_WORT). Weichen die beiden voneinander ab, ist das ein
   400er auf einen Knopf, den die Seite anbietet - beim Erweitern also BEIDE. */
const REAKTIONEN = new Set([
  '❤️', '👍', '🍺', '🍻', '😆',
  '👎', '😂', '🤣', '😮', '😢', '😡', '🥳', '😍', '😎', '🤔',
  '🙈', '🫡', '🤷', '😴', '🥴', '🤢',
  '🎉', '🔥', '👏', '🙏', '💪', '🤝', '👀', '💯', '⭐', '⚡',
  '🚀', '✅', '❌', '🏆', '💸', '🧊',
  '🥂', '🍾', '🍷', '🥃', '☕', '🍕', '🍔', '🌭', '🥨', '🍟',
  '⚽', '🎵', '📸', '🚲',
]);

/* Was eine Seite schickt, die noch im Cache des Browsers liegt: sie kennt die
   vier alten Namen und nicht die Zeichen. Ein 400er waere hier eine Reaktion,
   die "einfach nicht geht", bis jemand neu laedt - billiger ist, sie zu
   uebersetzen. Kann weg, wenn lange genug niemand mehr mit einer alten Fassung
   unterwegs ist. */
const REAKTIONEN_ALT = {
  daumen_hoch: '👍', daumen_runter: '👎', herz: '❤️', bier: '🍺',
};

/* Der Notruf. Zwei Noete, ein Ort, eine Frist.
   ---------------------------------------------------------------------------
   Die Frist ist der Kern und nicht die Kosmetik: ein Notruf, der stehen
   bleibt, ist kein Notruf mehr, sondern ein veroeffentlichter Aufenthaltsort.
   Anderthalb Stunden sind lang genug, dass jemand ankommt, und kurz genug,
   dass niemand vergisst, dass er noch dasteht. Wer frueher fertig ist, nimmt
   ihn zurueck; wer es vergisst, wird vergessen.

   Die Sperre ist dieselbe Ueberlegung wie bei MELDESPERRE - der Freund, der
   zweimal drueckt, weil er nichts passieren sieht. Sie steht hier niedriger,
   weil ein zweiter Notruf durchaus eine echte Korrektur sein kann: falscher
   Knopf, oder man ist inzwischen woanders. Wer erneut drueckt, ERSETZT seinen
   offenen Notruf, er stellt keinen zweiten daneben. */
const NOTRUF_MINUTEN = 90;   // so lange gilt einer, dann erlischt er von selbst
const NOTRUFSPERRE   = 20;   // Sekunden zwischen zwei Notrufen desselben Nutzers
const NOTRUF_ARTEN   = new Set(['bier', 'kamerad', 'alles']);
/* Wie lange eine erloschene Zeile noch herumliegt, bevor der Cron sie
   wegraeumt. Sie ist da nicht mehr sichtbar - die Abfrage filtert nach `bis`
   und `weg_am` - sie liegt nur noch da. Ein Tag Puffer, damit das Aufraeumen
   ein Aufraeumen bleibt und keine Frist mit zwei Bedeutungen wird. */
const NOTRUF_MUELL   = 1;    // Tage

/* Der Kachelbereich der Karte. Enger als das, was OSM anbietet (0-19), und
   zwar an beiden Enden mit Grund: unter 12 sieht man keine Strassen mehr,
   sondern ein Bundesland, und ueber 18 nur noch Dachkanten. Beides waere
   Verkehr fuer nichts. Die Karte der Seite bleibt von sich aus in diesem
   Bereich; die Grenze hier gilt dem, der die Route direkt aufruft. */
const KACHEL_ZOOM_MIN = 12;
const KACHEL_ZOOM_MAX = 18;
/* Die Untergrenze, wie lange eine geholte Kachel bei uns liegen bleibt. Sie
   steht so hoch, weil die Nutzungsbedingungen genau das verlangen: entweder
   die Cache-Kopfe des Servers achten oder mindestens sieben Tage halten. Wir
   nehmen den laengeren der beiden Werte. */
const KACHEL_TTL = 7 * 24 * 3600;   // Sekunden

/* Fotos an Kommentaren. Verkleinert wird im BROWSER (lange Kante 1600 px,
   JPEG 0.8) - aus 4 MB Handyfoto werden ~250 kB. Damit faellt alles weg, was
   sonst teuer waere: keine Bildverarbeitung hier, kein Multipart, keine
   grossen Ruempfe. Der Deckel steht trotzdem, denn der Worker redet nicht nur
   mit unserem Browser. */
const BILD_MAX     = 2 * 1024 * 1024;  // Bytes
// 3 wie ueberall in der Schreibstrecke (2026-08-06, siehe KOMMENTARSPERRE).
// Der Deckel gegen echte Flut ist BILDER_TAG und BILD_MAX, nicht die Sekunde.
const BILDSPERRE   = 3;                // Sekunden zwischen zwei Uploads desselben Nutzers
const BILDER_TAG   = 30;               // je Nutzer und Tag, wie KOMMENTARE_TAG

/* Die Schonfrist der Waisen. Hochgeladen wird VOR dem Abschicken, dazwischen
   liegt das Tippen - ein Bild ohne Kommentar ist also erst dann wirklich
   liegengeblieben, wenn niemand mehr daran schreibt. Ein Tag ist grosszuegig
   gerechnet (getippt wird in Minuten), aber die Kosten der Grosszuegigkeit
   sind ein Vierteltelmegabyte je Fall - die eines zu frueh geloeschten Bildes
   waere ein Kommentar, dessen Foto beim Abschicken schon weg ist.

   Der Deckel je Lauf haelt den Zeitgeber kurz. 200 Waisen am Tag entstehen
   hier nie; er greift nur beim ersten Lauf, wenn Altbestand da ist, und laesst
   den dann ueber ein paar Tage abfliessen statt in einem Rutsch. */
const WAISENFRIST  = '-1 day';
const WAISEN_PRO_LAUF = 200;

/* Die Link-Vorschau (siehe ideas/plan-link-vorschau.md und Migration 0022).
   Alle vier Zahlen sind Deckel gegen eine fremde Seite, die sich nicht benimmt
   - langsam antwortet, endlos umleitet, oder ein Gigabyte HTML schickt. Fuer
   das Vorschaubild gilt BILD_MAX weiter, es ist ein Bild wie jedes andere. */
const VORSCHAU_ZEIT     = 5000;               // ms, hartes Ende via AbortSignal
/* 2 MB und nicht die 512 kB aus dem Plan: bei YouTube steht `og:title` an
   Byte 686.975 (gemessen 2026-08-06 an einem gewoehnlichen /watch), der kleine
   Deckel schnitt also ausgerechnet den Hauptfall ab. Das ist billiger, als es
   aussieht - gelesen wird streamend und weggeworfen, es wird nichts behalten,
   und `ogLesen` bricht ohnehin ab, sobald der Kopf durch ist oder alle drei
   Felder stehen. Diese Zahl ist der Notnagel gegen eine Seite ohne Ende, nicht
   die Stelle, an der normalerweise aufgehoert wird. */
const VORSCHAU_HTML_MAX = 2 * 1024 * 1024;    // Bytes HTML, danach abgebrochen
const VORSCHAU_HOPS     = 3;                  // Weiterleitungen, von Hand gezaehlt
const VORSCHAU_TEXT_MAX = 300;                // Zeichen og:description

/* Die Bremse fuer POST /api/vorschau - die Karte SCHON BEIM TIPPEN, nach Art
   von WhatsApp. Nur diese Route wird gebremst, nie der Weg nach dem
   Abschicken: ein abgeschickter Kommentar bekommt seine Karte immer.

   Gezaehlt werden frisch geholte Zeilen im Fenster, ueber `vorschauen.geholt`
   - ein Treffer im Cache schreibt keine Zeile und zaehlt darum nicht mit. Die
   Zahl ist global und nicht je Nutzer, weil `vorschauen` keinen Autor kennt
   und eine Spalte dafuer eine Migration waere, die diese Sache nicht wert ist.
   Damit ein schneller Tipper nicht allen anderen die Karte nimmt, ist das
   Ueberschreiten KEIN Fehler: die Route schlaegt dann nur noch nach und holt
   nicht mehr. Wer wartet, bekommt sie beim Abschicken. */
const VORSCHAU_TAKT     = 20;                 // frische Abrufe je Fenster
const VORSCHAU_FENSTER  = 60;                 // Sekunden

/* GIFs und Memes an Kommentaren (siehe ideas/gifs-und-memes.md). Ein GIF wird
   wie ein Foto ein `bild_key` - dieselbe Sperre, dasselbe Tagesbudget, kein
   eigener Weg. Giphys Deckel ist 100 Abrufe die Stunde; der Cache haelt eine
   Suche eine Stunde vor, damit eine Runde von einer Handvoll Leuten darunter
   bleibt. Die Imgflip-Vorlagenliste aendert sich praktisch nie binnen eines
   Tages, deshalb dort 24 Stunden. */
const GIF_SUCHE_MAX    = 60;      // Zeichen im Suchbegriff
const GIF_LIMIT        = 24;      // Treffer je Seite
const GIF_CACHE_TTL    = 3600;    // Sekunden, Giphy-Suche im caches.default
const GIF_ID           = /^[A-Za-z0-9]{1,40}$/;
const MEME_VORLAGEN_TTL = 24 * 3600; // Sekunden, Imgflip-Vorlagenliste und -bilder

/* Der Bierabend-Tag endet nicht um Mitternacht, sondern zwei Stunden spaeter
   (03:00 bzw. 04:00 Ortszeit) - sonst faellt die Drehung um kurz nach eins auf
   den naechsten Tag, obwohl sie zu demselben Abend gehoert. Bewusst in UTC
   gerechnet statt ueber eine Zeitzone: die Stunde Sommerzeit-Drift ist an
   dieser Grenze egal, eine ICU-Abhaengigkeit waere es nicht.

   Vier Uhr und nicht acht: der Zweck der Grenze - die Drehung um halb zwei
   gehoert zum Abend davor - reicht nur bis in die Nacht. Alles danach ist
   Widerspruch zur Datumszeile ueber dem Rad, die um Mitternacht springt.
   Vier Uhr laesst davon die vier Stunden stehen, in denen niemand hinsieht. */
const LOS_GRENZE = 2;
const bierTag = () => new Date(Date.now() - LOS_GRENZE * 3600e3).toISOString().slice(0, 10);

/* Die Benachrichtigungsarten. Wie KATEGORIEN: sie stehen HIER, nicht in der
   Datenbank - sechs Zeilen Stammdaten waeren ein JOIN je Abruf, und was der
   Nutzer davon abgewaehlt hat, liegt als JSON in `users.mail_prefs`.
   Unbekannte Schluessel weist die Route ab, fehlende gelten als Vorgabe.

   Die Beschriftung reist mit, damit die Seite sie nicht ein zweites Mal
   fuehren muss - zwei Fassungen laufen auseinander.

   `echo` ist die einzige mit Vorgabe AUS: sie ist die Art, die eine Runde an
   einem lebhaften Abend zumuellt. Wer sie will, schaltet sie ein. */
const MAIL_ARTEN = {
  gewonnen:       { vorgabe: true,  titel: 'Die Flasche zeigt auf mich' },
  termin_neu:     { vorgabe: true,  titel: 'Ein Abend steht fest' },
  termin_aendert: { vorgabe: true,  titel: 'Ein Abend verschiebt sich oder fällt aus' },
  echo:           { vorgabe: false, titel: 'Antwort auf meinen Beitrag, Sterne für mich' },
  rundmail:       { vorgabe: true,  titel: 'Gelegentliche Nachricht vom Wirt' },
  /* Abwaehlbar wie alles hier, aber mit Vorgabe AN: eine Not, von der niemand
     erfaehrt, ist keine gemeldet. Wer sie abstellt, tut das bewusst. */
  notruf:         { vorgabe: true,  titel: 'Jemand braucht Bier oder Gesellschaft' },
};

// Zwei Rollen, mehr nicht. Alles darueber waere Verwaltung von Verwaltung.
const ROLLEN = new Set(['user', 'admin']);

/* Die Zeitraeume, die das Kontor zeigen darf. Der erste ist die Vorgabe.
   Eine LISTE, kein Bereich mit Ober- und Untergrenze: der Wert geht in ein
   `datetime('now', ?)`, und drei erlaubte Zahlen kann man ansehen und
   verstehen - eine Spanne muss man nachrechnen. */
const STATISTIK_TAGE = [30, 60, 90];

/* Was ein Gesperrter trotzdem noch darf. Abmelden gehoert dazu: es loescht
   nur sein eigenes Geraete-Token, und wer draussen bleiben soll, soll auch
   herauskommen duerfen. Lesen ist ohnehin frei - die Sperre trifft nur
   Schreibrouten (siehe `nutzer`). */
const SPERRE_FREI = new Set(['POST /api/abmelden']);

// Magic Links. Kurz gueltig, weil eine Mail im Posteingang liegen bleibt.
const LINK_MINUTEN = 15;
/* Die Missbrauchsbremse. Offener Zugang plus Mailversand heisst: ohne diese
   Zahlen ist der Posteingang ein Versandknopf im Netz, mit dem ein Fremder
   beliebige Leute zumuellen kann - bis AgentMail das Konto dichtmacht. */
const LINKS_PRO_ADRESSE = 3;    // je Stunde
const LINKS_GESAMT      = 30;   // je Stunde, ueber alle Adressen
/* Der Mailwechsel laeuft ueber dieselbe Tabelle und damit durch dieselben
   zwei Bremsen oben. Diese hier kommt dazu, weil ein Angemeldeter sonst mit
   drei Rufen die Stunde durchprobieren koennte, welche fremde Adresse schon
   vergeben ist - die 409 ist eine Auskunft. */
const MAILWECHSEL_PRO_TAG = 3;

/* Die Rundmail. Vier Kilozeichen sind lang genug fuer alles, was ein Wirt
   seiner Runde zu sagen hat, und kurz genug, dass niemand versehentlich einen
   Roman verteilt. Die Stunde Sperre ist gegen den Fehlgriff um zwei Uhr
   nachts, nicht gegen Missbrauch - missbrauchen kann sie nur ein Admin. */
const RUNDMAIL_MAX         = 4000;  // Zeichen
const RUNDMAIL_BETREFF_MAX = 120;
const RUNDMAIL_SPERRE      = 1;     // Stunden zwischen zwei Rundmails
const RUNDMAIL_KNOPF_MAX   = 40;    // Zeichen auf dem Knopf
const RUNDMAIL_LINK_MAX    = 500;   // Zeichen, Bild- und Knopf-Adresse
const RUNDMAIL_VORAUS      = 90;    // Tage, so weit darf eine geplante Rundmail vorausliegen

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

/* Die Sperre, geworfen statt zurueckgegeben. Jede geschuetzte Route schreibt
   heute `if (!ich) return 401` - ein zweiter Rueckgabewert muesste in allen
   achtzehn geprueft werden, und die eine vergessene Stelle waere das Loch.
   Geworfen kommt sie unten im Router an genau EINER Stelle wieder heraus. */
class Gesperrt extends Error {}

/* Der Traeger eines Geraete-Tokens ist der Nutzer. Ein Nutzer kann mehrere
   haben - Handy und Laptop sollen sich nicht gegenseitig ausloggen.

   Das hier ist das einzige Tor: Rolle und Sperre gehoeren genau hierher und
   nirgendwo sonst. Wer gesperrt ist, darf lesen (die Tafel sieht er weiter),
   aber nichts mehr schreiben; wer entfernt wurde, ist niemand mehr. */
async function nutzer(request, env) {
  const kopf = request.headers.get('Authorization') || '';
  const token = kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
  if (!token) return null;
  const h = await hash(token);

  /* Der Zeitstempel des Geraets wird HIER mitgeschrieben, im selben `batch`
     wie die Abfrage - eine Runde zur Datenbank, kein loser Promise. Ein
     `waitUntil` gaebe es hier gar nicht: `ctx` reist nicht bis in diese
     Funktion, und ein nicht abgewarteter Schreibvorgang wird von der Laufzeit
     abgeschnitten, sobald die Antwort raus ist.

     GEDROSSELT auf eine Stunde, und das ist der Punkt: die offenen Seiten
     fragen im Minutentakt nach, und ein Schreibvorgang je Abruf waeren
     Tausende am Tag, damit eine Anzeige minutengenau statt stundengenau ist.
     Trifft die WHERE-Klausel nicht, schreibt SQLite keine Zeile.

     Der `UPDATE` steht VOR dem `SELECT` - ein `batch` laeuft der Reihe nach in
     einer Transaktion, das gelesene `zuletzt` ist also schon das neue. Fuer
     das Geraet, das gerade fragt, ist "jetzt" auch die richtige Antwort.

     Die dritte Anweisung traegt eine EIGENE, viel kuerzere Drosselung: zehn
     Sekunden statt einer Stunde. Grund ist nicht Sparsamkeit wie oben,
     sondern dass eine einzelne Seitenansicht mehrere Anfragen gleichzeitig
     abschickt - das Kontor allein ruft beim Aufbau fuenf Routen parallel auf
     (siehe admin.html). Ohne die Drosselung waere "ein Aufruf" im Log fuenf
     Zeilen, und die Anzeige im Kontor zaehlte Anfragen statt Besuche. Zehn
     Sekunden reichen, um so ein Buendel zusammenzufassen, sind aber kurz
     genug, dass ein echter zweiter Besuch kurz danach wieder zaehlt. Traegt
     der Token keinen Nutzer, liefert die Unterabfrage nichts und die Zeile
     bleibt aus. */
  const [, gefunden] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE tokens SET zuletzt = datetime('now')
      WHERE token_hash = ?
        AND (zuletzt IS NULL OR zuletzt < datetime('now','-1 hour'))
    `).bind(h),
    env.DB.prepare(`
      SELECT u.id, u.name, u.email, u.quelle, u.rolle,
             u.gesperrt_am, u.gesperrt_grund, u.entfernt_am,
             u.mail_prefs, u.mail_stumm_am
      FROM tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
    `).bind(h),
    env.DB.prepare(`
      INSERT INTO zugriffe (user_id)
      SELECT user_id FROM tokens t WHERE t.token_hash = ?
        AND NOT EXISTS (
          SELECT 1 FROM zugriffe z
          WHERE z.user_id = t.user_id AND z.erstellt > datetime('now', '-10 seconds')
        )
    `).bind(h),
  ]);
  const u = gefunden.results[0] || null;
  if (!u) return null;

  /* Ein Entfernter ist kein Halbangemeldeter, sondern niemand. Seine Token
     sind beim Entfernen ohnehin geloescht - das hier faengt nur den Fall ab,
     dass eines ueberlebt hat. */
  if (u.entfernt_am) return null;

  if (u.gesperrt_am && request.method !== 'GET'
      && !SPERRE_FREI.has(`${request.method} ${new URL(request.url).pathname}`)) {
    throw new Gesperrt(u.gesperrt_grund
      ? `Dein Zugang ist gesperrt: ${u.gesperrt_grund}`
      : 'Dein Zugang ist gesperrt.');
  }

  // Nebenbei, ohne die Antwort aufzuhalten: wann war dieses Geraet zuletzt da.
  u._token_hash = h;
  return u;
}

const istAdmin = ich => ich && ich.rolle === 'admin' && !ich.gesperrt_am;

/* Die Schalter eines Nutzers, aufgeloest: JSON-Spalte ueber die Vorgaben
   gelegt. Fehlende Schluessel gelten als Vorgabe, kaputtes JSON auch - eine
   halb gespeicherte Zeile darf niemanden aus dem Verteiler werfen. */
function mailWahl(u) {
  let eigen = {};
  try { eigen = JSON.parse(u.mail_prefs || '{}') || {}; } catch { eigen = {}; }
  const raus = {};
  for (const [art, def] of Object.entries(MAIL_ARTEN)) {
    raus[art] = typeof eigen[art] === 'boolean' ? eigen[art] : def.vorgabe;
  }
  return raus;
}

// ---------------------------------------------------------------------------
// Gluecksrad
// ---------------------------------------------------------------------------

/* Wer heute im Topf ist. Beide Aufrufer benutzen DIESE Abfrage - die
   Bestenliste zum Zeichnen des Rades, die Ziehung zum Ziehen. Zwei Fassungen
   derselben Regel liefen frueher oder spaeter auseinander, und dann zeigt das
   Rad ein Feld, aus dem gar nicht gezogen wurde.

   Und darum steht die Sperre AUCH nur hier: wer gesperrt ist, faellt aus dem
   Topf - aus dem gezeichneten wie aus dem gezogenen, in einem Zug. */
const losFeldStmt = env => env.DB.prepare(`
  SELECT u.id, u.name, u.quelle, r.biere
  FROM users u
  JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j ON j.user_id = u.id
  JOIN reports r ON r.id = j.id
  WHERE u.name IS NOT NULL
    AND u.gesperrt_am IS NULL
    AND u.entfernt_am IS NULL
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
         coalesce(u.name, 'Ehemaliger') AS gewinner,
         coalesce(g.name, 'Ehemaliger') AS von,
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

/* Das `max-age` aus einem Cache-Control-Kopf, oder 0. Nachsichtig mit Absicht:
   was hier nicht herausfaellt, ist kein Fehler, sondern nur der Grund, die
   eigene Untergrenze zu nehmen. */
const alterAus = kopf => {
  const t = /max-age\s*=\s*(\d+)/i.exec(kopf || '');
  return t ? Number(t[1]) : 0;
};

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

/* Dasselbe fuers Ende, aber gegen den Anfang statt gegen die Uhr: ein Ende
   allein sagt nichts, es ist immer das Ende VON etwas. Fehlt es, entsteht die
   Vorgabe hier - deshalb gibt auch der Fall ohne Angabe ein Datum zurueck und
   nicht null, und jeder Aufrufer bekommt dieselbe Rechnung.

   Die Obergrenze ist kein Misstrauen gegen lange Abende, sondern gegen den
   Vertipper: `2026-08-12` statt `2026-08-02` im Bis-Feld haelt einen Abend
   zehn Tage lang auf "laeuft gerade". */
function pruefeEnde(roh, beginn) {
  if (roh == null) return { d: new Date(beginn.getTime() + TERMIN_DAUER_STD * 36e5) };
  const d = new Date(String(roh));
  if (isNaN(d)) return { fehler: 'Ende: ISO-8601 in UTC, etwa 2026-08-02T21:00:00Z' };
  if (d.getTime() <= beginn.getTime()) {
    return { fehler: 'Der Abend kann nicht enden, bevor er anfängt' };
  }
  if (d.getTime() - beginn.getTime() > TERMIN_DAUER_MAX * 36e5) {
    return { fehler: `Höchstens ${TERMIN_DAUER_MAX} Stunden am Stück` };
  }
  return { d };
}

/* Kommende Termine plus ein Rueckblick: der letzte Abend soll noch dastehen,
   damit man ihn bewerten kann. Abgesagte bleiben in der Liste, sie tragen ihre
   Absage sichtbar - sonst verschwindet ein Abend, unter dem Kommentare stehen. */
const termineStmt = env => env.DB.prepare(`
  SELECT t.id, t.gastgeber_id, t.beginnt_am, t.endet_am, t.titel, t.los_id,
         t.abgesagt_am, t.erstellt_von,
         coalesce(u.name, 'Ehemaliger') AS gastgeber,
         coalesce(e.name, 'Ehemaliger') AS eingetragen_von
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
  /* NULL nur bei einer Zeile, die aelter ist als Schema 10 und die Nachpflege
     nicht erwischt hat - die Seite faellt dann auf "ab HH:MM" zurueck. */
  endet_am: utc(t.endet_am),
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

/* Was gerade an Notrufen gilt. Reitet im `batch` der Bestenliste mit, laeuft
   also im Minutentakt je offener Seite - deshalb der Index auf (bis, weg_am).

   `bis > datetime('now')` ist die ganze Frist: kein Verfallslauf, kein
   Aufraeumen im Lesepfad. Eine erloschene Zeile faellt hier von selbst heraus
   und wird spaeter vom Cron geholt.

   Ehemalige stehen NICHT drin (`u.name IS NOT NULL`, nicht `coalesce`): ein
   Notruf ohne Namen waere ein Punkt auf der Karte, zu dem niemand mehr sagen
   kann, wer da steht.

   DER KREIS ENTSCHEIDET MIT, ob eine Zeile ueberhaupt herausgegeben wird
   (siehe migrations/0021). Drei Faelle, und die Reihenfolge ist die des
   Aufwands: der eigene Notruf immer, ein Notruf ohne Kreis fuer alle, sonst
   nur fuer die Eingetragenen. Der Filter steht HIER und nicht in der Seite -
   was der Worker herausgibt, ist das Einzige, was zaehlt; ein Ausblenden im
   Browser waere ein Vorhang vor offenen Daten. */
const notrufeStmt = (env, ichId) => env.DB.prepare(`
  SELECT n.id, n.user_id, n.art, n.lat, n.lon, n.genau, n.erstellt, n.bis,
         n.live, n.standort_am, u.name,
         (SELECT count(*) FROM notruf_kreis k WHERE k.notruf_id = n.id) AS kreis_gross,
         (SELECT group_concat(k.user_id) FROM notruf_kreis k WHERE k.notruf_id = n.id) AS kreis_ids
  FROM notrufe n
  JOIN users u ON u.id = n.user_id
  WHERE n.weg_am IS NULL AND n.bis > datetime('now') AND u.name IS NOT NULL
    AND (n.user_id = ?1
         OR NOT EXISTS (SELECT 1 FROM notruf_kreis k WHERE k.notruf_id = n.id)
         OR EXISTS (SELECT 1 FROM notruf_kreis k
                    WHERE k.notruf_id = n.id AND k.user_id = ?1))
  ORDER BY n.erstellt DESC
`).bind(ichId);

/* `ichId` ist der BETRACHTER, nicht der Absender. Daran haengt genau eine
   Entscheidung: die Namensliste des Kreises (`kreis_ids`) bekommt nur, wer den
   Notruf selbst abgesetzt hat - sie ist die Vorlage fuer seine eigene Auswahl.
   Ein Empfaenger erfaehrt die GROESSE des Kreises (dafuer traegt die Zeile auf
   der Tafel die Marke "nur an 3"), aber nicht, wer sonst noch darin steht: wen
   jemand um Hilfe bittet, ist seine Sache und keine Runde.

   Fehlt das zweite Argument, gibt es keine Liste. Das ist der sichere Weg
   herum - ein Aufrufer, der den Betrachter vergisst, verliert eine Bequem-
   lichkeit, statt eine Empfaengerliste auszuplaudern. */
const notrufAntwort = (n, ichId = null) => ({
  id: n.id,
  wer: n.user_id,
  name: n.name,
  art: n.art,
  lat: n.lat,
  lon: n.lon,
  genau: n.genau ?? null,
  erstellt: utc(n.erstellt),
  bis: utc(n.bis),
  /* Was versprochen wurde, und was zuletzt geliefert wurde - siehe
     migrations/0018. Die Seite macht daraus drei Zustaende; wo die Grenze
     zwischen "frisch" und "steht still" liegt, entscheidet SIE, weil das am
     Nachtragstakt ihres eigenen `watchPosition` haengt. Der Worker gibt nur
     die beiden Tatsachen heraus und behauptet nichts. */
  live: !!n.live,
  standort_am: utc(n.standort_am),
  /* null heisst "an alle" - dieselbe Aussage wie die fehlende Zeile in
     `notruf_kreis`, nur eine Schicht weiter oben. Die Tafel malt die Marke
     genau dann, wenn hier eine Zahl steht. */
  kreis: n.kreis_gross ? n.kreis_gross : null,
  ...(ichId != null && n.user_id === ichId && n.kreis_ids
    ? { kreis_wer: String(n.kreis_ids).split(',').map(Number) }
    : {}),
});

/* Der Weg dorthin. Steht im Worker und nicht in der Seite, weil ihn beide
   brauchen - die Karte unter dem Finger und die Mail im Bett - und zwei
   Fassungen desselben Links laufen auseinander.

   `dir/?api=1&destination=` ist die dokumentierte, plattformuebergreifende
   Form: auf dem Handy uebernimmt die Maps-App mit gesetztem Ziel, am Rechner
   der Browser. Sechs Nachkommastellen sind gut ein Zehntelmeter - mehr waere
   eine Genauigkeit, die keine Ortung hergibt. */
const mapsLink = (lat, lon) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}`;

/* Lat/Lon/Genau aus dem Rumpf lesen und pruefen - fuer den neuen Notruf UND
   das Nachtragen des Standorts an einem laufenden. Ein Fehlerstring statt
   Wurf: beide Aufrufer geben ihn unveraendert an `fehler()` weiter, und ein
   `throw` haette hier nur eine zweite Fehlerform in den Code gebracht. */
/* Wer waehlbar ist. Dieselben vier Bedingungen wie der Mailkreis in
   `benachrichtige()` - wer keine Post bekommen kann, hat in einer Auswahl
   nichts verloren, sonst haekelt jemand einen Namen an, der nie erfaehrt,
   dass er gemeint war. Der Absender selbst faellt heraus (`id <> ?`): sich
   selbst zu rufen ist keine Auswahl, es ist ein Tippfehler.

   NACH NAMEN sortiert und nicht nach Bestand: das hier ist ein Adressbuch,
   keine Bestenliste, und wer jemanden sucht, sucht ihn alphabetisch. */
const kreisWaehlbarStmt = (env, ichId) => env.DB.prepare(`
  SELECT id, name FROM users
  WHERE id <> ? AND name IS NOT NULL
    AND gesperrt_am IS NULL AND entfernt_am IS NULL
  ORDER BY name COLLATE NOCASE
`).bind(ichId);

/* Den gewuenschten Kreis aus dem Rumpf lesen. Gibt `{ fehler }` oder
   `{ ids }`, wobei `ids === null` "an alle" heisst.

   DREI EINGABEN, DREI BEDEUTUNGEN, und die Asymmetrie ist Absicht:

     kein `kreis` / null   an alle - so wie jeder Notruf vor dieser Migration
     [1, 7, 12]            nur an diese
     []                    Fehler, kein "an niemanden"

   Die leere Liste ist der gefaehrliche Fall: ein Fehler in der Seite, der ein
   leeres Feld schickt, wuerde sonst einen Notruf anlegen, den NIEMAND sieht -
   ein Hilferuf ins Leere, der auf der eigenen Tafel trotzdem so aussieht, als
   waere er raus. Also 400 statt Stille.

   Geprueft wird gegen `kreisWaehlbarStmt`, nicht nur auf "ist eine Zahl":
   sonst legte ein erfundener Wert Zeilen an, die auf niemanden zeigen, und
   der Absender saehe einen Kreis von vier, von denen drei nie existiert
   haben. */
async function notrufKreis(daten, env, ichId) {
  const roh = daten.kreis;
  if (roh === undefined || roh === null) return { ids: null };
  if (!Array.isArray(roh)) return { fehler: 'kreis: eine Liste von Ids oder null' };
  if (!roh.length) return { fehler: 'kreis: mindestens einer - sonst sieht ihn niemand' };

  const gewuenscht = new Set();
  for (const w of roh) {
    const id = Number(w);
    if (!Number.isInteger(id)) return { fehler: 'kreis: nur Ids' };
    if (id !== ichId) gewuenscht.add(id);
  }

  const waehlbar = await kreisWaehlbarStmt(env, ichId).all();
  const ids = waehlbar.results.filter(u => gewuenscht.has(u.id)).map(u => u.id);
  if (!ids.length) return { fehler: 'kreis: niemand davon ist wählbar' };
  return { ids };
}

/* Den Kreis EINES Notrufs nachlesen, in der Form, die `notrufAntwort` erwartet.
   Braucht jede Route, die eine Zeile per `RETURNING` zurueckbekommt: SQLite
   laesst in `RETURNING` keine Unterabfragen zu, der Kreis kann dort also nicht
   mitreisen. Eine Zeile ueber den Primaerschluessel - das ist billiger als die
   Ueberlegung, ob man es sich sparen kann. */
const kreisLesen = (env, notrufId) => env.DB.prepare(`
  SELECT count(*) AS kreis_gross, group_concat(user_id) AS kreis_ids
  FROM notruf_kreis WHERE notruf_id = ?
`).bind(notrufId).first();

/* Den Kreis schreiben. Immer ersetzend, nie ergaenzend: die Seite schickt den
   Zustand, den sie zeigt, und nicht die Aenderung dazu - dann kann ein
   verlorener Ruf hoechstens eine alte Wahrheit stehen lassen, aber nie zwei
   Aenderungen halb ausfuehren. `ids === null` raeumt den Kreis ab und macht
   daraus wieder einen Notruf an alle. */
function kreisSetzen(env, notrufId, ids) {
  const schritte = [env.DB.prepare('DELETE FROM notruf_kreis WHERE notruf_id = ?').bind(notrufId)];
  if (ids) {
    for (const id of ids) {
      schritte.push(env.DB.prepare(
        'INSERT INTO notruf_kreis (notruf_id, user_id) VALUES (?, ?)').bind(notrufId, id));
    }
  }
  return env.DB.batch(schritte);
}

/* Die Post zum Notruf. Steht hier und nicht in der Route, weil sie zweimal
   gebraucht wird: beim Absetzen und beim spaeteren Dazunehmen.

   Beim Dazunehmen wird BEWUSST wieder der ganze Kreis angeschrieben und nicht
   die Differenz - `mail_einmal` (UNIQUE ueber user_id, art, bezug) laesst nur
   die durch, die diese Mail noch nicht haben. Damit ist die Doppelmail eine
   Frage des Schemas und nicht eine Rechnung, die jemand richtig hinbekommen
   muss. Nebenwirkung, die richtig ist: wer weggenommen und wieder dazugenommen
   wird, bekommt keine zweite Mail - er bekommt die Karte zurueck, und die ist
   der lebende Teil der Auskunft. */
function notrufPost(env, ctx, ich, notrufId, art, lat, lon, empfaenger) {
  const wohin = mapsLink(lat, lon);
  const was = art === 'bier' ? `${ich.name} braucht Bier`
    : art === 'kamerad' ? `${ich.name} sucht Gesellschaft`
    : `${ich.name} braucht Bier und Gesellschaft`;
  benachrichtige(env, ctx, 'notruf', empfaenger, {
    bezug: `notruf:${notrufId}`,
    betreff: was,
    text: `${was}.\n\nHin geht es hier: ${wohin}`
      + `\n\nAuf der Tafel steht der Notruf ${NOTRUF_MINUTEN} Minuten lang: ${env.SEITE}`,
    html: `<p><strong>${nurText(was)}.</strong></p>`
      + mailKnopf(wohin, 'Route öffnen')
      + `<p style="font-size:13px;color:#6f6653">Auf der Tafel steht der Notruf `
      + `${NOTRUF_MINUTEN} Minuten lang.</p>`
      + mailKnopf(env.SEITE, 'Zur Tafel'),
  });
}

function notrufKoordinaten(daten) {
  const lat = Number(daten.lat), lon = Number(daten.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { fehler: 'lat/lon: Grad als Zahl, lat -90..90, lon -180..180' };
  }
  /* Was der Browser ueber seine eigene Genauigkeit sagt, in Metern. Der
     Deckel ist grosszuegig: eine reine IP-Ortung meldet gern 20 km, und die
     soll durchkommen duerfen - die Karte zeigt dann eben einen sehr grossen
     Kreis, was genau die richtige Auskunft ist. */
  const rohGenau = Number(daten.genau);
  const genau = Number.isFinite(rohGenau)
    ? Math.min(50000, Math.max(0, Math.round(rohGenau))) : null;
  return { lat, lon, genau };
}

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
    endet_am: t ? utc(t.endet_am) : null,
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
   leer sind, und `avg()` uebergeht sie von selbst.

   Sind ALLE leer, ist das kein Fehler, sondern die Ruecknahme: `leer` faellt
   mit heraus und die Route loescht die Zeile. Vorher stand hier ein Abweisen
   mit dem Verweis "dafuer gibt es das Loeschen" - das es nie gab. Wer seine
   einzige Kategorie noch einmal antippte, kam damit nicht mehr heraus. */
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
  return { sterne, leer: !gesetzt };
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
  // GIF87a oder GIF89a - die sechs Bytes stehen fuer beide Varianten fest.
  const sechs = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
  if (sechs === 'GIF87a' || sechs === 'GIF89a') return ['image/gif', 'gif'];
  return null;
}

/* Was aus dem Upload zurueckkommt und beim Abschicken wieder hereinkommt.
   Streng geprueft, weil der Wert ungeprueft in einen R2-Aufruf ginge. */
const BILD_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

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

// ---------------------------------------------------------------------------
// Die Link-Vorschau (Migration 0022, ideas/plan-link-vorschau.md)
// ---------------------------------------------------------------------------

/* EINE ERKENNUNG, NICHT ZWEI. Der Worker muss aus demselben Text dieselbe
   Adresse ziehen wie die Seite - sonst zeigt die Karte auf `https://x.de/y.`
   (mit Punkt), waehrend der Link daneben auf `https://x.de/y` zeigt, und
   `url_hash` trifft die vorhandene Zeile nie. Regexp UND `linkPutzen` stehen
   deshalb in `index.html` woertlich genauso; wer eines von beiden anfasst,
   fasst beide an. Zwei Sprachen, eine Regel - ein gemeinsames Modul geht nicht,
   die Seite ist eine geschlossene Datei. */
const LINK_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/* Satzzeichen am Ende gehoeren dem Satz. Steht WOERTLICH auch in `index.html`. */
function linkPutzen(roh) {
  while (/[.,;:!?»"']$/.test(roh)) roh = roh.slice(0, -1);
  if (roh.endsWith(')') && !roh.includes('(')) roh = roh.slice(0, -1);
  return roh;
}

/* Der ERSTE Link im Text, mehr nicht - ein Kommentar bekommt hoechstens eine
   Karte. `matchAll` und nicht `exec`: das klont die Regexp, waehrend `exec` auf
   einem `/g`-Muster `lastIndex` behaelt. Der bliebe im Isolat zwischen zwei
   Anfragen stehen, und dann faende der zweite Kommentar seinen Link nicht. */
function linkAusText(text) {
  for (const t of String(text || '').matchAll(LINK_RE)) {
    const roh = linkPutzen(t[0]);
    if (roh) return roh;
  }
  return null;
}

/* Darf der Worker diese Adresse abrufen? Das Gegenstueck zu der Regel an
   /api/gif/holen, wo der Worker die Adresse selbst baut. Hier kommt sie vom
   Nutzer, also muss sie durch ein Gatter. WER HIER KUERZT, BAUT DEN OFFENEN
   PROXY.

   Workers erreichen das lokale Netz der Edge nicht und auch keinen
   Metadatendienst - das ist aber Cloudflares Zusage, nicht unsere Pruefung.
   Was wir selbst ausschliessen: alles, was nach innen zeigt, und alles, was
   kein Web ist.

   Gibt die NORMALISIERTE Adresse zurueck (URL-Objekt, Fragment ab) oder null.
   Genau diese Form wird gehasht - siehe den Kopf von 0022. */
function darfGeholtWerden(roh) {
  let u;
  try { u = new URL(roh); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;         // http://user@evil/
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return null;
  if (h.endsWith('.internal') || h.endsWith('.home.arpa')) return null;
  if (!h.includes('.')) return null;                 // nackte Namen aus dem LAN
  if (h.includes(':') || h.startsWith('[')) return null;  // IPv6-Literale gar nicht
  /* IP-Literale: nur oeffentliche durchlassen. Namen, die auf eine private
     Adresse zeigen, faengt diese Pruefung NICHT - dagegen steht, dass ein
     Worker ohnehin nicht in ein privates Netz kommt. */
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a >= 224) return null;
  }
  u.hash = '';
  return u;
}

/* Weiterleitungen VON HAND, weil `redirect: 'follow'` das Gatter umgeht - eine
   harmlose Adresse, die auf `http://10.0.0.1/` umleitet, waere sonst frei.
   Gibt { r, u } zurueck: die Antwort und die Adresse, unter der sie kam (die
   braucht das Aufloesen relativer Bildadressen). */
async function holeMitGatter(start) {
  let u = start;
  for (let i = 0; i <= VORSCHAU_HOPS; i++) {
    const r = await fetch(u.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(VORSCHAU_ZEIT),
      headers: {
        /* Ehrlich sagen, wer klopft. Manche Seiten liefern OG-Daten nur an
           bekannte Boten, und ein Bot, der sich als Browser ausgibt, ist die
           Art Trick, die man spaeter bereut. */
        'User-Agent': 'BeerstockBot/1.0 (+https://schnix84.github.io/beerstock/)',
        'Accept': 'text/html;q=0.9,*/*;q=0.1',
        'Accept-Language': 'de,en;q=0.8',
      },
    });
    if (r.status >= 300 && r.status < 400) {
      const ort = r.headers.get('Location');
      if (!ort) return null;
      await r.body?.cancel().catch(() => {});
      const naechste = darfGeholtWerden(new URL(ort, u).href);   // JEDER Sprung neu
      if (!naechste) return null;
      u = naechste;
      continue;
    }
    return { r, u };
  }
  return null;      // im Kreis
}

/* Liest og:title/og:description/og:image und faellt auf <title> zurueck.
   Twitter-Karten als zweite Quelle: manche Seiten pflegen nur die.

   `HTMLRewriter` ist Cloudflares eigener, streamender Parser: kein Regex auf
   HTML, keine Abhaengigkeit. Der Rumpf laeuft durch einen mitzaehlenden
   `TransformStream`, der abbricht, sobald `genug` steht (Kopf durch oder alle
   drei Felder da) - und spaetestens bei VORSCHAU_HTML_MAX. Behalten wird
   nichts: der Leser unten wirft jedes Stueck weg, er treibt nur die Haken an. */
async function ogLesen(antwort, basis) {
  const d = { titel: null, text: null, bild: null };
  let imTitel = false;
  let rohTitel = '';
  /* Woran das Lesen endet, im Regelfall: alle drei Felder stehen, oder der
     Kopf ist durch. Was danach kommt, ist der Rumpf - dort steht nichts mehr,
     was diese Karte braucht. Bei einer gewoehnlichen Seite sind das die ersten
     paar Kilobyte, VORSCHAU_HTML_MAX kommt gar nicht erst vor. */
  let genug = false;

  const nimm = (feld, wert) => {
    const w = (wert || '').trim();
    if (w && !d[feld]) d[feld] = w;
    if (d.titel && d.text && d.bild) genug = true;
  };

  const rw = new HTMLRewriter()
    .on('meta', { element(e) {
      const n = (e.getAttribute('property') || e.getAttribute('name') || '').toLowerCase();
      const c = e.getAttribute('content');
      if (n === 'og:title' || n === 'twitter:title') nimm('titel', c);
      else if (n === 'og:description' || n === 'twitter:description' || n === 'description') nimm('text', c);
      else if (n === 'og:image' || n === 'og:image:url' || n === 'twitter:image') nimm('bild', c);
    } })
    /* `head > title`, NICHT `title`: ein Inline-SVG bringt eigene `<title>`
       mit (Barrierefreiheit), und die traf der nackte Selektor mit. Die
       Beerstock-Seite selbst war der Beweis - aus `<title>Kaltes Bier</title>`
       plus dem `<title>` im Bierglas-SVG wurde ein zusammengeklebtes
       "Kaltes BierBierglas: Fuellstand nach Bestand …". Der Dokumenttitel ist
       immer ein direktes Kind von `<head>`, ein SVG-Titel nie. */
    .on('head > title', {
      element(e) {
        imTitel = true;
        // Zu Ende gelesen ist zu Ende gelesen: ein zweites `<title>` im Kopf
        // (kommt vor, etwa nach einem Fehler im Vorlagenwerk) haengt sonst an.
        e.onEndTag(() => { imTitel = false; });
      },
      /* `<title>` kommt in Stuecken. Gesammelt wird in `rohTitel` und nicht in
         `d.titel`, damit `nimm()` weiter gilt: og:title schlaegt den Titel des
         Dokuments, egal welches von beidem zuerst durchlaeuft. */
      text(t) { if (imTitel) rohTitel += t.text; },
    })
    .on('head', { element(e) { e.onEndTag(() => { genug = true; }); } });

  let gelesen = 0;
  const zaehlend = new TransformStream({
    transform(stueck, steuerung) {
      // `genug` setzen die Haken oben, waehrend die Stuecke durchlaufen - die
      // Bremse greift also ein Stueck spaeter, und das reicht.
      if (genug) { steuerung.terminate(); return; }
      gelesen += stueck.byteLength;
      if (gelesen > VORSCHAU_HTML_MAX) { steuerung.terminate(); return; }
      steuerung.enqueue(stueck);
    },
  });

  try {
    const durch = rw.transform(new Response(antwort.body.pipeThrough(zaehlend), {
      // Die Kopfzeilen mitgeben: an ihnen haengt der Zeichensatz.
      headers: antwort.headers,
    }));
    const leser = durch.body.getReader();
    // Treiben, nicht sammeln: die Haken oben laufen beim Lesen, die Bytes
    // selbst braucht niemand.
    for (;;) { const { done } = await leser.read(); if (done) break; }
  } catch {
    /* Ein abgeschnittener Rumpf endet mitten im Dokument - das ist der
       gewollte Fall, kein Fehler. Was bis dahin im Kopf stand, steht in `d`. */
  }

  nimm('titel', rohTitel);
  if (d.text && d.text.length > VORSCHAU_TEXT_MAX) {
    d.text = d.text.slice(0, VORSCHAU_TEXT_MAX - 1) + '…';
  }
  if (d.titel && d.titel.length > 200) d.titel = d.titel.slice(0, 199) + '…';
  // Relative Bildadressen kommen vor. Und sie muessen dasselbe Gatter passieren.
  if (d.bild) {
    let abs = null;
    try { abs = darfGeholtWerden(new URL(d.bild, basis).href); } catch {}
    d.bild = abs ? abs.href : null;
  }
  return d;
}

/* Das Vorschaubild nach R2 - dieselbe Strecke, die /api/gif/holen schon
   faehrt: holen, `bildTyp()` auf die BYTES (nicht auf den Content-Type, den
   setzt die Gegenseite), UUID plus Endung, `immutable` ablegen.

   KEIN Eintrag in `bild_uploads`. Das ist die Waisen-Liste fuer Bilder, die ein
   NUTZER hochgeladen hat und die ohne Kommentar liegenbleiben koennten. Ein
   Vorschaubild haengt an einer `vorschauen`-Zeile, die es immer gibt - es ist
   nie Waise. Umgekehrt heisst das: der bestehende Aufraeumer fasst diese
   Objekte nicht an, und das ist gewollt (siehe ideas/todo.md). */
async function vorschauBild(env, adresse) {
  if (!env.BILDER) return null;
  const ziel = darfGeholtWerden(adresse);
  if (!ziel) return null;
  const hol = await holeMitGatter(ziel).catch(() => null);
  if (!hol || !hol.r.ok) { await hol?.r.body?.cancel().catch(() => {}); return null; }

  const angesagt = Number(hol.r.headers.get('Content-Length') || 0);
  if (angesagt > BILD_MAX) { await hol.r.body?.cancel().catch(() => {}); return null; }
  const bytes = await hol.r.arrayBuffer();
  if (bytes.byteLength > BILD_MAX) return null;

  const typ = bildTyp(bytes);
  if (!typ) return null;

  const key = `${crypto.randomUUID()}.${typ[1]}`;
  await env.BILDER.put(key, bytes, {
    httpMetadata: { contentType: typ[0], cacheControl: 'public, max-age=31536000, immutable' },
  });
  return key;
}

/* Die Zeile zu einer Adresse - vorhanden oder frisch geholt. Gibt die `id`
   zurueck, wenn eine Karte daran haengt, sonst null.

   Erst nachschlagen: der zweite Poster desselben Links loest gar keinen Abruf
   mehr aus. Eine Zeile mit `fehler` gilt dabei als Antwort - ein toter Link
   bleibt tot, und ohne diese Sperre versuchte es der Worker bei jedem neuen
   Kommentar wieder.

   `nurCache` ist der Weg der gebremsten Tippvorschau: nachschlagen ja, fremde
   Seite abrufen nein. Siehe VORSCHAU_TAKT. */
async function vorschauBesorgen(env, ziel, nurCache = false) {
  const schluessel = await hash(ziel.href);

  const schon = await env.DB.prepare('SELECT id, fehler FROM vorschauen WHERE url_hash = ?')
    .bind(schluessel).first();
  if (schon) return schon.fehler ? null : schon.id;
  if (nurCache) return null;

  let daten = null, fehlerText = null, bildKey = null;
  /* Was unter der Karte steht, ist der Host am ENDE der Umleitungskette, nicht
     der getippte: bei `youtu.be/…` oder einem Kuerzel sagt der getippte dem
     Leser nichts. Die `url` bleibt trotzdem die getippte - der Klick soll dort
     landen, wo auch der Link im Text hinzeigt. */
  let endHost = ziel.hostname;
  try {
    const hol = await holeMitGatter(ziel);
    if (hol) endHost = hol.u.hostname;
    if (!hol) fehlerText = 'nicht erreichbar';
    else if (!hol.r.ok) {
      await hol.r.body?.cancel().catch(() => {});
      fehlerText = `HTTP ${hol.r.status}`;
    } else {
      /* Nur HTML wird geparst. Ohne diese Schranke liefe ein verlinktes Video
         durch den Rewriter - fuenf Sekunden Leitung fuer nichts. */
      const typ = (hol.r.headers.get('Content-Type') || '').toLowerCase();
      if (!/^\s*(text\/html|application\/xhtml\+xml)/.test(typ)) {
        await hol.r.body?.cancel().catch(() => {});
        fehlerText = 'kein HTML';
      } else {
        daten = await ogLesen(hol.r, hol.u);
        if (!daten.titel && !daten.text) fehlerText = 'nichts zu zeigen';
        else if (daten.bild) bildKey = await vorschauBild(env, daten.bild);
      }
    }
  } catch (e) {
    fehlerText = String(e && e.message || e).slice(0, 120);
  }

  /* ON CONFLICT, weil derselbe Link im Freundeskreis gleichzeitig zweimal
     gepostet werden kann - genau der Fall, fuer den die Tabelle gebaut ist.
     Beide verfehlen dann oben das SELECT und landen hier. Der zweite bekommt
     ueber RETURNING die Zeile des ersten, statt am UNIQUE stumm zu sterben.
     Ein Fehlversuch ueberschreibt dabei NIE eine gelungene Zeile (DO NOTHING);
     dann liefert RETURNING nichts, und der Nachschlag darunter holt sie. */
  const zeile = fehlerText
    ? await env.DB.prepare(`
        INSERT INTO vorschauen (url_hash, url, fehler) VALUES (?, ?, ?)
        ON CONFLICT(url_hash) DO NOTHING
        RETURNING id, fehler, bild_key
      `).bind(schluessel, ziel.href, fehlerText).first()
    : await env.DB.prepare(`
        INSERT INTO vorschauen (url_hash, url, titel, text, host, bild_key)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(url_hash) DO UPDATE SET url = excluded.url
        RETURNING id, fehler, bild_key
      `).bind(schluessel, ziel.href, daten.titel, daten.text,
              endHost.replace(/^www\./, ''), bildKey).first();

  const fertig = zeile
    || await env.DB.prepare('SELECT id, fehler, bild_key FROM vorschauen WHERE url_hash = ?')
      .bind(schluessel).first();
  if (!fertig) return null;

  /* Hat das Rennen ein anderer gewonnen, liegt unser frisch abgelegtes Bild
     ohne Zeile im Bucket. Es kommt weg - sonst waere es genau die Waise, die
     der Aufraeumer nie sieht. */
  if (bildKey && fertig.bild_key !== bildKey && env.BILDER) {
    await env.BILDER.delete(bildKey).catch(() => {});
  }
  return fertig.fehler ? null : fertig.id;
}

/* Nach der Antwort, nie davor: das Abschicken bleibt eine schnelle
   JSON-Anfrage. Ist die Karte da, schiebt der Verteiler sie nach - der
   Kommentar steht sofort, die Karte klappt kurz darauf auf, genau wie bei
   Teams.

   Meist ist das inzwischen keine Sekunde mehr, sondern ein Wimpernschlag: die
   Tippvorschau (POST /api/vorschau) hat die Zeile schon geholt, waehrend der
   Satz noch geschrieben wurde, und hier bleibt nur das Nachschlagen. Die
   Sekunde gilt noch fuer den, der einen Link einfuegt und sofort abschickt.

   Stumm wie `benachrichtige()`: ein Kommentar darf nicht daran scheitern, dass
   eine fremde Seite gerade nicht mag.

   Gemeldet wird hier von Hand statt ueber `anstoss()` - der ruft selbst
   `ctx.waitUntil()`, und das eine `waitUntil` im anderen zu verschachteln,
   nachdem die Antwort laengst raus ist, ist nirgends sonst im Worker gebaut.
   `stub.melden(...)` liegt so im selben Auftrag. */
function vorschauHolen(request, env, ctx, kommentarId, text, ziel) {
  if (!ctx || !env.DB) return;
  const roh = linkAusText(text);
  if (!roh) return;
  const adresse = darfGeholtWerden(roh);
  if (!adresse) return;

  ctx.waitUntil((async () => {
    try {
      const id = await vorschauBesorgen(env, adresse);
      if (!id) return;
      /* Nur, wenn an der Karte noch GENAU DER TEXT steht, aus dem dieser Link
         kam. Wer zweimal schnell hintereinander aendert, hat sonst zwei Abrufe
         unterwegs, und der langsamere haengt seine Karte unter den neuen Satz.
         `geloescht_am` faengt denselben Fall fuer die Loeschung. */
      const auf = await env.DB.prepare(`
        UPDATE kommentare SET vorschau_id = ?
        WHERE id = ? AND text = ? AND vorschau_id IS NULL AND geloescht_am IS NULL
      `).bind(id, kommentarId, text).run();
      if (!auf.meta.changes) return;
      if (!env.TAFEL) return;
      /* `von` bleibt NULL - und das ist der eine Ruf im ganzen Worker, bei dem
         das so sein muss. Sonst reicht `anstoss()` die Tab-Kennung des
         Schreibers durch, und die Seite verwirft die eigene Meldung
         (`index.html`, `d.von === TAB`) - richtig ueberall dort, wo der
         Schreiber die Antwort seines POSTs schon hat. Hier hat er sie eben
         NICHT: die Karte entsteht lange nach der Antwort, und der Poster waere
         als einziger der, der sie nicht zu sehen bekommt. */
      const stub = env.TAFEL.get(env.TAFEL.idFromName('tafel'));
      await stub.melden([`${ziel.art}:${ziel.id}`], null);
    } catch (e) {
      console.log('vorschau:', e && e.message || e);
    }
  })());
}

/* Die ROHE Imgflip-Liste, einmal am Tag geholt und in caches.default
   vorgehalten - `id`, `name`, `width`, `height` UND `url`. Beide Meme-Routen
   brauchen sie: die eine zeigt sie abgespeckt (ohne `url`, die bleibt intern),
   die andere prueft eine angefragte `id` dagegen und braucht dafuer die echte
   Bildadresse. Eine Funktion statt zweier eigener Caches, damit beide Routen
   garantiert denselben Stand sehen. */
async function memeVorlagenRoh(env, ctx) {
  const schluessel = new Request('https://meme.invalid/vorlagen-roh');
  const lager = caches.default;
  const schon = await lager.match(schluessel);
  if (schon) return schon.json();

  const oben = await fetch('https://api.imgflip.com/get_memes');
  if (!oben.ok) return null;
  const daten = await oben.json().catch(() => null);
  if (!daten?.success) return null;

  const memes = daten.data?.memes || [];
  if (ctx) ctx.waitUntil(lager.put(schluessel, new Response(JSON.stringify(memes), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${MEME_VORLAGEN_TTL}`,
    },
  })));
  return memes;
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

/* Der Baum, fertig zusammengesteckt. Zwei Abfragen in einem batch, weil eine
   verschachtelte SQL-Fassung dieselbe Arbeit in einer schlechter lesbaren Form
   taete: die Kommentare, und die Reaktionen dazu.

   Die Reaktionen kommen ROH, Zeile fuer Zeile mit Namen - nicht gezaehlt. Die
   Seite zeigt auf Tippen, wer wie reagiert hat, und dafuer ist die Zahl allein
   zu wenig. Gezaehlt wird jetzt beim Zusammenstecken, und die eigene Reaktion
   faellt dabei ab: die dritte Abfrage (nur die eigenen) ist damit weg. */
const baumStmts = (env, ziel) => [
  /* `k.sterne` ist der Schnappschuss aus dem Moment des Absendens, kein Join
     auf `bewertungen` - die Zeile dort wird ueberschrieben, die Karte hier
     soll stehen bleiben (siehe 0009_sterne_am_kommentar.sql). */
  /* `coalesce(..., 'Ehemaliger')` an jeder Stelle, wo ein Name zum Anzeigen
     geholt wird: wer entfernt wurde, hat keinen mehr (weiche Loeschung, siehe
     0011), seine Beitraege bleiben aber stehen - sonst risse ein Austritt die
     halbe Chronik mit. Ein Kommentar von `null` saehe wie ein Fehler aus. */
  /* `an_id` samt Namen: wem die Antwort galt (siehe 0020). Der Join geht ueber
     die angesprochene KARTE auf deren Autor - der Name kommt also auch dann
     noch, wenn diese Karte inzwischen weich geloescht ist. Ihr Text nicht, der
     wird hier gar nicht geholt: die Marke nennt einen Namen, sie zitiert
     nicht. */
  env.DB.prepare(`
    SELECT k.id, k.autor_id, k.antwort_auf, k.an_id, k.text, k.erstellt, k.geaendert,
           k.geloescht_am, k.bild_key, k.sterne,
           coalesce(u.name, 'Ehemaliger') AS autor,
           au.name AS an_autor,
           v.url AS v_url, v.titel AS v_titel, v.text AS v_text,
           v.host AS v_host, v.bild_key AS v_bild, v.fehler AS v_fehler
    FROM kommentare k
    JOIN users u ON u.id = k.autor_id
    LEFT JOIN kommentare ak ON ak.id = k.an_id
    LEFT JOIN users au ON au.id = ak.autor_id
    LEFT JOIN vorschauen v ON v.id = k.vorschau_id
    WHERE k.ziel_art = ? AND k.ziel_id = ?
    ORDER BY k.id DESC
    LIMIT ?
  `).bind(ziel.art, ziel.id, KOMMENTARE_ZIEL),
  env.DB.prepare(`
    SELECT r.kommentar_id, r.art, r.autor_id, coalesce(u.name, 'Ehemaliger') AS autor
    FROM reaktionen r
    JOIN kommentare k ON k.id = r.kommentar_id
    JOIN users u ON u.id = r.autor_id
    WHERE k.ziel_art = ? AND k.ziel_id = ?
    ORDER BY r.erstellt
  `).bind(ziel.art, ziel.id),
];

function baumBauen(zeilen, reaktionen, ichId, env) {
  // Je Kommentar eine Map art -> Gruppe, damit die Namen in der Reihenfolge
  // stehen, in der reagiert wurde - wer zuerst kam, steht vorn.
  const proKommentar = new Map();
  for (const r of reaktionen) {
    if (!proKommentar.has(r.kommentar_id)) proKommentar.set(r.kommentar_id, new Map());
    const je = proKommentar.get(r.kommentar_id);
    if (!je.has(r.art)) je.set(r.art, { art: r.art, anzahl: 0, meins: false, namen: [] });
    const g = je.get(r.art);
    g.anzahl++;
    g.namen.push(r.autor);
    if (r.autor_id === ichId) g.meins = true;
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
      /* Die Vorschaukarte zum ersten Link im Text. Dieselbe Bedingung wie
         oben - was an einer geloeschten Karte nicht mehr steht, steht auch
         hier nicht mehr; sonst haenge unter "gelöscht" noch der Link. Und
         `v_fehler` heisst: die Zeile gibt es nur, damit nicht dauernd neu
         versucht wird, zu zeigen ist daran nichts. */
      vorschau: (weg || !z.v_url || z.v_fehler) ? null : {
        url: z.v_url,
        titel: z.v_titel,
        text: z.v_text,
        host: z.v_host,
        bild: bildUrl(env, z.v_bild),
      },
      geloescht: weg,
      erstellt: utc(z.erstellt),
      geaendert: utc(z.geaendert),
      /* Wem sie galt. Ohne `an_id` gibt es hier nichts zu sagen - das ist bei
         jeder Antwort von vor 0020 so, und die Seite bleibt dann stumm. */
      an_id: z.an_id || null,
      an_autor: z.an_id ? (z.an_autor || 'Ehemaliger') : null,
      meins: z.autor_id === ichId,
      sterne: weg ? null : sterne,
      reaktionen: [...(proKommentar.get(z.id) || new Map()).values()],
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
  /* Die Antworten stehen FLACH unter ihrer Wurzel - eine Einrueckungsebene,
     dabei bleibt es. Ihre Reihenfolge ist aber nicht mehr die reine Uhrzeit,
     sondern der Faden: eine Antwort steht direkt hinter der Karte, der sie
     gilt, und hinter deren eigenen Antworten. Sonst rutscht eine Antwort auf
     eine Antwort ans Ende der Liste, beliebig weit weg von dem, worauf sie
     sich bezieht - dazwischen dann Karten, die damit nichts zu tun haben.

     Gebaut wird also ein Baum ueber `an_id` und danach der Reihe nach
     ausgelegt (Tiefe zuerst). Die Marke "an Basti" auf der Karte und diese
     Reihenfolge sind dasselbe Anliegen von zwei Seiten: das eine sagt WEM,
     das andere stellt sie DAZU.

     Zwei Faelle fallen auf die Wurzel zurueck: Antworten von vor Migration
     0020 (kein `an_id`) und solche, deren angesprochene Karte jenseits der
     200er-Grenze liegt. Beide sind damit gewoehnliche Kinder der Wurzel und
     stehen chronologisch - das ist genau der Stand von vorher. */
  const kinder = new Map();
  for (const z of nachAlter) {
    if (!z.antwort_auf) continue;
    // Haengt die Wurzel jenseits der 200er-Grenze, faellt die Antwort mit weg.
    if (!nachId.has(z.antwort_auf)) continue;
    const k = karte(z);
    /* In `nachId` MIT: eine spaetere Antwort darf auf diese hier zeigen. Weil
       `nachAlter` chronologisch laeuft und `an_id` immer auf etwas Aelteres
       zeigt, ist die angesprochene Karte hier schon eingetragen - und ein
       Kreis kann so gar nicht erst entstehen. */
    nachId.set(z.id, k);
    const vater = (z.an_id && nachId.has(z.an_id)) ? z.an_id : z.antwort_auf;
    if (!kinder.has(vater)) kinder.set(vater, []);
    kinder.get(vater).push(k);
  }
  const auslegen = (id, raus) => {
    for (const k of kinder.get(id) || []) { raus.push(k); auslegen(k.id, raus); }
  };
  for (const w of wurzeln) auslegen(w.id, w.antworten);
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
// Die Statistik der Runde
//
// Sieben Abfragen, die zwei Routen gemeinsam haben: `/api/statistik` fuer jeden
// Angemeldeten und `/api/admin/statistik`, das nur noch den Betrieb anhaengt.
// Sie stehen hier und nicht in den Routen, damit es sie EINMAL gibt - zweimal
// dasselbe SQL laeuft auseinander, sobald eine der beiden Seiten etwas
// dazubekommt.
//
// Zurueckgegeben werden vorbereitete Statements, keine Ergebnisse: so bleibt
// die Wahl, was noch mit in denselben `batch` geht, bei der Route. Ein Aufruf
// pro Seitenansicht, nicht zwei.
// ---------------------------------------------------------------------------

/* Der Wunsch der Seite gegen die Liste erlaubter Zahlen. Was durchfaellt,
   wird zur Vorgabe - eine 400er-Antwort waere hier Ballast: der Nutzer hat
   sich nicht vertippt, das kann nur eine Seite gewesen sein, die etwas
   anderes will, als es gibt. */
const statistikFenster = (request) => {
  const gewuenscht = Number(new URL(request.url).searchParams.get('tage'));
  const tage = STATISTIK_TAGE.includes(gewuenscht) ? gewuenscht : STATISTIK_TAGE[0];
  return { tage, fenster: `-${tage} days` };
};

// Wie viele es sind. Die Admin-Route schneidet ihren eigenen Teil hinter
// dieser Marke ab - eine Zahl von Hand waere beim naechsten Bild falsch.
const STATISTIK_ABFRAGEN = 8;

const statistikAbfragen = (env, fenster) => [
  // 1 — Meldungen je Tag. Flaechenkurve.
  env.DB.prepare(`
    SELECT date(gemeldet_am) AS tag, count(*) AS n FROM reports
    WHERE gemeldet_am > datetime('now', ?1)
    GROUP BY tag ORDER BY tag
  `).bind(fenster),
  /* 2 — Bestand UND Temperatur je Melder, beide aus derselben Zeile: der
     LETZTE Wert des Tages, nicht der Schnitt. Wer nachmittags nachlegt, soll
     abends seinen Bestand sehen und nicht die Mitte zwischen vorher und
     nachher; eine gemittelte Bestandskurve waere eine Kurve, die es nie gab.
     Fuer die Temperatur gilt dieselbe Regel, damit es nur EINE zu erklaeren
     gibt - aber ein Kuehlschrank schwankt ueber den Tag, und genau das
     verschweigt ein letzter Wert. Deshalb fahren `tief`, `hoch` und die Zahl
     der Meldungen mit: die Kurve zeigt den Stand, der Kasten die Spanne.

     Zwei Bilder aus einer Abfrage - getrennt waeren es zwei Durchlaeufe ueber
     dieselben Zeilen mit demselben `max(id)` darin. */
  env.DB.prepare(`
    SELECT r.user_id, coalesce(u.name,'Ehemaliger') AS name,
           j.tag, r.biere, r.temperatur, j.tief, j.hoch, j.n
    FROM reports r
    JOIN users u ON u.id = r.user_id
    JOIN (
      SELECT user_id, date(gemeldet_am) AS tag, max(id) AS id,
             min(temperatur) AS tief, max(temperatur) AS hoch, count(*) AS n
      FROM reports WHERE gemeldet_am > datetime('now', ?1)
      GROUP BY user_id, date(gemeldet_am)
    ) j ON j.id = r.id
    ORDER BY r.user_id, j.tag
  `).bind(fenster),
  // 3 — Wer war wie oft Gastgeber. Liegende Balken.
  env.DB.prepare(`
    SELECT coalesce(u.name,'Ehemaliger') AS name, count(*) AS n
    FROM termine t JOIN users u ON u.id = t.gastgeber_id
    WHERE t.abgesagt_am IS NULL
    GROUP BY t.gastgeber_id ORDER BY n DESC
  `),
  // 4 — Ausgang der Ziehungen. Gestapelter Balken.
  env.DB.prepare('SELECT status, count(*) AS n FROM los GROUP BY status'),
  // 4b — dasselbe je Melder: wer wurde wie oft gezogen, und was hat er daraus
  // gemacht. Der Balken daneben beantwortet nur den Anteil ueber alle; wer
  // dauernd zieht und dauernd absagt, faellt darin nicht auf.
  env.DB.prepare(`
    SELECT l.user_id, coalesce(u.name,'Ehemaliger') AS name,
           l.status, count(*) AS n
    FROM los l JOIN users u ON u.id = l.user_id
    GROUP BY l.user_id, l.status
  `),
  /* 5 — Betrieb je Woche: Kommentare, Reaktionen, Sterne. Das Fenster steht
     in jedem der drei Zweige: eines aussen um die Vereinigung herum liesse
     SQLite erst alle drei Tabellen vollstaendig lesen. */
  env.DB.prepare(`
    SELECT woche, sum(k) AS kommentare, sum(r) AS reaktionen, sum(b) AS sterne FROM (
      SELECT strftime('%Y-%W', erstellt) AS woche, 1 AS k, 0 AS r, 0 AS b
      FROM kommentare WHERE erstellt > datetime('now', ?1)
      UNION ALL
      SELECT strftime('%Y-%W', erstellt), 0, 1, 0
      FROM reaktionen WHERE erstellt > datetime('now', ?1)
      UNION ALL
      SELECT strftime('%Y-%W', erstellt), 0, 0, 1
      FROM bewertungen WHERE erstellt > datetime('now', ?1)
    ) GROUP BY woche ORDER BY woche
  `).bind(fenster),
  /* 6 — Anmeldungen je Tag, ueber die ganze Geschichte: "wie viele sind wir
     inzwischen" ist wie Gastgeber und Ziehungen oben eine Frage an die ganze
     Runde, kein Fenster. Die Seite baut daraus eine Wachstumskurve. */
  env.DB.prepare(`
    SELECT date(erstellt) AS tag, count(*) AS n FROM users
    WHERE entfernt_am IS NULL GROUP BY tag ORDER BY tag
  `),
  /* 7 — Wer wie oft einen Notruf abgesetzt hat. Liegender Balken wie beim
     Gastgeber, aber aus dem Zaehler auf `users` (Migration 0017), nicht aus
     `notrufe` selbst: die Zeilen dort raeumt der Cron spaetestens einen Tag
     nach Ablauf weg, eine Rangliste daraus waere fast immer fast leer. Kein
     Fenster, aus demselben Grund wie Gastgeber und die Ziehungen: eine
     30-Tage-Rangliste bei fuenf Leuten waere kaum eine Rangfolge.

     ANDERS als bei Gastgeber: entfernte Nutzer fallen hier ganz raus, statt
     als "Ehemaliger" stehen zu bleiben. Genau das war der Kern der alten
     Entscheidung gegen ein Notruf-Archiv - ein Zaehler, der nach dem Entfernen
     verschwindet, haeuft keine Spur an, die bleibt, wenn die Person es nicht
     mehr tut. Da Entfernen den Namen loescht, waere die Zeile ohnehin nur
     ein "Ehemaliger" ohne erkennbaren Bezug - hier lieber ganz weg. */
  env.DB.prepare(`
    SELECT name, notrufe_insgesamt AS n FROM users
    WHERE notrufe_insgesamt > 0 AND entfernt_am IS NULL ORDER BY n DESC
  `),
];

/* Aus den acht Ergebnissen die Form, die gezeichnet wird. Drei davon werden
   umgebaut, der Rest geht durch. */
const statistikRunde = (ergebnis) => {
  const [meldungen, bestand, gastgeber, lose, jeMelder, betrieb, anmeldungen, notrufe] = ergebnis;

  /* Die Kurvenschar je Nutzer buendeln - eine Linie je Melder, zweimal:
     einmal die Flaschen, einmal die Grad. Dieselbe Zeile fuellt beide, denn
     beide Zahlen stehen in derselben Meldung. */
  const kurven = new Map();
  const gradKurven = new Map();
  for (const z of bestand.results) {
    if (!kurven.has(z.user_id)) {
      kurven.set(z.user_id, { name: z.name, tage: [], werte: [] });
      gradKurven.set(z.user_id,
        { name: z.name, tage: [], werte: [], tief: [], hoch: [], n: [] });
    }
    const k = kurven.get(z.user_id);
    k.tage.push(z.tag);
    k.werte.push(z.biere);

    const g = gradKurven.get(z.user_id);
    g.tage.push(z.tag);
    g.werte.push(z.temperatur);
    g.tief.push(z.tief);
    g.hoch.push(z.hoch);
    g.n.push(z.n);
  }

  /* Eine Zeile je Melder statt einer je Melder UND Status - die Seite malt
     daraus einen liegenden Balken, und der braucht alle vier Ausgaenge
     nebeneinander. Fehlende Status stehen als 0 drin, sonst muesste die Seite
     raten, ob "kein Wert" nie oder null heisst. */
  const jeMelderZeilen = new Map();
  for (const z of jeMelder.results) {
    if (!jeMelderZeilen.has(z.user_id)) {
      jeMelderZeilen.set(z.user_id, {
        name: z.name, gezogen: 0,
        zugesagt: 0, abgelehnt: 0, verfallen: 0, offen: 0,
      });
    }
    const m = jeMelderZeilen.get(z.user_id);
    m.gezogen += z.n;
    if (z.status in m) m[z.status] = z.n;
  }

  // Kumuliert, nicht je Tag: die Frage ist "wie viele sind wir inzwischen".
  let summe = 0;
  const wachstum = anmeldungen.results.map(z => ({ tag: z.tag, n: (summe += z.n) }));

  return {
    meldungen: meldungen.results,
    bestand: [...kurven.values()],
    grad: [...gradKurven.values()],
    gastgeber: gastgeber.results,
    lose: lose.results,
    lose_je_melder: [...jeMelderZeilen.values()].sort((a, b) => b.gezogen - a.gezogen),
    betrieb: betrieb.results,
    wachstum,
    notrufe: notrufe.results,
  };
};

// ---------------------------------------------------------------------------
// Mailversand ueber AgentMail. Reine HTTP-API, kein SMTP.
// ---------------------------------------------------------------------------

/* Der eine Weg nach draussen. Beide Mails - der Magic Link an den Nutzer und
   die Meldung an den Betreiber - gehen hier durch, damit Absender, Fehlerbild
   und Protokollzeile nur an einer Stelle stehen. */
async function schickeMail(env, empfaenger, betreff, text, html, anhaenge) {
  /* Die Testinstanz. Ohne diese Weiche ist jeder lokale Testlauf eine echte
     Mail an eine echte Adresse - und beim Durchspielen des Verteilers sind
     das schnell sechs auf einen Schlag. Gesetzt wird sie nur in `.dev.vars`,
     draussen gibt es sie nicht. */
  if (env.MAIL_ATTRAPPE) {
    console.log(`[Mail-Attrappe] an ${empfaenger}: ${betreff}\n${text}`);
    /* Den Anhang im Klartext dazu: eine .ics faellt nur auf, wenn man sie
       liest - ein falsches DTSTART sieht man einer base64-Zeile nicht an.
       Der Weg zurueck geht ueber den TextDecoder, nicht ueber `atob` allein:
       `atob` gibt Latin-1 zurueck, und dann steht im Protokoll "JÃ¶rg" statt
       "Jörg" - ein Schreckmoment, der wie ein Kodierfehler aussieht und keiner
       ist. */
    for (const a of anhaenge || []) {
      const roh = Uint8Array.from(atob(a.content), z => z.charCodeAt(0));
      console.log(`[Mail-Attrappe] Anhang ${a.filename} (${a.content_type}):\n`
        + new TextDecoder().decode(roh));
    }
    return;
  }

  const r = await fetch(
    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(env.AGENTMAIL_INBOX)}/messages/send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AGENTMAIL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: empfaenger, subject: betreff, text, html,
        // Das Feld nur setzen, wenn wirklich etwas dranhaengt: ein leeres
        // Array ist zwar erlaubt, aber jede Mail traegt sonst das Geruest
        // eines Anhangs, den es nicht gibt.
        ...(anhaenge && anhaenge.length ? { attachments: anhaenge } : {}),
      }),
    });

  if (!r.ok) {
    const grund = await r.text().catch(() => '');
    throw new Error(`AgentMail ${r.status}: ${grund.slice(0, 200)}`);
  }
}

// Fremder Text im HTML-Teil einer Mail. Namen sind zwar eng geprueft, der
// lokale Teil einer Mailadresse ist es nicht - `a<b@x.de` kaeme sonst als
// Markup an.
const nurText = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function schickeLink(env, empfaenger, link) {
  const text =
`Hier entlang, dann bist du drin:

${link}

Der Link gilt ${LINK_MINUTEN} Minuten und genau einmal. Hast du ihn nicht
angefordert, ist nichts passiert - dann wirf die Mail einfach weg.`;

  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>Hier entlang, dann bist du drin:</p>
  <p><a href="${link}" style="display:inline-block;background:#2f5d4a;color:#e3d8c1;
     padding:12px 22px;border-radius:3px;text-decoration:none;letter-spacing:.15em;
     text-transform:uppercase;font-size:13px">Anmelden</a></p>
  <p style="font-size:13px;color:#6f6653">Der Link gilt ${LINK_MINUTEN} Minuten und genau
     einmal. Hast du ihn nicht angefordert, ist nichts passiert &ndash; dann wirf
     die Mail einfach weg.</p>
</div>`;

  await schickeMail(env, empfaenger, 'Dein Link zum Bierranking', text, html);
}

/* Der Mailwechsel, beide Haelften. Der Link geht an die NEUE Adresse - erst
   der Klick dort schaltet um, bis dahin gilt die alte weiter. Und die alte
   erfaehrt davon, ohne etwas tun zu muessen: wer den Wechsel nicht war, weiss
   dann, dass jemand an seinem Konto sitzt. Das ist die einzige Warnung, die
   ihn ueberhaupt noch erreichen kann. */
async function schickeWechselLink(env, empfaenger, link) {
  const text =
`Du willst kuenftig hierunter angeschrieben werden. Ein Klick, dann gilt es:

${link}

Der Link gilt ${LINK_MINUTEN} Minuten und genau einmal. Bis dahin bleibt
deine alte Adresse in Kraft. Warst du das nicht, wirf die Mail weg - dann
passiert nichts.`;

  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>Du willst k&uuml;nftig hierunter angeschrieben werden. Ein Klick, dann gilt es:</p>
  <p><a href="${link}" style="display:inline-block;background:#2f5d4a;color:#e3d8c1;
     padding:12px 22px;border-radius:3px;text-decoration:none;letter-spacing:.15em;
     text-transform:uppercase;font-size:13px">Adresse best&auml;tigen</a></p>
  <p style="font-size:13px;color:#6f6653">Der Link gilt ${LINK_MINUTEN} Minuten und genau
     einmal. Bis dahin bleibt deine alte Adresse in Kraft. Warst du das nicht, wirf
     die Mail weg &ndash; dann passiert nichts.</p>
</div>`;

  await schickeMail(env, empfaenger, 'Bestätige deine neue Adresse', text, html);
}

function warneAlteAdresse(env, ctx, alt, neu) {
  if (!ctx || !alt) return;
  const text =
`Jemand hat gerade angefordert, dass das Bierranking dich kuenftig unter

    ${neu}

anschreibt. Bestaetigt ist es noch nicht - dazu muss der Link in der Mail an
die neue Adresse geklickt werden.

Warst du das nicht: melde dich in der Runde. Solange nichts bestaetigt wurde,
gilt diese Adresse hier weiter.`;

  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>Jemand hat gerade angefordert, dass das Bierranking dich k&uuml;nftig unter
     <strong>${nurText(neu)}</strong> anschreibt.</p>
  <p>Best&auml;tigt ist es noch nicht &ndash; dazu muss der Link in der Mail an die
     neue Adresse geklickt werden.</p>
  <p style="font-size:13px;color:#6f6653">Warst du das nicht: melde dich in der Runde.
     Solange nichts best&auml;tigt wurde, gilt diese Adresse hier weiter.</p>
</div>`;

  // Stumm und nebenher: der Wechsel darf nicht daran scheitern, dass die
  // Warnung an die alte Adresse nicht ankommt (sie kann tot sein - das ist
  // oft genau der Grund fuer den Wechsel).
  ctx.waitUntil(schickeMail(env, alt, 'Deine Adresse soll sich ändern', text, html)
    .catch(e => console.error('Wechsel-Warnung:', e && e.stack || e)));
}

/* Der Betreiber erfaehrt von jedem Neuen - genau einmal, in dem Moment, in dem
   der Name steht. Frueher ginge auch (beim Einloesen des Links), die Mail
   wuesste dann aber nur die Adresse; hier steht beides drin, und wer einen Link
   einloest und dann abbricht, ist ohnehin in keiner Liste zu sehen.

   Alles daran ist stumm: kein MELDE_AN, kein Schluessel, ein Fehler bei
   AgentMail - nichts davon darf eine Anmeldung scheitern lassen. Und
   `waitUntil`, weil der Neue nicht darauf warten soll, dass der Gastgeber es
   erfaehrt. */
function meldeNeuenNutzer(env, ctx, neu) {
  if (!ctx || !env.MELDE_AN || !env.AGENTMAIL_KEY) return;

  ctx.waitUntil((async () => {
    const zahl = await env.DB
      .prepare('SELECT count(*) AS n FROM users WHERE name IS NOT NULL').first();
    const wievielter = zahl ? `${zahl.n}. ` : '';
    const wann = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const text =
`${neu.name} ist dabei - der ${wievielter}Melder.

Adresse: ${neu.email}
Angemeldet: ${wann} UTC`;

    const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p><strong>${nurText(neu.name)}</strong> ist dabei &ndash; der ${wievielter}Melder.</p>
  <p style="font-size:13px;color:#6f6653">
    Adresse: ${nurText(neu.email)}<br>Angemeldet: ${wann} UTC
  </p>
</div>`;

    await schickeMail(env, env.MELDE_AN, `Neu dabei: ${neu.name}`, text, html);
  })().catch(e => console.error('Neu-Meldung:', e && e.stack || e)));
}

// ---------------------------------------------------------------------------
// Benachrichtigungen
// ---------------------------------------------------------------------------

/* Zwei Links in den Mails kommen ohne Anmeldung aus - das Abmelden und die
   Antwort des Gewinners. Beide tragen eine Signatur statt einer Zeile in der
   Datenbank: die Signatur steht nirgends, sie wird gerechnet. Ein
   Datenbankabzug enthaelt damit weiterhin nichts Handlungsfaehiges, und ein
   Rundumschlag ist ein neues Secret (`wrangler secret put MAIL_GEHEIM`).

   32 Zeichen base64url sind 192 Bit - mehr als genug fuer etwas, das nur
   sagt, welchen Knopf jemand druecken darf. */
const b64url = puffer => btoa(String.fromCharCode(...new Uint8Array(puffer)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sig(env, zweck, id) {
  if (!env.MAIL_GEHEIM) return null;
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.MAIL_GEHEIM),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const roh = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${zweck}:${id}`));
  return b64url(roh).slice(0, 32);
}

/* Zeichenweise bis zum Ende, ohne fruehen Ausstieg: ein Vergleich, der beim
   ersten Unterschied abbricht, verraet ueber seine Laufzeit, wie viele Zeichen
   gestimmt haben. Bei 32 Zeichen ueber ein Netz ist das kaum auszunutzen -
   aber es kostet auch nichts, es richtig zu machen. */
async function sigStimmt(env, zweck, id, gegeben) {
  const soll = await sig(env, zweck, id);
  if (!soll || typeof gegeben !== 'string' || gegeben.length !== soll.length) return false;
  let ab = 0;
  for (let i = 0; i < soll.length; i++) ab |= soll.charCodeAt(i) ^ gegeben.charCodeAt(i);
  return ab === 0;
}

/* Ein Zeitpunkt, wie ihn ein Mensch liest. Die Laufzeit hat volles ICU
   einschliesslich Zeitzonen - gemessen 2026-08-03: 17:00 UTC wird im August
   zu 19:00, im Januar zu 18:00, die Sommerzeit stimmt also von selbst.
   (Weiter oben steht bei TERMIN_VORGABE_UTC noch, der Worker koenne das
   nicht. Das galt einmal; die Vorgabe bleibt trotzdem, wo sie ist - der
   Client kennt die Ortszeit des NUTZERS, wir nur die der Wohnung.) */
const alsText = dbZeit => new Date(utc(dbZeit)).toLocaleString('de-DE', {
  timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long',
  hour: '2-digit', minute: '2-digit',
});

const alsTag = dbZeit => new Date(utc(dbZeit)).toLocaleDateString('de-DE', {
  timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long',
});

// ---------------------------------------------------------------------------
// Der Kalendereintrag
//
// Eine .ics-Datei am Anhang, damit der Abend mit einem Griff im eigenen
// Kalender steht statt abgetippt zu werden.
//
// DIE TRAGENDE ENTSCHEIDUNG ist die feste `UID`: `termin-<id>@beerstock`.
// Zusammen mit einer STEIGENDEN `SEQUENCE` (Spalte `termine.fassung`, siehe
// 0012) ersetzt eine Verschiebung den vorhandenen Eintrag, statt einen zweiten
// daneben zu legen. Ohne beides stuende nach drei Verschiebungen viermal
// derselbe Abend im Kalender - genau das, was solche Mails unbrauchbar macht.
//
// METHOD:PUBLISH und NICHT REQUEST, obwohl REQUEST beim Ersetzen zuverlaessiger
// waere: REQUEST ist eine Einladung, verlangt ORGANIZER und ATTENDEE und zeigt
// im Postfach Zusagen/Absagen-Knoepfe. Deren Antwort ginge an
// `beerstock@agentmail.to` - ein Postfach, das niemand liest. Zwei Knoepfe, die
// ins Leere zeigen, sind schlimmer als ein Eintrag, den ein exotischer Client
// beim Verschieben doppelt ablegt. Zugesagt wird auf der Tafel.
// Ehrlich dazu: Apple Kalender und Google werten UID + SEQUENCE auch bei
// PUBLISH aus, andere nicht durchweg. Der Satz in der Mail sagt die Aenderung
// deshalb ohnehin im Klartext - der Anhang ist die Bequemlichkeit, nicht die
// Nachricht.
// ---------------------------------------------------------------------------

/* iCalendar ist streng: CRLF als Zeilenende, in TEXT-Werten sind
   Backslash, Semikolon, Komma und Zeilenumbruch zu maskieren, und keine Zeile
   darf laenger als 75 Oktette sein - laengere werden mit CRLF + Leerzeichen
   gefaltet. Wer eines davon auslaesst, bekommt bei kurzen Titeln scheinbar
   funktionierende Dateien und beim ersten langen eine, die der Kalender
   wortlos verwirft. */
const icsText = s => String(s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

function icsFalten(zeile) {
  const bytes = new TextEncoder().encode(zeile);
  if (bytes.length <= 75) return zeile;
  /* Gefaltet wird nach OKTETTEN, nicht nach Zeichen - und niemals mitten in
     einer UTF-8-Folge, sonst steht im Kalender ein Ersatzzeichen statt des
     Umlauts. Deshalb byteweise gezaehlt und nur an Zeichengrenzen getrennt. */
  const stuecke = [];
  let zeichen = '', laenge = 0, grenze = 75;
  for (const z of zeile) {
    const n = new TextEncoder().encode(z).length;
    if (laenge + n > grenze) {
      stuecke.push(zeichen);
      zeichen = ''; laenge = 0; grenze = 74;   // die Folgezeile traegt ein Leerzeichen
    }
    zeichen += z; laenge += n;
  }
  if (zeichen) stuecke.push(zeichen);
  return stuecke.join('\r\n ');
}

// 'YYYY-MM-DD HH:MM:SS' (UTC) -> '20260808T170000Z'. Absichtlich in UTC und
// ohne VTIMEZONE: das ist die eine Form, die jeder Client gleich versteht.
const icsZeit = dbZeit => String(dbZeit).replace(/[-:]/g, '').replace(' ', 'T') + 'Z';

function icsBauen(env, termin, abgesagt) {
  const titel = termin.titel || `Bierabend${termin.gastgeber ? ' bei ' + termin.gastgeber : ''}`;
  const zeilen = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//beerstock//Tafel//DE',
    'CALSCALE:GREGORIAN',
    `METHOD:${abgesagt ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:termin-${termin.id}@beerstock`,
    `SEQUENCE:${termin.fassung || 0}`,
    `DTSTAMP:${icsZeit(alsDbZeit(new Date()))}`,
    `DTSTART:${icsZeit(termin.beginnt_am)}`,
    // Ohne Ende faellt der Kalender auf eine Stunde zurueck - falsch fuer
    // einen Abend. `endet_am` ist seit 0010 immer gefuellt.
    `DTEND:${icsZeit(termin.endet_am
      || alsDbZeit(new Date(new Date(utc(termin.beginnt_am)).getTime()
                            + TERMIN_DAUER_STD * 36e5)))}`,
    `SUMMARY:${icsText(titel)}`,
    `DESCRIPTION:${icsText(`Steht auf der Tafel: ${env.SEITE}`)}`,
    `URL:${icsText(env.SEITE)}`,
    `STATUS:${abgesagt ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return zeilen.map(icsFalten).join('\r\n') + '\r\n';
}

/* Als Anhang, wie AgentMail ihn will: base64 des UTF-8-Textes. Der Umweg ueber
   den TextEncoder ist noetig, weil `btoa` nur Latin-1 kennt - ein "Grillen bei
   Jörg" im Titel kaeme sonst als Fehler heraus, nicht als Umlaut. */
function icsAnhang(env, termin, abgesagt) {
  const roh = new TextEncoder().encode(icsBauen(env, termin, abgesagt));
  let binaer = '';
  for (const b of roh) binaer += String.fromCharCode(b);
  return [{
    filename: 'bierabend.ics',
    content_type: `text/calendar; charset=utf-8; method=${abgesagt ? 'CANCEL' : 'PUBLISH'}`,
    content_disposition: 'attachment',
    content: btoa(binaer),
  }];
}

/* Der Rumpf jeder Mail. Dieselbe Schrift und dieselben Farben wie beim Magic
   Link - das Kontorbuch des Wirts, nicht die Tafel: eine Mail wird in einem
   fremden Programm auf weissem Grund gelesen. */
const mailRumpf = inhalt =>
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
${inhalt}
</div>`;

const mailKnopf = (link, wort) =>
`<p><a href="${link}" style="display:inline-block;background:#2f5d4a;color:#e3d8c1;
   padding:12px 22px;border-radius:3px;text-decoration:none;letter-spacing:.15em;
   text-transform:uppercase;font-size:13px">${wort}</a></p>`;

/* Der Verteiler. Zwilling von `anstoss()`: gleiche Aufrufstelle, gleiche
   Stummheit, immer `ctx.waitUntil`. Eine Zusage darf nicht daran scheitern,
   dass AgentMail 502 sagt.

   `empfaenger` ist eine Liste von Ids oder null fuer die ganze Runde.

   HIER STAND EINMAL EIN `ausser`, das den Ausloeser aus dem Kreis nahm - "wer
   selbst schreibt, weiss es schon", dasselbe Prinzip wie die X-Tab-Kennung
   beim Durable Object. Es ist weg, seit die Termin-Mails einen
   Kalendereintrag tragen: ausgerechnet der Gastgeber haette den Abend dann in
   keinem Kalender stehen. Wer nur benachrichtigt und nichts mitliefert
   (`echo`), schliesst sich weiterhin aus - aber an der Aufrufstelle, wo man
   sieht, wen es betrifft.

   `betreff`/`text`/`html` duerfen Funktionen des Empfaengers sein, und die
   Termin-Mails nutzen das: dem Ausloeser wird nicht mitgeteilt, was er selbst
   gerade getan hat, ihm wird der Anhang gereicht. Die Gewinner-Mail braucht
   den Empfaenger ohnehin - ihre Signatur haengt an ihm. */
function benachrichtige(env, ctx, art, empfaenger, opt) {
  if (!ctx || !env.AGENTMAIL_KEY) return;
  if (empfaenger && !empfaenger.length) return;
  const { betreff, text, html, bezug = null, anhaenge = null } = opt;

  ctx.waitUntil((async () => {
    /* Die drei Bedingungen aus dem Plan, an einer Stelle: keine Adresse,
       gesperrt oder entfernt heisst kein Empfaenger - der HA-Dienstnutzer
       faellt damit von selbst aus jedem Kreis. `mail_stumm_am` schlaegt
       alles, auch die Rundmail. */
    const wo = ['email IS NOT NULL', 'gesperrt_am IS NULL',
                'entfernt_am IS NULL', 'mail_stumm_am IS NULL'];
    const werte = [];
    if (empfaenger) {
      wo.push(`id IN (${empfaenger.map(() => '?').join(',')})`);
      werte.push(...empfaenger);
    }

    const kreis = await env.DB
      .prepare(`SELECT id, name, email, mail_prefs FROM users WHERE ${wo.join(' AND ')}`)
      .bind(...werte).all();

    for (const u of kreis.results) {
      if (!mailWahl(u)[art]) continue;

      /* Erst eintragen, dann schicken. Der partielle UNIQUE-Index bremst das
         Doppel: ein wiederholter Aufruf nach abgebrochener Verbindung
         schickte sonst dieselbe Termin-Mail zweimal. Rundmails tragen keinen
         Bezug und duerfen darum beliebig oft gehen. */
      let zeile;
      try {
        zeile = await env.DB.prepare(
          'INSERT INTO mail_ausgang (user_id, art, bezug) VALUES (?, ?, ?) RETURNING id')
          .bind(u.id, art, bezug).first();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) continue;   // ging schon raus
        throw e;
      }

      const marke = await sig(env, 'abmelden', u.id);
      const ab = marke ? `${env.SEITE}#stumm=${u.id}.${marke}` : null;
      /* `await` auch bei den festen Zeichenketten: die Gewinner-Mail rechnet
         ihre Signatur erst hier aus, und `sig()` ist asynchron. Ohne das
         stuende in der Mail das Wort "[object Promise]". */
      const roh  = await (typeof text  === 'function' ? text(u)  : text);
      const auge = await (typeof html  === 'function' ? html(u)  : html);

      try {
        await schickeMail(env, u.email,
          await (typeof betreff === 'function' ? betreff(u) : betreff),
          ab ? `${roh}\n\n—\nKeine Mails mehr vom Wirt: ${ab}` : roh,
          ab ? mailRumpf(`${auge}
  <p style="font-size:12px;color:#6f6653;border-top:1px solid #e0dccf;padding-top:10px">
    <a href="${ab}" style="color:#6f6653">Keine Mails mehr vom Wirt</a> &middot;
    einzeln abwählen kannst du sie unter „mein Deckel“ auf der Tafel.
  </p>`) : mailRumpf(auge),
          anhaenge);
      } catch (e) {
        /* Der Fehler bleibt an der Zeile stehen, statt den Lauf abzubrechen:
           die anderen fünf sollen ihre Mail bekommen, und im Kontor steht
           dann, welche nicht rausging. */
        console.error(`Mail ${art} an ${u.id}:`, e.message);
        await env.DB.prepare('UPDATE mail_ausgang SET fehler = ? WHERE id = ?')
          .bind(String(e.message || 'unbekannt').slice(0, 200), zeile.id).run();
      }
    }
  })().catch(e => console.error('benachrichtige:', e && e.stack || e)));
}

/* Die einzelnen Anlaesse. Sie stehen hier beieinander und nicht in den
   Routen: eine Route soll entscheiden, WANN etwas rausgeht, nicht WIE es
   klingt - und die sechs Texte nebeneinander verraten sofort, wenn einer aus
   der Reihe faellt. */

/* Die Gewinner-Mail. Sie traegt als einzige einen Link, der etwas TUT - und
   deshalb tut der Link selbst nichts: er fuehrt auf die Seite, die zwei
   Knoepfe zeigt, und erst der Klick dort schickt die Antwort. Mailscanner und
   Vorschaudienste laden Links vor; ein GET, das zusagt, waere binnen einer
   Woche einmal von einem Virenscanner beantwortet worden.

   Der Text haengt am Empfaenger, weil die Signatur es tut - darum die
   Funktionen statt fester Zeichenketten. */
function mailGewonnen(env, ctx, losId, gewinnerId) {
  // Die Signatur bindet Los UND Empfaenger: mit einem fremden Link laesst
  // sich damit weder ein anderes Los beantworten noch als jemand anderes.
  const linkFuer = async u =>
    `${env.SEITE}#los=${losId}&t=${u.id}.${await sig(env, `los:${losId}`, u.id)}`;

  benachrichtige(env, ctx, 'gewonnen', [gewinnerId], {
    bezug: `los:${losId}`,
    betreff: 'Die Flasche zeigt auf dich',
    text: async u =>
`Die Flasche hat dich getroffen — heute Abend waerst du dran.

Sag zu oder ab:
${await linkFuer(u)}

Antwortest du gar nicht, verfaellt das Los nach ${LOS_FRIST} Stunden und der
Tag ist wieder frei.`,
    html: async u => `<p>Die Flasche hat dich getroffen &ndash; heute Abend w&auml;rst du dran.</p>`
      + mailKnopf(await linkFuer(u), 'Bei mir?')
      + `<p style="font-size:13px;color:#6f6653">Antwortest du gar nicht, verf&auml;llt das Los
         nach ${LOS_FRIST} Stunden und der Tag ist wieder frei.</p>`,
  });
}

/* HIER GILT DIE REGEL "der Ausloeser bekommt seine eigene Meldung nicht"
   AUSDRUECKLICH NICHT - und das ist die einzige Ausnahme im ganzen Verteiler.

   Sie stimmt, solange eine Mail bloss NACHRICHT ist: wer selbst zusagt oder
   selbst eintraegt, weiss es schon. Seit die Termin-Mails einen
   Kalendereintrag tragen, ist sie aber mehr als das - und ausgerechnet der
   Gastgeber haette den Abend dann in keinem Kalender stehen. Wer zusagt, ist
   der, der ihn am wenigsten vergessen darf.

   Der Text nimmt darauf Ruecksicht: dem Ausloeser wird nichts mitgeteilt, was
   er gerade selbst getan hat, ihm wird der Anhang gereicht. Deshalb sind
   Betreff und Text hier Funktionen des Empfaengers. */
function mailTerminNeu(env, ctx, termin, ausloeser, wieEntstanden = 'eingetragen') {
  const wann = alsText(termin.beginnt_am);
  const wo = termin.gastgeber ? ` bei ${termin.gastgeber}` : '';
  const was = termin.titel ? `\n\nEs geht um: ${termin.titel}` : '';
  const selbst = u => u.id === ausloeser;
  const eigen = wieEntstanden === 'zugesagt'
    ? 'Du hast zugesagt'
    : 'Du hast den Abend eingetragen';

  benachrichtige(env, ctx, 'termin_neu', null, {
    bezug: `termin:${termin.id}`,
    anhaenge: icsAnhang(env, termin, false),
    betreff: u => selbst(u)
      ? `Für deinen Kalender: ${wann}${wo}`
      : `Ein Abend steht fest: ${wann}${wo}`,
    text: u => (selbst(u)
        ? `${eigen} — ${wann}${wo}.${was}\n\nIm Anhang liegt er für deinen Kalender.`
        : `${wann}${wo} wird getrunken.${was}\n\nIm Anhang liegt der Kalendereintrag.`)
      + `\n\nSteht auf der Tafel: ${env.SEITE}`,
    html: u => (selbst(u)
        ? `<p>${nurText(eigen)} &ndash; <strong>${nurText(wann)}</strong>${nurText(wo)}.</p>`
        : `<p><strong>${nurText(wann)}</strong>${nurText(wo)} wird getrunken.</p>`)
      + (termin.titel ? `<p>Es geht um: ${nurText(termin.titel)}</p>` : '')
      + '<p style="font-size:13px;color:#6f6653">'
      + (selbst(u) ? 'Im Anhang liegt er für deinen Kalender.' : 'Im Anhang liegt der Kalendereintrag.')
      + '</p>' + mailKnopf(env.SEITE, 'Zur Tafel'),
  });
}

/* Auch hier bekommt der Ausloeser seine Mail - aus demselben Grund wie oben:
   der Anhang raeumt seinen eigenen Kalendereintrag auf. Wer den Abend
   verschiebt, hat ihn selbst als Erster eingetragen; bliebe er hier aussen
   vor, stuende der Abend bei ihm zur alten Zeit und bei allen anderen zur
   neuen - das schlechteste aller Ergebnisse. */
function mailTerminAendert(env, ctx, termin, ausloeser, was) {
  const wann = alsText(termin.beginnt_am);
  const wo = termin.gastgeber ? ` bei ${termin.gastgeber}` : '';
  const abgesagt = was === 'abgesagt';
  const selbst = u => u.id === ausloeser;

  const kopf = abgesagt ? `Der Abend am ${wann}${wo} fällt aus.`
    : was === 'umbenannt'
      ? `Der Abend am ${wann}${wo} heißt jetzt: ${termin.titel || 'nichts Bestimmtes'}.`
      : `Der Abend${wo} ist jetzt am ${wann}.`;
  // Dem Ausloeser wird nichts mitgeteilt, was er selbst gerade getan hat.
  const eigen = abgesagt ? `Du hast den Abend am ${wann}${wo} abgesagt.`
    : was === 'umbenannt'
      ? `Du hast den Abend am ${wann}${wo} umbenannt.`
      : `Du hast den Abend${wo} auf ${wann} gelegt.`;

  const wort = abgesagt ? 'Fällt aus' : was === 'umbenannt' ? 'Neuer Anlass' : 'Verschoben';
  const nachsatz = abgesagt
    ? 'Der Anhang nimmt den Eintrag aus deinem Kalender.'
    : 'Der Anhang bringt deinen Kalendereintrag auf den neuen Stand.';

  benachrichtige(env, ctx, 'termin_aendert', null, {
    /* Kein fester Bezug auf den Termin allein: ein Abend darf mehrfach
       verschoben werden, und jede Verschiebung ist eine eigene Nachricht.
       Der Zeitstempel im Bezug trennt sie - der doppelte Ruf innerhalb
       derselben Sekunde bleibt gebremst, der ehrliche zweite Umzug nicht. */
    bezug: `termin:${termin.id}:${was}:${Date.now()}`,
    /* Dieselbe UID wie beim ersten Mal, aber eine hoehere SEQUENCE - damit
       ersetzt der Anhang den vorhandenen Eintrag. Bei der Absage traegt er
       METHOD:CANCEL und raeumt ihn weg. */
    anhaenge: icsAnhang(env, termin, abgesagt),
    betreff: u => selbst(u)
      ? `Für deinen Kalender: ${wort.toLowerCase()} — ${wann}${wo}`
      : `${wort}: ${wann}${wo}`,
    text: u => `${selbst(u) ? eigen : kopf}\n\n${nachsatz}\n\n`
        + `Steht auf der Tafel: ${env.SEITE}`,
    html: u => `<p>${nurText(selbst(u) ? eigen : kopf)}</p>`
        + `<p style="font-size:13px;color:#6f6653">${nachsatz}</p>`
        + mailKnopf(env.SEITE, 'Zur Tafel'),
  });
}

/* Die einzige Art, die von Haus aus AUS ist: an einem lebhaften Abend ist sie
   die, die eine Runde zumuellt. Wer sie will, schaltet sie ein. */
function mailEcho(env, ctx, anWen, vonWem, worum, bezug) {
  benachrichtige(env, ctx, 'echo', [anWen], {
    bezug,
    betreff: `${vonWem}: ${worum.kurz}`,
    text: `${worum.lang}\n\nNachlesen: ${env.SEITE}`,
    html: `<p>${nurText(worum.lang)}</p>` + mailKnopf(env.SEITE, 'Nachlesen'),
  });
}

/* Vorlage und Pruefung der Rundmail - fuer den Sofortversand UND die geplante
   Fassung dieselbe Funktion, damit beide dieselbe Mail bauen und nicht zwei
   leicht verschiedene Rundmail-Arten entstehen. Bild und Knopf sind das
   ganze Zugestaendnis an HTML: kein freier Editor im Kontor, dafuer dasselbe
   `mailKnopf`-Muster wie bei Termin- und Gewinner-Mails. */
function rundmailPruefen(daten) {
  const betreff = String(daten.betreff ?? '').trim().replace(/\s+/g, ' ');
  const text = String(daten.text ?? '').trim();
  const bildUrl = String(daten.bild_url ?? '').trim();
  const knopfText = String(daten.knopf_text ?? '').trim();
  const knopfLink = String(daten.knopf_link ?? '').trim();

  if (!betreff) return { fehler: 'Ohne Betreff keine Rundmail' };
  if (betreff.length > RUNDMAIL_BETREFF_MAX) {
    return { fehler: `Der Betreff darf höchstens ${RUNDMAIL_BETREFF_MAX} Zeichen haben` };
  }
  if (!text) return { fehler: 'Ohne Text keine Rundmail' };
  if (text.length > RUNDMAIL_MAX) return { fehler: `Höchstens ${RUNDMAIL_MAX} Zeichen` };

  if (bildUrl && (bildUrl.length > RUNDMAIL_LINK_MAX || !/^https:\/\//i.test(bildUrl))) {
    return { fehler: 'Das Bild braucht eine https-Adresse' };
  }
  if (knopfLink && (knopfLink.length > RUNDMAIL_LINK_MAX || !/^https:\/\//i.test(knopfLink))) {
    return { fehler: 'Der Knopf braucht eine https-Adresse' };
  }
  if (!!knopfText !== !!knopfLink) {
    return { fehler: 'Der Knopf braucht Text UND Adresse, oder keins von beiden' };
  }
  if (knopfText.length > RUNDMAIL_KNOPF_MAX) {
    return { fehler: `Der Knopftext darf höchstens ${RUNDMAIL_KNOPF_MAX} Zeichen haben` };
  }

  return {
    betreff, text,
    bildUrl: bildUrl || null,
    knopfText: knopfText || null,
    knopfLink: knopfLink || null,
  };
}

function rundmailHtml({ text, bildUrl, knopfText, knopfLink }) {
  const bild = bildUrl
    ? `<p><img src="${nurText(bildUrl)}" alt="" style="max-width:100%;border-radius:4px;
         display:block;margin:0 0 4px"></p>`
    : '';
  const absaetze = text.split(/\n{2,}/)
    .map(a => `<p>${nurText(a).replace(/\n/g, '<br>')}</p>`).join('\n');
  return bild + absaetze + (knopfText ? mailKnopf(knopfLink, knopfText) : '');
}

const rundmailText = ({ text, bildUrl, knopfText, knopfLink }) => text
  + (bildUrl ? `\n\n${bildUrl}` : '')
  + (knopfText ? `\n\n${knopfText}: ${knopfLink}` : '');

/* Der eigentliche Versand - Sofortversand UND geplante Rundmail rufen
   dieselbe Funktion, damit die Stundensperre an einer einzigen Stelle greift,
   egal auf welchem Weg die Mail losgeht. Wirft bei Sperre einen Fehler mit
   `.sperre`, damit die Route daraus eine 429 macht und der Cron daraus ein
   'fehlgeschlagen'. */
async function rundmailAbschicken(env, ctx, adminId, geprueft) {
  const letzte = await env.DB.prepare(`
    SELECT erstellt FROM admin_log WHERE aktion = 'rundmail'
      AND erstellt > datetime('now', ?) LIMIT 1
  `).bind(`-${RUNDMAIL_SPERRE} hours`).first();
  if (letzte) {
    const e = new Error('Die letzte Rundmail ist noch keine Stunde her');
    e.sperre = true;
    throw e;
  }

  const kreis = await env.DB.prepare(`
    SELECT id, mail_prefs FROM users
    WHERE email IS NOT NULL AND gesperrt_am IS NULL
      AND entfernt_am IS NULL AND mail_stumm_am IS NULL
  `).all();
  const wieViele = kreis.results.filter(u => mailWahl(u).rundmail).length;

  benachrichtige(env, ctx, 'rundmail', null, {
    betreff: geprueft.betreff,
    text: rundmailText(geprueft),
    html: rundmailHtml(geprueft),
  });

  await env.DB.prepare(
    'INSERT INTO admin_log (admin_id, aktion, detail) VALUES (?, ?, ?)')
    .bind(adminId, 'rundmail', geprueft.betreff.slice(0, 120)).run();

  return wieViele;
}

/* Wie `pruefeBeginn` bei Terminen, aber fuer den Versandzeitpunkt einer
   geplanten Rundmail: er muss in der Zukunft liegen - sonst waere es ein
   Sofortversand - und nicht zu weit weg, dieselbe Obergrenze wie bei
   Terminen und aus demselben Grund. */
function pruefeVersand(roh) {
  const d = new Date(String(roh || ''));
  if (isNaN(d)) return { fehler: 'Zeitpunkt: ISO-8601 in UTC, etwa 2026-08-02T17:00:00Z' };
  if (d.getTime() <= Date.now() + 60_000) {
    return { fehler: 'Der Zeitpunkt muss mindestens eine Minute in der Zukunft liegen' };
  }
  if (d.getTime() > Date.now() + RUNDMAIL_VORAUS * 864e5) {
    return { fehler: `Höchstens ${RUNDMAIL_VORAUS} Tage im Voraus` };
  }
  return { d };
}

/* Die geplanten Rundmails - aufgerufen vom zehnminuetigen Cron, siehe
   `scheduled()` unten und den zweiten Eintrag in wrangler.jsonc. Keine
   Uhrzeit auf die Minute, aber nah genug fuer eine Ankuendigung. Jede
   faellige Zeile bekommt genau einen Versuch: schlaegt er fehl (etwa weil
   die Stundensperre noch greift), bleibt sie 'fehlgeschlagen' liegen statt
   es beim naechsten Lauf mit demselben Ergebnis wieder zu versuchen. */
async function rundmailGeplantVersenden(env, ctx) {
  const faellig = await env.DB.prepare(`
    SELECT * FROM rundmail_geplant
    WHERE status = 'geplant' AND versand_am <= datetime('now')
    ORDER BY versand_am
  `).all();

  for (const m of faellig.results) {
    try {
      const wieViele = await rundmailAbschicken(env, ctx, m.admin_id, {
        betreff: m.betreff, text: m.text,
        bildUrl: m.bild_url, knopfText: m.knopf_text, knopfLink: m.knopf_link,
      });
      await env.DB.prepare(`
        UPDATE rundmail_geplant
        SET status = 'versendet', versendet_am = datetime('now'), empfaenger = ?
        WHERE id = ?
      `).bind(wieViele, m.id).run();
    } catch (e) {
      console.error('Geplante Rundmail:', e && e.stack || e);
      await env.DB.prepare(`
        UPDATE rundmail_geplant SET status = 'fehlgeschlagen', fehler = ? WHERE id = ?
      `).bind(String(e && e.message || e).slice(0, 200), m.id).run();
    }
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
      /* Ob der Betreiber von Neuen erfaehrt. Die Adresse selbst gehoert nicht
         in eine offene Route - hier steht nur, ob eine da ist. */
      neu_melden: env.MELDE_AN ? 'ok' : 'aus (MELDE_AN fehlt)',
      /* Wie bei MELDE_AN und BILDER_URL: hier steht, OB eines da ist, nie
         sein Wert. Ohne ADMIN_MAIL kommt niemand ins Kontor, ohne
         MAIL_GEHEIM traegt keine Mail einen Abmeldelink - beides sieht von
         aussen wie ein Fehler aus, wenn hier nichts darueber steht. */
      admin: env.ADMIN_MAIL ? 'ok' : 'aus (ADMIN_MAIL fehlt)',
      mail_geheim: env.MAIL_GEHEIM ? 'ok' : 'aus (MAIL_GEHEIM fehlt)',
      tafel: env.TAFEL ? 'ok' : 'nicht eingerichtet',
      // GIFs an Kommentaren: ohne Schluessel bleibt /api/gif ein 503, siehe
      // ideas/gifs-und-memes.md.
      giphy: env.GIPHY_KEY ? 'ok' : 'aus (GIPHY_KEY fehlt)',
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

    /* Die Sperre muss SCHON HIER greifen. Sonst holt sich der Gesperrte
       schlicht einen frischen Link und ein neues Token - Token zu loeschen
       braechte gar nichts, solange die Tuer daneben offen steht. */
    const bekannt = await env.DB
      .prepare('SELECT gesperrt_am, gesperrt_grund FROM users WHERE email = ?').bind(email).first();
    if (bekannt && bekannt.gesperrt_am) {
      return fehler(request, bekannt.gesperrt_grund
        ? `Dein Zugang ist gesperrt: ${bekannt.gesperrt_grund}`
        : 'Dein Zugang ist gesperrt.', 403);
    }

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

    const zeile = await env.DB.prepare('SELECT email, zweck, user_id FROM magic WHERE token_hash = ?').bind(h).first();
    const email = zeile.email;

    /* Derselbe Link, zwei Zwecke. Der Wechsel geht ueber DIESE Route, weil
       das Fragment auf der Seite schon abgeholt wird und ein zweiter Weg
       hinein ein zweiter Weg hinein waere. */
    if (zeile.zweck === 'mailwechsel') {
      const wer = await env.DB
        .prepare('SELECT id, name, email, gesperrt_am, gesperrt_grund, entfernt_am FROM users WHERE id = ?')
        .bind(zeile.user_id).first();
      if (!wer || wer.entfernt_am) return fehler(request, 'Dieses Konto gibt es nicht mehr', 404);
      if (wer.gesperrt_am) {
        return fehler(request, wer.gesperrt_grund
          ? `Dein Zugang ist gesperrt: ${wer.gesperrt_grund}`
          : 'Dein Zugang ist gesperrt.', 403);
      }
      /* In den fuenfzehn Minuten dazwischen kann sich jemand anders auf die
         Adresse gesetzt haben. Der Link ist dann verbraucht - unschoen, aber
         ehrlich: ein zweiter Anlauf kostet einen Klick. */
      try {
        await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, wer.id).run();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Die Adresse gehört inzwischen jemandem', 409);
        }
        throw e;
      }

      /* Auch hier ein Geraete-Token: geklickt wird im neuen Postfach, und das
         steht oft auf einem anderen Geraet als dem, an dem der Wechsel
         angestossen wurde. Ohne Token saesse man dort vor der Tuer, obwohl
         man gerade den Besitz der Adresse nachgewiesen hat. */
      const frisch = wuerfel();
      await env.DB.prepare('INSERT INTO tokens (token_hash, user_id) VALUES (?, ?)')
        .bind(await hash(frisch), wer.id).run();

      return antwort(request, {
        token: frisch, name: wer.name, braucht_namen: !wer.name,
        zweck: 'mailwechsel', email,
      });
    }

    let u = await env.DB.prepare('SELECT id, name, rolle, gesperrt_am, gesperrt_grund FROM users WHERE email = ?')
      .bind(email).first();
    if (!u) {
      // Neu. Der Name fuer die Liste kommt gleich danach, in einem eigenen
      // Schritt - hier weiss die Seite noch gar nicht, wer das ist.
      u = await env.DB.prepare('INSERT INTO users (email) VALUES (?) RETURNING id, name, rolle')
        .bind(email).first();
    }
    /* Zweite Pruefung, obwohl `POST /api/anmelden` sie schon macht: zwischen
       Anfordern und Klicken liegen bis zu fuenfzehn Minuten, und in denen
       kann die Sperre gefallen sein. Der Link ist damit schon verbraucht -
       richtig so, er soll nicht liegen bleiben und spaeter noch ziehen. */
    if (u.gesperrt_am) {
      return fehler(request, u.gesperrt_grund
        ? `Dein Zugang ist gesperrt: ${u.gesperrt_grund}`
        : 'Dein Zugang ist gesperrt.', 403);
    }

    /* Der erste Admin, und der Weg zurueck, wenn sich einer versehentlich
       selbst degradiert hat: wer sich mit ADMIN_MAIL anmeldet, ist danach
       Admin. Selbstheilend ueber das Postfach - sonst waere das Kontor zu und
       nur noch per SQL zu oeffnen. Gleiches Muster wie MELDE_AN. */
    if (env.ADMIN_MAIL && email === normMail(env.ADMIN_MAIL) && u.rolle !== 'admin') {
      await env.DB.prepare("UPDATE users SET rolle = 'admin' WHERE id = ?").bind(u.id).run();
    }

    const token = wuerfel();
    await env.DB.prepare('INSERT INTO tokens (token_hash, user_id) VALUES (?, ?)')
      .bind(await hash(token), u.id).run();

    return antwort(request, { token, name: u.name, braucht_namen: !u.name });
  },

  // -------------------------------------------------------------------------
  /* ACHTUNG, haengt an Home Assistant: `sensor.beerstock_ich` liest aus
     dieser Antwort `value_json.name`. Erweitern ist frei, umbenennen nicht -
     zusaetzliche Schluessel stoeren das Template nicht, ein fehlender schon. */
  'GET /api/me': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    /* Nur die Zahl. Sie ist hoeher, als der Nutzer Geraete benutzt hat: JEDES
       Einloesen eines Magic Links legt ein neues Token an, auch im selben
       Browser, und entfernt wird keines. Hier stand kurzzeitig die ganze
       Liste mit Zeitstempeln, damit man einzelne wegraeumen kann - sieben
       Zeilen fuer zwei benutzte Browser, und damit das groesste Feld des
       Blattes fuer die unwichtigste Auskunft darauf. Wer aufraeumen will,
       meldet alle ab und kommt einmal neu. */
    const geraete = await env.DB
      .prepare('SELECT count(*) AS n FROM tokens WHERE user_id = ?').bind(ich.id).first();
    return antwort(request, {
      name: ich.name,
      braucht_namen: !ich.name,
      gemessen: ich.quelle === 'ha',
      email: ich.email,
      rolle: ich.rolle,
      // Wer gesperrt ist, soll den Grund lesen koennen - er sieht die Tafel
      // ja weiter, und ohne Grund waere jeder Schreibversuch ein Raetsel.
      gesperrt: ich.gesperrt_am ? { seit: utc(ich.gesperrt_am), grund: ich.gesperrt_grund } : null,
      mail: mailWahl(ich),
      mail_stumm: !!ich.mail_stumm_am,
      geraete: geraete ? geraete.n : 1,
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
    // Und fuer den Gastgeber ein Neuer. Nur beim ERSTEN Namen: wer sich
    // spaeter umbenennt, hatte schon einen.
    if (!ich.name) meldeNeuenNutzer(env, ctx, { name, email: ich.email });
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
  /* Das verlorene Handy. Wirft ALLE Geraete raus, auch das hier - wer diesen
     Knopf drueckt, will nicht aussuchen, welches gemeint war. */
  'POST /api/geraete/alle-abmelden': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const weg = await env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(ich.id).run();
    return antwort(request, { ok: true, abgemeldet: weg.meta.changes });
  },

  // -------------------------------------------------------------------------
  /* Die Schalter aus "Mein Deckel". Sie schicken einzeln und sofort - sechs
     Schalter mit Speichern-Knopf sind ein Formular zu viel -, deshalb nimmt
     die Route auch einen einzelnen entgegen und ruehrt die anderen nicht an.

     `stumm: false` ist der Weg zurueck aus dem Ein-Klick-Abmeldelink. Ohne
     ihn waere der eine Klick in der Mail eine Einbahnstrasse. */
  'POST /api/einstellungen': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const anweisungen = [];

    if (daten.mail !== undefined) {
      if (!daten.mail || typeof daten.mail !== 'object' || Array.isArray(daten.mail)) {
        return fehler(request, 'mail: ein Objekt aus Schaltern');
      }
      /* Unbekannte Schluessel abweisen statt schlucken: eine Seite, die sich
         vertippt, soll es merken - sonst schaltet der Nutzer jahrelang etwas
         aus, das nie gelesen wird. */
      const gemischt = { ...mailWahl(ich) };
      for (const [art, wert] of Object.entries(daten.mail)) {
        if (!Object.hasOwn(MAIL_ARTEN, art)) {
          return fehler(request, `Unbekannte Benachrichtigung: ${art}`);
        }
        if (typeof wert !== 'boolean') return fehler(request, `${art}: an oder aus, sonst nichts`);
        gemischt[art] = wert;
      }
      anweisungen.push(env.DB.prepare('UPDATE users SET mail_prefs = ? WHERE id = ?')
        .bind(JSON.stringify(gemischt), ich.id));
    }

    if (daten.stumm !== undefined) {
      if (typeof daten.stumm !== 'boolean') return fehler(request, 'stumm: an oder aus');
      anweisungen.push(env.DB.prepare(
        `UPDATE users SET mail_stumm_am = ${daten.stumm ? "datetime('now')" : 'NULL'} WHERE id = ?`)
        .bind(ich.id));
    }

    if (!anweisungen.length) return fehler(request, 'Nichts zu ändern');
    await env.DB.batch(anweisungen);

    // Frisch lesen statt zusammenrechnen: die Antwort soll den Stand zeigen,
    // der in der Datenbank steht, nicht den, den wir gerade gemeint haben.
    const neu = await env.DB
      .prepare('SELECT mail_prefs, mail_stumm_am FROM users WHERE id = ?').bind(ich.id).first();
    return antwort(request, {
      ok: true, mail: mailWahl(neu), mail_stumm: !!neu.mail_stumm_am,
    });
  },

  // -------------------------------------------------------------------------
  /* Der Ein-Klick-Abmelder aus der Fusszeile jeder Mail. Ohne Anmeldung -
     genau darum geht es: wer keine Post mehr will, soll nicht erst einen
     Magic Link anfordern muessen, um das zu sagen.

     Umkehrbar, und im Deckel steht danach der Weg zurueck. Ein POST und kein
     GET, obwohl der Link in einer Mail steht: Vorschaudienste laden Links vor
     (siehe die Gewinner-Mail), und dann waere man abgemeldet, ohne geklickt
     zu haben. Die Seite holt das Fragment ab und schickt es hierher. */
  'POST /api/mail/stumm': async (request, env) => {
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const id = Number(daten.id);
    if (!Number.isInteger(id) || id <= 0) return fehler(request, 'Link unvollständig');
    if (!await sigStimmt(env, 'abmelden', id, String(daten.sig || ''))) {
      return fehler(request, 'Dieser Link gilt nicht', 403);
    }
    await env.DB.prepare("UPDATE users SET mail_stumm_am = datetime('now') WHERE id = ?")
      .bind(id).run();
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Die Adresse wechseln. Zweistufig, und die zweite Stufe liegt im NEUEN
     Postfach: sonst schriebe sich jemand mit einem geliehenen Handy auf eine
     Adresse um, die ihm gar nicht gehoert, und der Magic Link liefe kuenftig
     dorthin. Bis zum Klick gilt die alte Adresse unveraendert weiter. */
  'POST /api/mail/aendern': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const email = normMail(daten.email);
    if (!istMail(email)) return fehler(request, 'Das sieht nicht nach einer Mailadresse aus');
    if (email === normMail(ich.email)) {
      return fehler(request, 'Das ist schon deine Adresse');
    }

    const [belegt, proNutzer, proAdresse, gesamt] = await env.DB.batch([
      env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email),
      env.DB.prepare(`SELECT count(*) AS n FROM magic
                      WHERE zweck = 'mailwechsel' AND user_id = ?
                        AND erstellt > datetime('now','-1 day')`).bind(ich.id),
      env.DB.prepare("SELECT count(*) AS n FROM magic WHERE email = ? AND erstellt > datetime('now','-1 hour')").bind(email),
      env.DB.prepare("SELECT count(*) AS n FROM magic WHERE erstellt > datetime('now','-1 hour')"),
    ]);
    if (belegt.results.length) {
      return fehler(request, 'Die Adresse gehört schon jemandem', 409);
    }
    if (proNutzer.results[0].n >= MAILWECHSEL_PRO_TAG) {
      return fehler(request, `Höchstens ${MAILWECHSEL_PRO_TAG} Adresswechsel am Tag. Morgen wieder.`, 429);
    }
    if (proAdresse.results[0].n >= LINKS_PRO_ADRESSE) {
      return fehler(request, 'An diese Adresse ging gerade schon ein Link raus. Schau ins Postfach, auch im Spam.', 429);
    }
    if (gesamt.results[0].n >= LINKS_GESAMT) {
      return fehler(request, 'Gerade zu viel Andrang. Versuch es in einer Stunde nochmal.', 429);
    }

    const token = wuerfel();
    await env.DB.prepare(`
      INSERT INTO magic (token_hash, email, laeuft_ab, zweck, user_id)
      VALUES (?, ?, datetime('now', ?), 'mailwechsel', ?)
    `).bind(await hash(token), email, `+${LINK_MINUTEN} minutes`, ich.id).run();

    try {
      await schickeWechselLink(env, email, `${env.SEITE}#anmelden=${token}`);
    } catch (e) {
      console.error('Mailversand:', e.message);
      return fehler(request, 'Die Mail ging nicht raus. Das liegt an uns, nicht an dir.', 502);
    }
    warneAlteAdresse(env, ctx, ich.email, email);

    return antwort(request, { ok: true, wartet_auf: email });
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
  /* Den Notruf absetzen. Zwei Noete, ein Ort, anderthalb Stunden.
     -------------------------------------------------------------------------
     Der ORT IST DIE FRACHT, und das macht diese Route zur empfindlichsten im
     Dienst. Drei Dinge halten sie im Zaum, und alle drei stehen absichtlich
     hier und nicht in der Seite:

     1. Sie schreibt nur, was der Browser schickt - der Worker fragt nirgends
        nach, wo jemand ist. Ohne ausdrueckliche Erlaubnis im Browser gibt es
        gar keinen Notruf, nur die Meldung, dass es nicht ging.
     2. Was hier landet, erlischt von selbst (`bis`) und wird geloescht, nicht
        archiviert (siehe Migration 0013).
     3. Wer erneut drueckt, ERSETZT sich selbst. Zwei offene Notrufe desselben
        Menschen an zwei Orten sind keine zwei Noete, sondern ein veralteter
        Punkt auf der Karte - und der schickt jemanden in die falsche Stadt. */
  'POST /api/notruf': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const art = String(daten.art || '');
    if (!NOTRUF_ARTEN.has(art)) return fehler(request, "art: 'bier', 'kamerad' oder 'alles'");

    const koord = notrufKoordinaten(daten);
    if (koord.fehler) return fehler(request, koord.fehler);
    const { lat, lon, genau } = koord;

    /* Wer ihn sehen soll. `null` heisst an alle - siehe `notrufKreis` und
       migrations/0021. Geprueft VOR dem Anlegen: ein Notruf, dessen Kreis
       nicht steht, ist keiner, den man kurz mal stehen lassen kann. */
    const kreis = await notrufKreis(daten, env, ich.id);
    if (kreis.fehler) return fehler(request, kreis.fehler);

    /* Ob der Standort mitwandern soll. Fehlt das Feld, ist es ein einmaliger
       Notruf - so wie jeder, der vor Migration 0018 abgesetzt wurde. Ein
       Versprechen, mehr nicht: geliefert wird es erst von den Nachtraegen an
       `POST /api/notruf/standort`, und `standort_am` bleibt bis dahin NULL. */
    const live = daten.live === true ? 1 : 0;

    const letzte = await env.DB.prepare(`
      SELECT 1 FROM notrufe WHERE user_id = ? AND erstellt > datetime('now', ?) LIMIT 1
    `).bind(ich.id, `-${NOTRUFSPERRE} seconds`).first();
    if (letzte) return fehler(request, 'Zu schnell - einen Moment', 429);

    const [, neu] = await env.DB.batch([
      // Der eigene offene Notruf weicht dem neuen, in derselben Transaktion.
      env.DB.prepare(`
        UPDATE notrufe SET weg_am = datetime('now')
        WHERE user_id = ? AND weg_am IS NULL
      `).bind(ich.id),
      env.DB.prepare(`
        INSERT INTO notrufe (user_id, art, lat, lon, genau, bis, live)
        VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)
        RETURNING id, erstellt, bis, live, standort_am
      `).bind(ich.id, art, lat, lon, genau, `+${NOTRUF_MINUTEN} minutes`, live),
      // Der Zaehler fuer die Statistik - siehe Migration 0017, warum nicht
      // aus `notrufe` selbst gezaehlt wird. Nur beim ABSETZEN, nicht beim
      // Standort-Nachtrag: der ersetzt keinen Notruf, er ergaenzt einen.
      env.DB.prepare(`
        UPDATE users SET zuletzt = datetime('now'),
                         notrufe_insgesamt = notrufe_insgesamt + 1
        WHERE id = ?
      `).bind(ich.id),
    ]);
    const zeile = neu.results[0];

    /* Der Kreis erst NACH dem Anlegen: er braucht die Id, die die Zeile oben
       gerade bekommen hat. Bis dahin steht der Notruf einen Wimpernschlag lang
       ohne Kreis da, gilt also fuer alle - das ist die richtige Richtung des
       Fehlers, falls hier etwas abbricht: ein Hilferuf, der zu weit geht, ist
       besser als einer, der niemanden erreicht. */
    if (kreis.ids) await kreisSetzen(env, zeile.id, kreis.ids);

    /* Die Post. Ein Notruf MELDET nur, er liefert nichts mit - also gilt die
       alte Regel und der Ausloeser bleibt draussen (siehe `benachrichtige`).
       Der Kartenlink steht in der Mail selbst: wer sie im Bett liest, soll
       nicht erst die Seite aufmachen muessen, um zu wissen, wohin.

       Ohne Kreis geht sie an alle mit Namen - dieselbe Runde wie vor
       Migration 0021. */
    const anWen = kreis.ids ?? (await env.DB.prepare(
      'SELECT id FROM users WHERE id <> ? AND name IS NOT NULL')
      .bind(ich.id).all()).results.map(r => r.id);
    notrufPost(env, ctx, ich, zeile.id, art, lat, lon, anWen);

    anstoss(request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true,
      notruf: notrufAntwort({
        ...zeile, art, lat, lon, genau, name: ich.name, user_id: ich.id,
        kreis_gross: kreis.ids ? kreis.ids.length : 0,
        kreis_ids: kreis.ids ? kreis.ids.join(',') : null,
      }, ich.id),
    }, 201);
  },

  /* Den Standort nachtragen, an einem laufenden Notruf. Anders als ein neuer
     Notruf (der den alten ERSETZT und erneut anschreibt) aendert das hier nur
     die Koordinaten AN DERSELBEN Zeile - kein neues `erstellt`, kein `bis`,
     das weiterlaeuft, und vor allem KEINE Post. Wer Bier braucht und sich vom
     Sofa zur Kueche bewegt, soll das nachtragen koennen, ohne dass bei allen
     anderen zum zweiten Mal die Mail aufploppt.

     Deshalb auch ohne eigene Sperre: die teure Handlung an `POST /api/notruf`
     ist der Mailversand an die ganze Runde, und den gibt es hier nicht - ein
     zweimal getippter Knopf kostet nur eine zweite, gleich teure Zeile in
     derselben Tabelle. */
  'POST /api/notruf/standort': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const koord = notrufKoordinaten(daten);
    if (koord.fehler) return fehler(request, koord.fehler);
    const { lat, lon, genau } = koord;

    /* `standort_am` faellt hier an und NUR hier: es ist die Uhrzeit, zu der
       dieser Ort zuletzt bestaetigt wurde. Daran haengt auf der Tafel die
       Unterscheidung zwischen einem mitwandernden und einem stehengebliebenen
       Live-Standort (migrations/0018). `live` bleibt unangetastet - ob der
       Nachtrag von Hand kam oder von `watchPosition`, sagt nichts darueber,
       was der Absender versprochen hat; das setzt `POST /api/notruf/live`. */
    const zeile = await env.DB.prepare(`
      UPDATE notrufe SET lat = ?, lon = ?, genau = ?, standort_am = datetime('now')
      WHERE user_id = ? AND weg_am IS NULL AND bis > datetime('now')
      RETURNING id, art, erstellt, bis, live, standort_am
    `).bind(lat, lon, genau, ich.id).first();
    if (!zeile) return fehler(request, 'Du hast gerade keinen laufenden Notruf', 409);

    const kreis = await kreisLesen(env, zeile.id);
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true,
      notruf: notrufAntwort(
        { ...zeile, ...kreis, lat, lon, genau, name: ich.name, user_id: ich.id }, ich.id),
    });
  },

  /* Der Schieberegler, nachgereicht. Braucht eine eigene Route, weil das
     Umlegen auf "einmalig" KEINE Koordinaten hat - es hoert ja gerade damit
     auf, welche zu schicken. Ohne diese Route bliebe ein abgewaehlter
     Live-Standort auf der Tafel als "steht still" stehen, statt schlicht
     wieder eine einmalige Aufnahme zu sein.

     Kein Anschreiben, keine Sperre, kein neues `bis`: dasselbe wie beim
     Standort-Nachtrag, aus demselben Grund - die teure Handlung ist die Mail
     an die Runde, und die gibt es hier nicht. */
  'POST /api/notruf/live': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    if (typeof daten.live !== 'boolean') return fehler(request, 'live: true oder false');

    const zeile = await env.DB.prepare(`
      UPDATE notrufe SET live = ?
      WHERE user_id = ? AND weg_am IS NULL AND bis > datetime('now')
      RETURNING id, art, lat, lon, genau, erstellt, bis, live, standort_am
    `).bind(daten.live ? 1 : 0, ich.id).first();
    if (!zeile) return fehler(request, 'Du hast gerade keinen laufenden Notruf', 409);

    const kreis = await kreisLesen(env, zeile.id);
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true,
      notruf: notrufAntwort({ ...zeile, ...kreis, name: ich.name, user_id: ich.id }, ich.id),
    });
  },

  /* Den Kreis am LAUFENDEN Notruf aendern - in beide Richtungen (entschieden
     am 2026-08-06, siehe ideas/mocks/mock-h-notruf-empfaengerkreis.html).
     -------------------------------------------------------------------------
     Dazunehmen schreibt die Neuen an (die schon Angeschriebenen bremst
     `mail_einmal`, siehe `notrufPost`). Wegnehmen nimmt dem anderen die Karte
     von der Tafel und beendet das Nachwandern des Live-Standorts - die Mail
     von vorhin bleibt draussen, die holt niemand zurueck.

     Dass das Wegnehmen ueberhaupt geht, ist die eigentliche Entscheidung: die
     Fracht dieses Notrufs ist der eigene Aufenthaltsort, und wer ihn hergibt,
     muss ihn auch wieder einsammeln koennen. Dagegen stand der eine Fall, dass
     jemand schon losgefahren ist und ihm die Karte unterwegs ausgeht - ein
     soziales Problem, gegen das man anrufen kann; ein Standort, den man nicht
     zurueckziehen kann, ist keines.

     Kein neues `bis`, keine Sperre: die Frist gehoert dem Notruf, nicht der
     Empfaengerliste. */
  'POST /api/notruf/kreis': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const kreis = await notrufKreis(daten, env, ich.id);
    if (kreis.fehler) return fehler(request, kreis.fehler);

    const zeile = await env.DB.prepare(`
      SELECT id, art, lat, lon, genau, erstellt, bis, live, standort_am
      FROM notrufe
      WHERE user_id = ? AND weg_am IS NULL AND bis > datetime('now')
    `).bind(ich.id).first();
    if (!zeile) return fehler(request, 'Du hast gerade keinen laufenden Notruf', 409);

    await kreisSetzen(env, zeile.id, kreis.ids);

    /* Angeschrieben wird der ganze neue Kreis, nicht die Differenz - warum,
       steht an `notrufPost`. Ohne Kreis ist das die ganze Runde: wer von
       "nur an drei" auf "an alle" umlegt, erreicht damit auch die uebrigen. */
    const anWen = kreis.ids ?? (await env.DB.prepare(
      'SELECT id FROM users WHERE id <> ? AND name IS NOT NULL')
      .bind(ich.id).all()).results.map(r => r.id);
    notrufPost(env, ctx, ich, zeile.id, zeile.art, zeile.lat, zeile.lon, anWen);

    anstoss(request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true,
      notruf: notrufAntwort({
        ...zeile, name: ich.name, user_id: ich.id,
        kreis_gross: kreis.ids ? kreis.ids.length : 0,
        kreis_ids: kreis.ids ? kreis.ids.join(',') : null,
      }, ich.id),
    });
  },

  /* Wer sich anwaehlen laesst. Eine eigene, sehr schmale Route statt eines
     Anhaengsels an der Bestenliste: die Namen aendern sich im Monatstakt, die
     Bestenliste wird im Minutentakt geholt. Und sie kaeme aus dem falschen
     Topf - `feld` dort ist ein JOIN auf `reports` und kennt nur, wer schon
     einmal gemeldet hat. Wer angemeldet ist und nie gemeldet hat, bekommt die
     Notruf-Mail und fiele aus einer Auswahl aus `feld` still heraus. */
  'GET /api/kreis': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const leute = await kreisWaehlbarStmt(env, ich.id).all();
    return antwort(request, { leute: leute.results }, 200, KEIN_FREMDER_CACHE);
  },

  /* Zurueckgenommen. Kein Loeschen: die Zeile bleibt bis zum Aufraeumen stehen,
     damit die offenen Seiten den Notruf verschwinden SEHEN, statt ihn wortlos
     zu verlieren - `weg_am` faellt aus der Abfrage, der Anstoss kommt trotzdem.
     Wer keinen offenen hat, bekommt kein Nein: zweimal "weg" ist kein Fehler,
     sondern derselbe Wunsch zweimal. */
  'POST /api/notruf/weg': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const weg = await env.DB.prepare(`
      UPDATE notrufe SET weg_am = datetime('now')
      WHERE user_id = ? AND weg_am IS NULL
    `).bind(ich.id).run();

    if (weg.meta.changes) anstoss(request, env, ctx, 'tafel');
    return antwort(request, { ok: true, weg: weg.meta.changes });
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
        : `Zu wenig gemeldet — die Flasche braucht mindestens ${lage.mindest}, ` +
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

    /* Nur wenn HIER gezogen wurde. War ein anderer schneller, hat dessen Ruf
       die Mail schon geschickt - und die Doppel-Sperre in `mail_ausgang`
       faengt den Rest. Der Gewinner bekommt sie auch dann, wenn er selbst
       gedreht hat: er sieht das Ergebnis zwar auf der Seite, aber die Mail ist
       der Weg zur Antwort, wenn er das Fenster gleich darauf zumacht. */
    if (selbst && lage2.gueltig) mailGewonnen(env, ctx, lage2.gueltig.id, gewinner.id);
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
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    /* Zwei Wege herein. Der gewoehnliche ist das Geraete-Token; der zweite ist
       die Signatur aus der Gewinner-Mail, damit man aus dem Postfach heraus
       antworten kann, ohne sich anzumelden. Sie bindet Los UND Empfaenger,
       und die Los-Id wird unten noch einmal gegen die geltende Ziehung
       gehalten - ein Link von vorgestern beantwortet die heutige nicht. */
    let ich = await nutzer(request, env);
    let ausDerMail = false;
    if (!ich && daten.t) {
      const [rohId, marke] = String(daten.t).split('.');
      const uid = Number(rohId), losId = Number(daten.los);
      if (!Number.isInteger(uid) || !Number.isInteger(losId)) {
        return fehler(request, 'Link unvollständig');
      }
      if (!await sigStimmt(env, `los:${losId}`, uid, marke || '')) {
        return fehler(request, 'Dieser Link gilt nicht', 403);
      }
      ich = await env.DB.prepare(`
        SELECT id, name, email, quelle, gesperrt_am, gesperrt_grund, entfernt_am
        FROM users WHERE id = ?
      `).bind(uid).first();
      if (!ich || ich.entfernt_am) return fehler(request, 'Dieses Konto gibt es nicht mehr', 404);
      if (ich.gesperrt_am) {
        return fehler(request, ich.gesperrt_grund
          ? `Dein Zugang ist gesperrt: ${ich.gesperrt_grund}`
          : 'Dein Zugang ist gesperrt.', 403);
      }
      ausDerMail = true;
    }
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const ja = daten.antwort === 'ja';
    if (!ja && daten.antwort !== 'nein') return fehler(request, "antwort: 'ja' oder 'nein'");

    let grund = String(daten.grund ?? '').trim().replace(/\s+/g, ' ');
    if (grund.length > GRUND_MAX) {
      return fehler(request, `Der Grund darf höchstens ${GRUND_MAX} Zeichen haben`);
    }
    if (ja) grund = null;            // ein Grund gehoert zur Absage, nicht zur Zusage

    /* Die Zeiten des Abends kommen vom Client, fertig in UTC gerechnet - der
       Browser kennt die Ortszeit, der Worker nicht. Fehlt der Anfang, greift
       die Vorgabe auf dem Bierabend-Tag selbst; fehlt das Ende, die Dauer
       dahinter. `bierTag()` darf dafuer schon hier stehen, es rechnet nur mit
       der Uhr und nicht mit der Datenbank.

       Auch die Vorgabe laeuft durch `pruefeBeginn`, statt ungeprueft in den
       INSERT zu gehen: sie ist ein Zeitpunkt wie jeder andere. Sie kann die
       Grenzen gar nicht reissen - die Vorgabe (17:00 UTC auf dem Bierabend-Tag)
       liegt hoechstens 24 - 17 + LOS_GRENZE = 9 Stunden zurueck, `TERMIN_RUECK`
       erlaubt 24 -, aber geprueft ist besser als geglaubt, und `pruefeEnde` braucht
       den Anfang ohnehin als Datum. */
    const tag = bierTag();
    let beginn = null, ende = null;
    if (ja) {
      const p = pruefeBeginn(daten.beginnt_am ?? `${tag}T${TERMIN_VORGABE_UTC}Z`);
      if (p.fehler) return fehler(request, p.fehler);
      const e = pruefeEnde(daten.endet_am, p.d);
      if (e.fehler) return fehler(request, e.fehler);
      beginn = alsDbZeit(p.d);
      ende   = alsDbZeit(e.d);
    }

    const [, tagRoh] = await env.DB.batch([verfallStmt(env, tag), losTagStmt(env, tag)]);
    const lage = tagesLage(tagRoh.results);
    const z = lage.gueltig;

    if (!z) return fehler(request, 'Heute ist gerade nichts zu entscheiden.', 409);
    if (z.user_id !== ich.id) {
      return fehler(request, 'Antworten darf nur, wen die Flasche getroffen hat.', 403);
    }
    /* Aus der Mail heraus muss die Signatur auf GENAU dieses Los lauten. Ohne
       diese Zeile beantwortete ein Link von vorgestern die heutige Ziehung
       mit - dieselbe Person, dieselbe Signatur, anderer Abend. */
    if (ausDerMail && z.id !== Number(daten.los)) {
      return fehler(request, 'Dieser Link gehört zu einer älteren Ziehung.', 409);
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
    let neuerTermin = null;
    if (ja) {
      neuerTermin = await env.DB.prepare(`
        INSERT INTO termine (gastgeber_id, beginnt_am, endet_am, los_id, erstellt_von)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(los_id) DO NOTHING
        RETURNING id
      `).bind(ich.id, beginn, ende, z.id, ich.id).first();
    }

    /* Erst die Zusage macht aus der Ziehung einen Abend - also geht die
       Nachricht auch erst hier raus, und nur, wenn der Termin WIRKLICH neu
       entstanden ist. Beim zweiten Ruf greift `ON CONFLICT DO NOTHING`, und
       dann gibt es nichts zu vermelden. */
    if (neuerTermin) {
      mailTerminNeu(env, ctx, {
        id: neuerTermin.id, beginnt_am: beginn, endet_am: ende,
        gastgeber: ich.name, titel: null, fassung: 0,
      }, ich.id, 'zugesagt');
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
    const e = pruefeEnde(daten.endet_am, p.d);
    if (e.fehler) return fehler(request, e.fehler);

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
      INSERT INTO termine (gastgeber_id, beginnt_am, endet_am, titel, erstellt_von)
      VALUES (?, ?, ?, ?, ?) RETURNING id
    `).bind(gast.id, alsDbZeit(p.d), alsDbZeit(e.d), titel || null, ich.id).first();

    mailTerminNeu(env, ctx, {
      id: neu.id, beginnt_am: alsDbZeit(p.d), endet_am: alsDbZeit(e.d),
      gastgeber: gast.name, titel: titel || null, fassung: 0,
    }, ich.id, 'eingetragen');

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
      SELECT t.id, t.gastgeber_id, t.erstellt_von, t.los_id, t.beginnt_am, t.endet_am,
             t.titel, t.abgesagt_am, t.fassung,
             coalesce(u.name, 'Ehemaliger') AS gastgeber,
             (t.beginnt_am <= datetime('now')) AS laeuft
      FROM termine t JOIN users u ON u.id = t.gastgeber_id WHERE t.id = ?
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
      /* `fassung` zaehlt mit hoch: die Absage ist die naechste Fassung dieses
         Abends, und nur mit hoeherer SEQUENCE raeumt ein Kalender den
         vorhandenen Eintrag weg (siehe 0012). */
      const schritte = [
        env.DB.prepare(`
          UPDATE termine SET abgesagt_am = datetime('now'), fassung = fassung + 1
          WHERE id = ? AND abgesagt_am IS NULL
        `).bind(t.id),
      ];
      if (t.los_id) {
        schritte.push(env.DB.prepare(`
          UPDATE los SET status = 'abgelehnt', entschieden_am = datetime('now')
          WHERE id = ? AND status = 'zugesagt'
        `).bind(t.los_id));
      }
      await env.DB.batch(schritte);
      mailTerminAendert(env, ctx, { ...t, fassung: t.fassung + 1 }, ich.id, 'abgesagt');
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

    /* Anfang und Ende haengen aneinander: wer nur verschiebt, will den Abend
       verschieben und nicht kuerzen. Das Ende wandert deshalb um dieselbe
       Spanne mit, wenn keins mitgeschickt wurde - sonst waere ein Abend, den
       man um zwei Stunden nach hinten legt, zwei Stunden kuerzer. */
    const altBeginn = new Date(utc(t.beginnt_am));
    const altEnde   = t.endet_am ? new Date(utc(t.endet_am)) : null;
    let beginn = altBeginn;

    if (daten.beginnt_am != null) {
      const p = pruefeBeginn(daten.beginnt_am);
      if (p.fehler) return fehler(request, p.fehler);
      beginn = p.d;
      setzt.push('beginnt_am = ?'); werte.push(alsDbZeit(p.d));
    }
    /* Das neue Ende wird auch unten gebraucht: der Kalendereintrag traegt
       DTEND, und ein Anhang mit dem ALTEN Ende an einem verschobenen Abend
       stuende quer zu dem, was daneben im Text steht. */
    let ende = t.endet_am;
    if (daten.endet_am != null) {
      const e = pruefeEnde(daten.endet_am, beginn);
      if (e.fehler) return fehler(request, e.fehler);
      ende = alsDbZeit(e.d);
      setzt.push('endet_am = ?'); werte.push(ende);
    } else if (daten.beginnt_am != null) {
      // Ohne altes Ende (Zeile von vor Schema 10) greift wieder die Vorgabe.
      const spanne = altEnde ? altEnde - altBeginn : TERMIN_DAUER_STD * 36e5;
      ende = alsDbZeit(new Date(beginn.getTime() + spanne));
      setzt.push('endet_am = ?'); werte.push(ende);
    }
    if (daten.titel != null) {
      const titel = String(daten.titel).trim().replace(/\s+/g, ' ');
      if (titel.length > TERMIN_TITEL_MAX) {
        return fehler(request, `Der Titel darf höchstens ${TERMIN_TITEL_MAX} Zeichen haben`);
      }
      setzt.push('titel = ?'); werte.push(titel || null);
    }
    if (!setzt.length) return fehler(request, 'Nichts zu ändern');

    /* Verschoben oder nur umbenannt - das sind zwei verschiedene Nachrichten.
       "Der Abend ist jetzt am Freitag" auf eine reine Titeländerung hin wäre
       schlicht falsch, und wer das einmal bekommt, glaubt der nächsten Mail
       nicht mehr. Ein Ende, das allein wandert, meldet niemand: es ist eine
       Anzeige, keine Verabredung. Steht VOR dem Schreiben, weil der Vergleich
       den alten Stand aus `t` braucht. */
    const verschoben = daten.beginnt_am != null
      && alsDbZeit(beginn) !== t.beginnt_am;
    const umbenannt = daten.titel != null
      && (String(daten.titel).trim().replace(/\s+/g, ' ') || null) !== t.titel;

    /* Die Fassung steigt nur, wenn auch eine Mail mit Kalendereintrag
       rausgeht. Ein stilles Nachjustieren des Endes ist keine neue Fassung -
       zählte sie trotzdem hoch, liefe die SEQUENCE der Anhänge irgendwann der
       Zahl davon, und niemand hätte etwas davon. */
    if (verschoben || umbenannt) { setzt.push('fassung = fassung + 1'); }

    await env.DB.prepare(`UPDATE termine SET ${setzt.join(', ')} WHERE id = ?`)
      .bind(...werte, t.id).run();

    if (verschoben || umbenannt) {
      mailTerminAendert(env, ctx, {
        ...t,
        beginnt_am: alsDbZeit(beginn), endet_am: ende,
        titel: daten.titel ?? t.titel,
        fassung: t.fassung + 1,
      }, ich.id, verschoben ? 'verschoben' : 'umbenannt');
    }

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

    /* Alle Kategorien leer heisst ZURUECKGENOMMEN: die Zeile faellt weg, statt
       als sternlose Bewertung stehenzubleiben und die Anzahl unter dem Abend
       weiter mitzuzaehlen. Steht davor, weil hier nichts von dem gilt, was das
       Setzen bindet:

       - Kein Bild, kein Text. Wer beides schickt, will keine Ruecknahme; der
         Satz gehoert dann an /api/kommentar, wo er ohne Sterne hingehoert.
       - Keine Sperre. Zurueckgenommen wird eine Zeile, die es schon gibt -
         zweimal loeschen aendert nichts, das ist kein Hebel fuer irgendwen.
       - Keine Zustandspruefung am Ziel. Wird ein Abend NACH der Bewertung
         abgesagt, verbaeten die Regeln unten das Loeschen ("Der Abend ist
         abgesagt worden") - und die Note haenge fuer immer an einem Abend, den
         es nie gab.

       Erst wird die Verbindung geloest, dann geloescht - `kommentare
       .bewertung_id` zeigt hierher und haelt die Zeile sonst fest (der
       Fremdschluessel aus 0007 hat kein ON DELETE). Der Kommentar darf nicht
       mitfallen: seine Sterne stehen seit 0009 als SCHNAPPSCHUSS in ihm selbst,
       gelesen wird `bewertung_id` fuer die Anzeige gar nicht mehr. Was die
       Karte trug, hat sie damals getragen - eine Ruecknahme von heute schreibt
       die Vergangenheit nicht um. Beides im selben batch, damit nicht der eine
       Schritt ohne den anderen dasteht.

       `changes` entscheidet ueber den Anstoss: wer nichts gelesen hatte und
       trotzdem auf null tippt, soll nicht alle offenen Seiten nachladen
       lassen. */
    if (s.leer) {
      if (String(daten.text ?? '').trim() || daten.bild) {
        return fehler(request, 'Ohne Sterne gehört der Text an die Kommentarroute');
      }
      const [, weg] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE kommentare SET bewertung_id = NULL WHERE bewertung_id IN (
            SELECT id FROM bewertungen WHERE autor_id = ? AND ziel_art = ? AND ziel_id = ?)
        `).bind(ich.id, ziel.art, ziel.id),
        env.DB.prepare('DELETE FROM bewertungen WHERE autor_id = ? AND ziel_art = ? AND ziel_id = ?')
          .bind(ich.id, ziel.art, ziel.id),
      ]);
      if (weg.meta.changes) anstoss(request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
      return antwort(request, { ok: true, sterne: null });
    }

    /* Auch hier, nicht nur an der Kommentarroute: der Fall "5 Sterne, ein Satz
       und ein Foto vom Kühlschrank" kommt als EINE Anfrage genau hier an - die
       Seite schickt einen Wurzelkommentar mit Sternen ueber diese Route. Hinge
       das Feld nur am Kommentar, waere ausgerechnet der Fall der eine, der
       nicht geht. Vor dem UPSERT geprueft, damit ein falscher Schluessel nicht
       die Sterne schon geschrieben hat. */
    const bi = await pruefeBild(env, daten.bild);
    if (bi.fehler) return fehler(request, bi.fehler, bi.status);

    /* Wem die Sterne gelten - beim Nutzer er selbst, beim Abend sein
       Gastgeber. Beide Zweige setzen es, damit die Meldung unten nur EINE
       Stelle hat; im Zweig selbst waere sie zweimal derselbe Aufruf. */
    let bewerteter = null;

    if (ziel.art === 'user') {
      if (ziel.id === ich.id) return fehler(request, 'Sich selbst bewerten gilt nicht', 403);
      const wer = await env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND name IS NOT NULL')
        .bind(ziel.id).first();
      if (!wer) return fehler(request, 'Den gibt es nicht', 404);
      bewerteter = ziel.id;
    } else {
      /* Ein Abend wird bewertet, nachdem er stattgefunden hat. Vorher waere es
         eine Erwartung, keine Bewertung - und ein abgesagter Abend hat gar
         nicht stattgefunden.

         Und nicht vom Gastgeber: dieselbe Regel wie ein paar Zeilen weiter
         oben bei `user`, denn es ist derselbe Fall. Der Abend heisst nach ihm,
         und "Versorgung" und "Location" bewerten nichts anderes als das, was
         er gestellt hat. Dass "Stimmung" und "Ausklang" das nicht sind - er
         war ja dabei - ist der ehrliche Einwand dagegen; zwei Kategorien zu
         erlauben und zwei zu sperren waere aber eine Regel, die sich niemand
         merkt, und eine halb ausgegraute Sternreihe sieht kaputt aus.

         Gehaengt an `gastgeber_id`, NICHT an `erstellt_von`: wer den Abend
         eines anderen von Hand eintraegt, darf ihn bewerten.

         Warum das hier steht und nicht oben bei der Ruecknahme: zurueckgeben
         darf man immer. Sonst haenge eine Note, die vor dieser Regel entstand,
         fuer immer fest. */
      const t = await env.DB.prepare(`
        SELECT abgesagt_am, gastgeber_id, (beginnt_am <= datetime('now')) AS gewesen
        FROM termine WHERE id = ?
      `).bind(ziel.id).first();
      if (!t) return fehler(request, 'Den Termin gibt es nicht', 404);
      if (t.abgesagt_am) return fehler(request, 'Der Abend ist abgesagt worden', 409);
      if (!t.gewesen) return fehler(request, 'Der Abend hat noch nicht angefangen', 409);
      if (t.gastgeber_id === ich.id) {
        return fehler(request, 'Den eigenen Abend bewertet man nicht', 403);
      }
      bewerteter = t.gastgeber_id;
    }

    /* Wie die Meldesperre, aber ausdruecklich nur gegen ANDERE Ziele - warum,
       steht bei BEWERTSPERRE. Das eigene Blatt darf man tippen, so schnell man
       will; es ist immer dieselbe Zeile. */
    const letzte = await env.DB.prepare(`
      SELECT 1 FROM bewertungen
      WHERE autor_id = ? AND NOT (ziel_art = ? AND ziel_id = ?)
        AND coalesce(geaendert, erstellt) > datetime('now', ?) LIMIT 1
    `).bind(ich.id, ziel.art, ziel.id, `-${BEWERTSPERRE} seconds`).first();
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
      const neu = await env.DB.prepare(`
        INSERT INTO kommentare (ziel_art, ziel_id, autor_id, bewertung_id, text, bild_key, sterne)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).bind(ziel.art, ziel.id, ich.id, b.id, text, bi.key, JSON.stringify(s.sterne)).first();
      // Auch hier, nicht nur an /api/kommentar: "5 Sterne und ein Link dazu"
      // kommt als EINE Anfrage genau hier an - samt dem "x" am Schreibfeld.
      if (!daten.ohne_vorschau) vorschauHolen(request, env, ctx, neu.id, text, ziel);
    }

    /* Der Bezug haengt an der Bewertung, nicht am Zeitpunkt: der UPSERT gibt
       bei einer Nachbesserung dieselbe Id zurueck, und die Doppel-Sperre laesst
       die zweite Mail dann liegen. Genau richtig - "Basti hat dir Sterne
       gegeben" ist eine Nachricht, kein Abonnement auf sein Nachjustieren. */
    if (bewerteter && bewerteter !== ich.id) {
      mailEcho(env, ctx, bewerteter, ich.name, ziel.art === 'user'
        ? { kurz: 'Sterne für dich', lang: `${ich.name} hat dir Sterne gegeben.` }
        : { kurz: 'Sterne für deinen Abend', lang: `${ich.name} hat deinen Abend bewertet.` },
        `bewertung:${b.id}`);
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
  /* GIFs suchen. Giphy statt Tenor - Google hat dessen API am 30.06.2026
     abgeschaltet (siehe ideas/gifs-und-memes.md). Der Bearer-Token macht
     daraus keinen offenen Suchdienst auf unsere Rechnung; die
     Referer-Pruefung wie bei /api/kachel ist die zweite, hoefliche Schicht
     darueber - hier tatsaechlich zweitrangig, weil ein `fetch()` von unserer
     eigenen Seite ohnehin einen Referer mitschickt.

     Ohne `q` kommt das gerade Angesagte - der Zustand, den das Blatt beim
     Oeffnen zeigt, bevor getippt wurde. Gecacht wird nur das aufbereitete
     Ergebnis, nicht die rohe Giphy-Antwort mitsamt CORS-Koepfen - so bleibt
     der Cache-Eintrag unabhaengig vom Origin des jeweiligen Aufrufers. */
  'GET /api/gif': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!env.GIPHY_KEY) return fehler(request, 'GIFs sind nicht eingerichtet', 503);

    const ref = request.headers.get('Referer');
    if (ref) {
      let fremd = true;
      try { fremd = !ERLAUBTE_HERKUNFT.has(new URL(ref).origin); } catch {}
      if (fremd) return fehler(request, 'Nicht von hier', 403);
    }

    const p = new URL(request.url).searchParams;
    const q = String(p.get('q') || '').trim().toLowerCase().slice(0, GIF_SUCHE_MAX);
    const weiter = Math.max(0, Math.trunc(Number(p.get('weiter'))) || 0);

    /* Der Schluessel ist die aufgeraeumte Suche, nicht die eingehende Anfrage
       - sonst waere ein Cache-Buster oder eine andere Parameterreihenfolge
       ein eigener Eintrag, und der Cache traefe nie. */
    const schluessel = new Request(
      `https://gif.invalid/${q ? 'suche/' + encodeURIComponent(q) : 'angesagt'}?weiter=${weiter}`);
    const lager = caches.default;
    const schon = await lager.match(schluessel);
    if (schon) return antwort(request, await schon.json());

    const params = new URLSearchParams({
      api_key: env.GIPHY_KEY, limit: String(GIF_LIMIT), offset: String(weiter), rating: 'pg-13',
    });
    if (q) { params.set('q', q); params.set('lang', 'de'); }
    const basis = q ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending';

    const oben = await fetch(`${basis}?${params}`);
    if (!oben.ok) return fehler(request, 'Giphy antwortet gerade nicht', 502);
    const daten = await oben.json().catch(() => null);
    if (!daten) return fehler(request, 'Giphy antwortet gerade nicht', 502);

    const treffer = (daten.data || []).map(g => {
      const b = g.images?.fixed_width_small || g.images?.fixed_height_small || {};
      return {
        id: g.id,
        vorschau: b.url || null,
        breite: Number(b.width) || 200,
        hoehe: Number(b.height) || 200,
        titel: g.title || '',
      };
    }).filter(t => t.vorschau);

    if (ctx) ctx.waitUntil(lager.put(schluessel, new Response(JSON.stringify(treffer), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GIF_CACHE_TTL}` },
    })));
    return antwort(request, treffer);
  },

  // -------------------------------------------------------------------------
  /* Das ausgewaehlte GIF nach R2 holen - dieselbe Antwortform wie
     /api/bild, damit das Frontend keinen zweiten Weg braucht. Der Worker
     baut die Adresse SELBST aus der `id`, ruft also nie eine vom Browser
     geschickte Adresse ab - sonst waere die Route ein offener Bildproxy.
     `200.gif` ist Giphys Fassung mit 200 px Hoehe, typisch 200-800 kB.

     NACHTRAG (Migration 0022, Link-Vorschau): dieser Satz gilt fuer DIESE
     Route, nicht mehr fuer den ganzen Worker. `vorschauBesorgen()` ruft sehr
     wohl eine Adresse ab, die ein Nutzer getippt hat - das war eine bewusste
     Ausnahme, und ihr Ersatz ist `darfGeholtWerden()` samt Weiterleitungen von
     Hand. Wer eine dritte solche Stelle baut, geht durch dasselbe Gatter. */
  'POST /api/gif/holen': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);
    if (!env.BILDER) return fehler(request, 'Bilder sind nicht eingerichtet', 503);
    if (!env.GIPHY_KEY) return fehler(request, 'GIFs sind nicht eingerichtet', 503);

    const ref = request.headers.get('Referer');
    if (ref) {
      let fremd = true;
      try { fremd = !ERLAUBTE_HERKUNFT.has(new URL(ref).origin); } catch {}
      if (fremd) return fehler(request, 'Nicht von hier', 403);
    }

    const daten = await json(request);
    const id = String(daten?.id ?? '');
    if (!GIF_ID.test(id)) return fehler(request, 'Das ist keine gültige GIF-Kennung');

    /* Dieselbe Sperre wie beim Foto-Upload, aus demselben Grund: das Holen
       laeuft vor der Kommentarsperre. Ein GIF zaehlt gegen dasselbe
       Tagesbudget wie ein Foto - der Deckel ist ein Speicherdeckel, dem ist
       gleich, ob das Objekt fotografiert oder gesucht wurde. */
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

    /* Beim Bauen zu verifizieren: haelt dieses Adressmuster nicht mehr, ist
       der Umweg ein zusaetzlicher GET /v1/gifs/<id> gegen die API - kostet
       einen Abruf vom Stundendeckel, sonst nichts. */
    const oben = await fetch(`https://i.giphy.com/media/${id}/200.gif`);
    if (!oben.ok) return fehler(request, 'Das GIF gibt es nicht (mehr)', 404);

    const angesagt = Number(oben.headers.get('Content-Length') || 0);
    if (angesagt > BILD_MAX) return fehler(request, 'Das GIF ist zu groß', 413);
    const bytes = await oben.arrayBuffer();
    if (bytes.byteLength > BILD_MAX) return fehler(request, 'Das GIF ist zu groß', 413);

    const typ = bildTyp(bytes);
    if (!typ || typ[1] !== 'gif') return fehler(request, 'Das war kein GIF', 415);

    const key = `${crypto.randomUUID()}.gif`;
    await env.BILDER.put(key, bytes, {
      httpMetadata: { contentType: 'image/gif', cacheControl: 'public, max-age=31536000, immutable' },
    });

    await env.DB.prepare('INSERT INTO bild_uploads (autor_id, bild_key) VALUES (?, ?)')
      .bind(ich.id, key).run();

    return antwort(request, { key, bild: bildUrl(env, key) }, 201);
  },

  // -------------------------------------------------------------------------
  /* Meme-Vorlagen von Imgflip - beschriftet wird bei uns, nicht dort (siehe
     ideas/gifs-und-memes.md, Abschnitt 4). `get_memes` ist gratis und
     braucht kein Konto, rund 100 Klassiker. Abgespeckt auf das, was das
     Raster braucht - die Bildadresse bleibt intern, damit die Frontend-Seite
     keinen Fremdlink in der Hand haelt, sondern immer ueber unsere Route
     geht (siehe die naechste Route, warum das noetig ist). */
  'GET /api/meme/vorlagen': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const rohe = await memeVorlagenRoh(env, ctx);
    if (!rohe) return fehler(request, 'Imgflip antwortet gerade nicht', 502);

    return antwort(request, rohe.map(m => ({ id: m.id, name: m.name, breite: m.width, hoehe: m.height })));
  },

  // -------------------------------------------------------------------------
  /* Das Vorlagenbild durch den Worker - nicht Bequemlichkeit, sondern
     Notwendigkeit: die Seite zeichnet es gleich auf ein <canvas> und liest
     die Pixel wieder aus (`toBlob()`), und das verweigert eine fremde
     Bildherkunft ohne CORS-Freigabe den Dienst.

     OHNE Bearer-Token, aus demselben Grund wie /api/kachel: die Vorschau im
     Raster ist ein gewoehnliches <img>, und das schickt keinen
     Authorization-Kopf. Schuetzenswert ist hier ohnehin nichts - dieselbe
     Vorlage liegt oeffentlich bei Imgflip, `Access-Control-Allow-Origin: *`
     ist deshalb kein Zugestaendnis, sondern ehrlich. Damit daraus trotzdem
     kein offener Bildproxy fuer FREMDE Adressen wird, geht die `id` NICHT
     roh in eine URL: sie muss in der geraden gecachten Vorlagenliste stehen,
     die Bildadresse dahinter kennt nur der Worker. Eine `id`, die dort nicht
     steht, ist ein 404 - nicht ein Abruf. */
  'GET /api/meme/vorlage': async (request, env, ctx) => {
    const id = String(new URL(request.url).searchParams.get('id') || '');
    const rohe = await memeVorlagenRoh(env, ctx);
    const vorlage = rohe && rohe.find(m => String(m.id) === id);
    if (!vorlage) return fehler(request, 'Die Vorlage gibt es nicht', 404);

    const bildSchluessel = new Request(`https://meme.invalid/vorlage/${id}`);
    const lager = caches.default;
    const schon = await lager.match(bildSchluessel);
    if (schon) return schon;

    const oben = await fetch(vorlage.url);
    if (!oben.ok) {
      return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }

    const antw = new Response(oben.body, {
      status: 200,
      headers: {
        'Content-Type': oben.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': `public, max-age=${MEME_VORLAGEN_TTL}`,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
    if (ctx) ctx.waitUntil(lager.put(bildSchluessel, antw.clone()));
    return antw;
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
    let wurzel = null, angesprochen = null, anId = null;
    if (daten.antwort_auf != null) {
      const auf = await env.DB.prepare(`
        SELECT id, antwort_auf, ziel_art, ziel_id, autor_id FROM kommentare WHERE id = ?
      `).bind(Number(daten.antwort_auf)).first();
      if (!auf) return fehler(request, 'Den Kommentar gibt es nicht', 404);
      if (auf.ziel_art !== ziel.art || auf.ziel_id !== ziel.id) {
        return fehler(request, 'Der Kommentar gehört woandershin');
      }
      wurzel = auf.antwort_auf || auf.id;
      /* Gemeldet wird dem, auf DESSEN Karte geantwortet wurde - nicht dem
         Wurzelautor. Wer einen Faden aufgemacht hat, will nicht jede Antwort
         darunter erfahren, sondern die auf das, was er gesagt hat. */
      angesprochen = auf.autor_id;
      /* Und dasselbe bleibt jetzt stehen (0020): der Baum flacht ab, der
         Adressat nicht. Bei einer Antwort auf die Wurzel ist `an_id` die
         Wurzel - dann sagt es die Einrueckung und die Seite laesst die Marke
         weg. Der Unterschied zwischen den beiden Faellen ist genau das, was
         hier festgehalten wird. */
      anId = auf.id;
    }

    const grenze = await kommentarGrenze(env, ich.id);
    if (grenze) return fehler(request, grenze.fehler, grenze.status);

    const neu = await env.DB.prepare(`
      INSERT INTO kommentare (ziel_art, ziel_id, autor_id, antwort_auf, an_id, text, bild_key)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).bind(ziel.art, ziel.id, ich.id, wurzel, anId, text, b.key).first();

    if (angesprochen && angesprochen !== ich.id) {
      mailEcho(env, ctx, angesprochen, ich.name, {
        kurz: 'Antwort auf deinen Beitrag',
        lang: `${ich.name} hat dir geantwortet: „${text.slice(0, 200)}${text.length > 200 ? ' …' : ''}"`,
      }, `kommentar:${neu.id}`);
    }

    /* Steht ein Link im Text, holt der Worker im Nachgang die Vorschaukarte
       und schiebt sie ueber den Verteiler nach. Die Antwort wartet nicht.

       `ohne_vorschau` kommt vom "x" an der Karte ueber dem Schreibfeld. Wer
       sie dort wegklickt, will sie nicht haben - und ein "x", das nur die
       Ansicht raeumt und den Kommentar dann doch mit Karte abschickt, waere
       eine Luege. Es steht NICHT in der Datenbank: was auf dem Schreibfeld
       liegt, geht raus, und beim Aendern entscheidet das Feld erneut. */
    if (!daten.ohne_vorschau) vorschauHolen(request, env, ctx, neu.id, text, ziel);

    // 'tafel' wegen des Zaehlers an der Zeile, das Ziel wegen des Threads.
    anstoss(request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
    return antwort(request, { ok: true, id: neu.id, antwort_auf: wurzel }, 201);
  },

  // -------------------------------------------------------------------------
  /* Die Vorschaukarte SCHON BEIM TIPPEN - was WhatsApp ueber dem Feld zeigt,
     sobald ein Link im Satz steht, statt erst nach dem Abschicken.

     Dieselbe Strecke wie der Weg danach, nur synchron: dasselbe Gatter
     (`darfGeholtWerden`), dieselbe Tabelle, derselbe Cache. Kein zweites
     Datenmodell, und vor allem kein zweiter Abruf - was hier geholt wurde,
     findet `vorschauHolen()` beim Abschicken als Zeile vor und haengt sie
     ohne eine einzige fremde Verbindung an den Kommentar.

     ANGEMELDET, und mit derselben Herkunftspruefung wie /api/gif/holen: diese
     Route ruft eine vom Nutzer getippte Adresse ab, und anders als der Weg
     nach dem Abschicken tut sie das, ohne dass je ein Kommentar entsteht. Die
     Bremse dagegen steht bei VORSCHAU_TAKT.

     Antwortet IMMER mit 200 und `vorschau: null`, wenn es nichts zu zeigen
     gibt - eine halb getippte Adresse, ein toter Link, eine Seite ohne OG und
     die gezogene Bremse sind fuer das Feld alle dasselbe: noch keine Karte.
     Ein Fehler waere hier eine rote Zeile beim Schreiben, und das ist keiner. */
  'POST /api/vorschau': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const ref = request.headers.get('Referer');
    if (ref) {
      let fremd = true;
      try { fremd = !ERLAUBTE_HERKUNFT.has(new URL(ref).origin); } catch {}
      if (fremd) return fehler(request, 'Nicht von hier', 403);
    }

    const daten = await json(request);
    /* KEIN `linkPutzen` mehr hier, so verlockend es aussieht: die Seite hat es
       schon getan (`ersterLink`), und die Funktion ist NICHT idempotent. Aus
       "…/a?)" macht der erste Lauf "…/a?" und der zweite "…/a" - eine Adresse,
       die beim Abschicken niemand mehr trifft, denn dort laeuft `linkAusText`
       genau einmal. Die Folge waeren ein zweiter Abruf, eine zweite Zeile und
       ein Cache, der daneben greift. Was hier ankommt, ist wortwoertlich das,
       was `ersterLink()` gefunden hat; geprueft wird es von
       `darfGeholtWerden()` und sonst nichts. */
    const roh = String(daten?.url ?? '').trim().slice(0, 2048);
    const adresse = darfGeholtWerden(roh);
    if (!adresse) return antwort(request, { fuer: roh, vorschau: null });

    const frisch = await env.DB.prepare(
      "SELECT count(*) AS n FROM vorschauen WHERE geholt > datetime('now', ?)"
    ).bind(`-${VORSCHAU_FENSTER} seconds`).first();

    const id = await vorschauBesorgen(env, adresse, frisch.n >= VORSCHAU_TAKT);
    if (!id) return antwort(request, { fuer: roh, vorschau: null });

    const z = await env.DB.prepare(
      'SELECT url, titel, text, host, bild_key FROM vorschauen WHERE id = ?'
    ).bind(id).first();
    if (!z) return antwort(request, { fuer: roh, vorschau: null });

    // Dieselben Felder wie an der Karte im Faden (siehe `hole`) - die Seite
    // zeichnet beide mit demselben Stueck Code.
    return antwort(request, { fuer: roh, vorschau: {
      url: z.url, titel: z.titel, text: z.text, host: z.host, bild: bildUrl(env, z.bild_key),
    } });
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
         Schnitt, geloescht wurde ein Kommentar, keine Note.

         Die Vorschau wird nur ABGEHAENGT, nicht geloescht: die Zeile in
         `vorschauen` gehoert keinem Kommentar, sie gehoert einer Adresse - und
         die kann unter drei anderen Karten noch stehen. */
      await env.DB.prepare(`
        UPDATE kommentare
        SET geloescht_am = datetime('now'), text = '', bild_key = NULL, sterne = NULL,
            vorschau_id = NULL
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

    /* `vorschau_id` faellt mit dem Text. Steht danach ein anderer Link darin,
       waere die alte Karte falsch - und schlimmer: "aendern" waere sonst der
       Weg, eine beliebige Vorschaukarte unter einen beliebigen Text zu haengen.
       Also erst abhaengen, dann neu holen (`vorschauHolen` schreibt nur in ein
       leeres Feld und nur zu genau diesem Text). Steht kein Link mehr da,
       bleibt es leer, und das ist die richtige Antwort.

       `ohne_vorschau` haengt sie hier also ab, ohne neue zu holen - das "x" am
       Schreibfeld nimmt eine Karte auch nachtraeglich wieder weg. */
    await env.DB.prepare(`
      UPDATE kommentare SET text = ?, geaendert = datetime('now'), vorschau_id = NULL
      WHERE id = ?
    `).bind(text, k.id).run();
    if (!daten.ohne_vorschau) {
      vorschauHolen(request, env, ctx, k.id, text, { art: k.ziel_art, id: k.ziel_id });
    }
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

    const roh = String(daten.art || '');
    // Erst die alten Namen uebersetzen, dann pruefen - und gespeichert wird das
    // Zeichen aus der Liste, nicht das geschickte (siehe REAKTIONEN).
    const art = REAKTIONEN_ALT[roh] || roh;
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

    /* Nicht die Zahl, sondern die Namen - die Seite zeigt auf Tippen, wer wie
       reagiert hat, und muss ihre Liste nach dem eigenen Druck sofort richtig
       haben. Gezaehlt wird daraus; eine zweite Abfrage dafuer waere eine
       Runde fuer eine Zahl, die hier schon dasteht. */
    const n = await env.DB.prepare(`
      SELECT u.name AS autor
      FROM reaktionen r
      JOIN users u ON u.id = r.autor_id
      WHERE r.kommentar_id = ? AND r.art = ?
      ORDER BY r.erstellt
    `).bind(id, art).all();
    const namen = n.results.map(z => z.autor);
    /* Nur das Ziel: Reaktionen zaehlen nicht in die Liste. Der Daumen ist die
       kleinste Handlung auf der ganzen Seite - und die, bei der das
       Nacheinander am meisten stoert. */
    anstoss(request, env, ctx, `${k.ziel_art}:${k.ziel_id}`);
    return antwort(request, { art, anzahl: namen.length, meins, namen });
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
    /* Sterne, Kommentare und Fotos sind das Persoenlichste, was hier liegt -
       seit der Tuer geht das keinen Vorbeikommenden mehr an. 401 und nicht
       403: es fehlt der Ausweis, nicht das Recht. */
    if (!ich) return fehler(request, 'Dafür muss man mitschreiben', 401);

    const ichId = ich.id;
    const stmts = [
      env.DB.prepare('SELECT ziel_art, ziel_id, sterne FROM bewertungen WHERE ziel_art = ? AND ziel_id = ?')
        .bind(ziel.art, ziel.id),
      env.DB.prepare('SELECT sterne FROM bewertungen WHERE autor_id = ? AND ziel_art = ? AND ziel_id = ?')
        .bind(ichId, ziel.art, ziel.id),
      ...baumStmts(env, ziel),
    ];
    /* Bei einem Abend haengt das Bewerten an seinem Zustand - dieselbe Regel
       wie in POST /api/bewerten, nur andersherum gelesen: die Seite soll das
       Formular gar nicht erst anbieten, statt am 409 haengenzubleiben. Wichtig
       geworden ist das mit der Chronik: dort ist jeder Abend erreichbar, auch
       der abgesagte, unter dem noch Kommentare stehen. Reitet im selben batch
       mit - ein eigener Ruf waere eine Runde fuer eine Zeile. */
    if (ziel.art === 'termin') {
      stmts.push(env.DB.prepare(`
        SELECT abgesagt_am, gastgeber_id, (beginnt_am <= datetime('now')) AS gewesen
        FROM termine WHERE id = ?
      `).bind(ziel.id));
    }
    const [alle, meins, roh, reakt, abend] = await env.DB.batch(stmts);

    const e = schnitte(alle.results).get(`${ziel.art}:${ziel.id}`);
    const kategorien = KATEGORIEN[ziel.art].map(([feld, name]) => {
      const j = e && e.je.get(feld);
      return { feld, name, schnitt: j ? note(j.summe, j.zahl) : null, anzahl: j ? j.zahl : 0 };
    });

    let eigeneSterne = null;
    if (meins.results.length) {
      try { eigeneSterne = JSON.parse(meins.results[0].sterne); } catch { eigeneSterne = null; }
    }

    /* Warum nicht - und zwar als fertiger Satz. Die Regel steht hier, also
       gehoert ihre Begruendung auch hierher: die Seite fuehrte sonst eine
       zweite Fassung davon, und zwei Fassungen laufen auseinander. Die
       Reihenfolge ist die, in der es den Leser angeht.

       Der Gastgeber steht bewusst VOR "abgesagt" und "noch nicht gewesen":
       sein Grund gilt fuer immer, die beiden anderen gehen vorbei. Andersherum
       gelesen verspraeche das Blatt ihm etwas ("wenn der Abend gewesen ist"),
       das nie eintritt. */
    const a = abend && abend.results[0];
    const darfNicht =
      /* "Zum Bewerten anmelden" stand hier, solange die Route auch ohne Token
         antwortete. Jetzt kommt bis hierher nur, wer angemeldet ist - offen
         bleibt allein der, der noch keinen Namen gewaehlt hat. */
        !ich.name                                 ? 'Erst einen Namen für die Tafel wählen.'
      : ziel.art === 'user' && ich.id === ziel.id ? 'Sich selbst bewertet man nicht.'
      : ziel.art !== 'termin'                     ? null
      : !a                                        ? 'Den Abend gibt es nicht mehr.'
      : a.gastgeber_id === ich.id                 ? 'Den eigenen Abend bewertet man nicht.'
      : a.abgesagt_am                             ? 'Abgesagt — bewertet wird ein Abend, den es gab.'
      : !a.gewesen                                ? 'Bewertet wird, wenn der Abend gewesen ist.'
      : null;

    return antwort(request, {
      ziel: `${ziel.art}:${ziel.id}`,
      ...schnittAntwort(e),
      kategorien,
      meins: eigeneSterne,
      // Sich selbst bewertet niemand, einen Abend erst hinterher - die Seite
      // soll das Formular gar nicht erst zeigen, statt am 403 bzw. 409
      // hängenzubleiben.
      darf: !darfNicht,
      darf_nicht: darfNicht,
      // Schreiben darf man ueberall, auch bei sich selbst: sonst kann der
      // Gastgeber im eigenen Thread nicht antworten.
      darf_schreiben: !!ich.name,
      kommentare: baumBauen(roh.results, reakt.results, ichId, env),
    });
  },

  // -------------------------------------------------------------------------
  /* Die Chronik: alle Abende, die gewesen sind. Die Liste auf der Seite reicht
     nur TERMINE_RUECKBLICK Tage zurueck, damit die Bestenliste nicht mit dem
     Archiv mitwaechst - die Abende dahinter gibt es aber weiter, mit Sternen
     und Kommentaren daran. Bis hierher fehlte nur der Weg zu ihrer Id.

     Geblaettert wird per KEYSET, nicht per OFFSET: kommt waehrend des
     Blaetterns ein Abend dazu - oder wird einer abgesagt und faellt heraus -,
     verschoebe ein OFFSET die ganze Liste um eins, und ein Eintrag erschiene
     doppelt oder gar nicht. Der Zeiger ist stattdessen das Paar
     (beginnt_am, id) des letzten gezeigten Eintrags; `id` als Nachschlag, weil
     zwei Abende auf dieselbe Minute fallen koennen.

     Token noetig wie bei `GET /api/bewertungen` - und aus demselben Grund:
     hier steht, wer wann bei wem war, ueber Jahre. */
  'GET /api/chronik': async (request, env) => {
    // Wie bei den Bewertungen: das Archiv ist nichts fuer Vorbeikommende.
    if (!await nutzer(request, env)) {
      return fehler(request, 'Dafür muss man mitschreiben', 401);
    }

    const url = new URL(request.url);
    const gewuenscht = Number(url.searchParams.get('anzahl'));
    const anzahl = Number.isInteger(gewuenscht) && gewuenscht > 0
      ? Math.min(gewuenscht, CHRONIK_MAX) : CHRONIK_SEITE;

    /* Der Zeiger kommt aus der eigenen Antwort zurueck und wird trotzdem
       geprueft: er geht in einen Vergleich gegen `beginnt_am`, und das ist
       eine ZEICHENKETTE. Was hier formlos durchkaeme, entschiede lexikografisch
       - '9' stuende dann hinter '2026'. */
    const roh = url.searchParams.get('vor') || '';
    const zeiger = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(roh)
      ? roh.replace('T', ' ').replace('Z', '') : '';
    const zeigerId = Number(url.searchParams.get('vor_id')) || 0;

    /* Eines mehr holen, als herausgeht: daran - und nur daran - ist zu sehen,
       ob es hinter dieser Seite noch weitergeht. Ein zweites `count(*)` ueber
       das ganze Archiv waere derselbe Satz zum doppelten Preis. */
    const zeilen = await env.DB.prepare(`
      SELECT t.id, t.gastgeber_id, t.beginnt_am, t.endet_am, t.titel, t.los_id,
             t.abgesagt_am, t.erstellt_von,
         coalesce(u.name, 'Ehemaliger') AS gastgeber,
         coalesce(e.name, 'Ehemaliger') AS eingetragen_von
      FROM termine t
      JOIN users u ON u.id = t.gastgeber_id
      LEFT JOIN users e ON e.id = t.erstellt_von
      WHERE t.beginnt_am <= datetime('now')
        AND (? = '' OR t.beginnt_am < ? OR (t.beginnt_am = ? AND t.id < ?))
      ORDER BY t.beginnt_am DESC, t.id DESC
      LIMIT ?
    `).bind(zeiger, zeiger, zeiger, zeigerId, anzahl + 1).all();

    const mehr = zeilen.results.length > anzahl;
    const seite = mehr ? zeilen.results.slice(0, anzahl) : zeilen.results;

    /* Sterne und Zaehler nur fuer DIESE Seite. Die beiden Statements der
       Bestenliste ziehen ihr Zeitfenster mit; hier waere daraus eine Abfrage
       ueber das ganze Archiv geworden, die mit jedem je bewerteten Abend
       waechst - und das ist genau, was die Chronik nicht tun soll. */
    let noten = new Map(), wieViele = new Map();
    if (seite.length) {
      const platz = seite.map(() => '?').join(',');
      const ids = seite.map(t => t.id);
      const [bew, kom] = await env.DB.batch([
        env.DB.prepare(`
          SELECT ziel_art, ziel_id, sterne FROM bewertungen
          WHERE ziel_art = 'termin' AND ziel_id IN (${platz})
        `).bind(...ids),
        env.DB.prepare(`
          SELECT ziel_art, ziel_id, count(*) AS anzahl FROM kommentare
          WHERE geloescht_am IS NULL AND ziel_art = 'termin' AND ziel_id IN (${platz})
          GROUP BY ziel_art, ziel_id
        `).bind(...ids),
      ]);
      noten = schnitte(bew.results);
      wieViele = new Map(kom.results.map(z => [z.ziel_art + ':' + z.ziel_id, z.anzahl]));
    }

    const letzte = seite[seite.length - 1];
    return antwort(request, {
      abende: seite.map(t => terminAntwort(t, noten, wieViele)),
      // Der Zeiger fuer den naechsten Griff - oder null, dann ist das Archiv zu Ende.
      weiter: mehr && letzte ? { vor: utc(letzte.beginnt_am), vor_id: letzte.id } : null,
    });
  },

  // =========================================================================
  // Das Kontor. Alle Routen hier antworten mit 403 "Nicht dein Zimmer" fuer
  // jeden, der nicht Admin ist - die Sichtbarkeit des Links auf der Seite ist
  // Kosmetik, das Tor sitzt hier. Und alle mit KEIN_FREMDER_CACHE: eine
  // Nutzerliste mit Mailadressen darf in keinem Zwischenspeicher landen.
  // =========================================================================

  /* Die Runde, wie der Wirt sie sieht. Ein Zug statt zehn Rufen: die Tabelle
     zeigt zehn Spalten je Nutzer, und zehn Unterabfragen in einer Anweisung
     sind billiger als zehn Anweisungen. Bei sechs Freunden ist das ohnehin
     nicht die Stelle, an der etwas teuer wird. */
  'GET /api/admin/nutzer': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const [leute, mails] = await env.DB.batch([
      env.DB.prepare(`
        SELECT u.id, u.name, u.email, u.rolle, u.quelle, u.erstellt,
               u.gesperrt_am, u.gesperrt_grund, u.entfernt_am,
               u.mail_stumm_am, u.mail_prefs,
               coalesce(g.name, 'Ehemaliger') AS gesperrt_von,
               (SELECT count(*) FROM tokens t      WHERE t.user_id = u.id)   AS geraete,
               (SELECT count(*) FROM reports r     WHERE r.user_id = u.id)   AS meldungen,
               (SELECT max(r.gemeldet_am) FROM reports r WHERE r.user_id = u.id) AS zuletzt,
               (SELECT count(*) FROM kommentare k  WHERE k.autor_id = u.id)  AS kommentare,
               (SELECT count(*) FROM termine  t    WHERE t.gastgeber_id = u.id) AS gastgeber,
               (SELECT count(*) FROM bewertungen b
                 WHERE b.ziel_art = 'user' AND b.ziel_id = u.id)             AS bewertet
        FROM users u
        LEFT JOIN users g ON g.id = u.gesperrt_von
        ORDER BY u.entfernt_am IS NOT NULL, u.name IS NULL, u.name COLLATE NOCASE
      `),
      env.DB.prepare(`
        SELECT count(*) AS n, sum(fehler IS NOT NULL) AS kaputt
        FROM mail_ausgang WHERE gesendet_am > datetime('now','-1 day')
      `),
    ]);

    const alle = leute.results;
    return antwort(request, {
      /* Der Kopf reitet mit, statt eine eigene Route zu bekommen: er sind
         drei Zahlen aus derselben Liste, die gerade ohnehin dasteht. */
      kopf: {
        melder:   alle.filter(u => !u.entfernt_am).length,
        aktiv:    alle.filter(u => !u.entfernt_am && !u.gesperrt_am).length,
        gesperrt: alle.filter(u => u.gesperrt_am && !u.entfernt_am).length,
        mails_24h: mails.results[0].n,
        mails_kaputt_24h: mails.results[0].kaputt || 0,
      },
      nutzer: alle.map(u => ({
        id: u.id,
        name: u.name,
        // Im Klartext, und das mit Absicht: ohne sie ist die Nutzerverwaltung
        // blind. Die Seite dahinter liegt hinter der Adminpruefung.
        email: u.email,
        rolle: u.rolle,
        gemessen: u.quelle === 'ha',
        seit: utc(u.erstellt),
        gesperrt: u.gesperrt_am
          ? { seit: utc(u.gesperrt_am), grund: u.gesperrt_grund, von: u.gesperrt_von }
          : null,
        entfernt: u.entfernt_am ? utc(u.entfernt_am) : null,
        stumm: !!u.mail_stumm_am,
        mail: mailWahl(u),
        geraete: u.geraete,
        meldungen: u.meldungen,
        zuletzt: utc(u.zuletzt),
        kommentare: u.kommentare,
        gastgeber: u.gastgeber,
        bewertet: u.bewertet,
        // Ich selbst: die Seite graut die Knoepfe aus, die ohnehin 409 gaeben.
        ich: u.id === ich.id,
      })),
    }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* EINE Route fuer alle vier Handlungen - damit die Adminpruefung und die
     drei Schutzregeln genau einmal existieren. Vier Routen waeren vier Stellen,
     an denen man "und ist er vielleicht der letzte Admin?" vergessen kann. */
  'POST /api/admin/nutzer': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const aktion = String(daten.aktion || '');
    if (!['sperren', 'entsperren', 'rolle', 'entfernen'].includes(aktion)) {
      return fehler(request, "aktion: 'sperren', 'entsperren', 'rolle' oder 'entfernen'");
    }

    const ziel = await env.DB.prepare(`
      SELECT id, name, email, rolle, quelle, gesperrt_am, entfernt_am FROM users WHERE id = ?
    `).bind(Number(daten.id)).first();
    if (!ziel) return fehler(request, 'Den gibt es nicht', 404);
    if (ziel.entfernt_am) return fehler(request, 'Der ist schon entfernt', 409);

    // --- Die drei Schutzregeln, vor jeder Handlung ---------------------------
    const gegenMich = ziel.id === ich.id;
    if (gegenMich && aktion !== 'entsperren') {
      /* Auch die Degradierung: wer sich selbst zum `user` macht, sperrt sich
         aus dem Kontor aus. Zurueck kaeme er nur ueber ADMIN_MAIL - und das
         ist der Notausgang, nicht der Weg. */
      return fehler(request, 'Das machst du nicht mit dir selbst', 409);
    }
    /* Der Dienstnutzer aus Home Assistant laesst sich nicht ENTFERNEN: das
       risse die Anbindung der Wohnung ab (`rest_command.beerstock_melden`
       bekaeme 401 auf jede Meldung). Sperren ist erlaubt, es nimmt ihn nur
       aus dem Topf. */
    if (ziel.quelle === 'ha' && aktion === 'entfernen') {
      return fehler(request, 'Der gemessene Melder bleibt — sperren ja, entfernen nein', 409);
    }
    /* Zum Admin wird, wer sich anmelden kann - und das haengt am POSTFACH,
       nicht an der Quelle. Hier stand `quelle === 'ha'` mit der Begruendung
       "ein Konto ohne Postfach kann nicht verwalten"; das war ein Fehlschluss
       aus der Annahme, der Dienstnutzer habe nie eine Adresse. In dieser
       Instanz hat er eine: `Schnix` ist der Melder aus der Wohnung UND das
       persoenliche Konto dahinter, beides dieselbe Zeile. Die Regel hätte
       ausgerechnet dieses Konto vom Kontor ausgesperrt. */
    if (aktion === 'rolle' && ziel.rolle !== 'admin' && !ziel.email) {
      return fehler(request, 'Ohne Postfach kein Admin — er käme nie herein', 409);
    }
    /* Der letzte Admin. Gezaehlt werden nur die, die es auch AUSUEBEN
       koennen - ein gesperrter Admin ist keiner (siehe `istAdmin`).

       Ehrlich dazu: heute kommt diese Pruefung nie zum Zug. Wer hier steht,
       IST ein wirkender Admin, also gibt es bei einem fremden Ziel schon
       zwei - und beim eigenen greift die Regel darueber zuerst. Sie bleibt
       trotzdem stehen: sie kostet eine Abfrage im seltenen Fall und ist das
       Netz, falls die Selbstregel je gelockert wird oder eine fuenfte Aktion
       dazukommt. Ein Kontor ohne Admin waere nur noch per SQL zu oeffnen. */
    const nimmtAdminWeg = ziel.rolle === 'admin'
      && (aktion === 'sperren' || aktion === 'entfernen' || aktion === 'rolle');
    if (nimmtAdminWeg) {
      const z = await env.DB.prepare(`
        SELECT count(*) AS n FROM users
        WHERE rolle = 'admin' AND gesperrt_am IS NULL AND entfernt_am IS NULL
      `).first();
      if (z.n <= 1) {
        return fehler(request, 'Das ist der letzte Admin — dann käme niemand mehr herein', 409);
      }
    }

    // --- Die Handlung selbst -------------------------------------------------
    let detail = null;
    if (aktion === 'sperren') {
      if (ziel.gesperrt_am) return fehler(request, 'Der ist schon gesperrt', 409);
      const grund = String(daten.grund ?? '').trim().replace(/\s+/g, ' ').slice(0, GRUND_MAX);
      detail = grund || null;
      await env.DB.prepare(`
        UPDATE users SET gesperrt_am = datetime('now'), gesperrt_von = ?, gesperrt_grund = ?
        WHERE id = ?
      `).bind(ich.id, grund || null, ziel.id).run();

    } else if (aktion === 'entsperren') {
      await env.DB.prepare(`
        UPDATE users SET gesperrt_am = NULL, gesperrt_von = NULL, gesperrt_grund = NULL
        WHERE id = ?
      `).bind(ziel.id).run();

    } else if (aktion === 'rolle') {
      // Die Postfachpruefung steht oben bei den Schutzregeln, nicht hier.
      const neu = ziel.rolle === 'admin' ? 'user' : 'admin';
      detail = neu;
      await env.DB.prepare('UPDATE users SET rolle = ? WHERE id = ?').bind(neu, ziel.id).run();

    } else {
      /* Weich. Ein hartes DELETE risse ueber `kommentare.autor_id`
         ON DELETE CASCADE die Kommentare UND deren Antworten mit, und liefe
         bei `termine.gastgeber_id` und `los.user_id` (beide ohne Kaskade) in
         einen Fremdschluesselfehler oder hinterliesse Waisen. Also: Adresse
         und Name weg, Token weg, aus Liste und Topf raus - die Beitraege
         bleiben als "Ehemaliger" stehen. Hart loeschen bleibt Handarbeit per
         SQL, mit Ansage.

         Der Name wandert ins Protokoll, bevor er verschwindet: sonst stuende
         im Kontor "entfernt: (null)". */
      detail = ziel.name || ziel.email || null;
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE users SET entfernt_am = datetime('now'),
                           email = NULL, name = NULL, name_klein = NULL,
                           mail_prefs = NULL, mail_stumm_am = NULL
          WHERE id = ?
        `).bind(ziel.id),
        env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(ziel.id),
      ]);
    }

    await env.DB.prepare(
      'INSERT INTO admin_log (admin_id, aktion, ziel_id, detail) VALUES (?, ?, ?, ?)')
      .bind(ich.id, aktion, ziel.id, detail).run();

    /* Sperren, Entfernen und der Rollenwechsel aendern die Tafel: der eine
       faellt aus dem Topf, der andere aus der Liste. Ohne Anstoss sehen die
       offenen Seiten den alten Stand bis zum naechsten Nachfassen. */
    anstoss(request, env, ctx, 'tafel');
    return antwort(request, { ok: true, aktion, id: ziel.id }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Nur Zahlenreihen, keine Texte: was hier herauskommt, wird gezeichnet.
     Die Grafiken malt die Seite selbst, ohne Fremdbibliothek.

     ZWEI Routen, EIN SQL. `/api/statistik` sieht jeder Angemeldete, es ist die
     Runde: wer wann gemeldet hat, wer Gastgeber war, was aus den Ziehungen
     wurde. `/api/admin/statistik` haengt an dieselben Abfragen den BETRIEB an
     - Mails, Anmeldungen, wer noch Post will. Das ist die Trennlinie: die
     Runde geht alle an, der Betrieb nur den Wirt.

     Die Abfragen stehen deshalb einmal da und nicht zweimal. Zweimal
     dasselbe SQL heisst: die eine Seite bekommt irgendwann einen Filter, die
     andere nicht, und niemand merkt es, weil beide Seiten fuer sich stimmig
     aussehen.

     `?tage=` waehlt das Fenster. Es gilt fuer die ZEITREIHEN - Meldungen,
     Bestand, Betrieb, Mails -, nicht fuer die beiden Ranglisten: "wer war wie
     oft Gastgeber" und der Ausgang der Ziehungen sind Fragen an die ganze
     Geschichte dieser Runde, und bei fuenf Leuten mit einem Abend die Woche
     waere eine 30-Tage-Rangliste eine Liste mit drei Zeilen. Welches Bild
     welchen Zeitraum zeigt, steht in seiner Ueberschrift - so hiessen die
     Bilder schon vorher ("Meldungen je Tag, 60 Tage").

     Der Wert kommt aus einer Liste erlaubter Zahlen und wird zusaetzlich
     gebunden statt eingesetzt: er landet in `datetime('now', ?)`. */
  'GET /api/statistik': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const { tage, fenster } = statistikFenster(request);
    const ergebnis = await env.DB.batch(statistikAbfragen(env, fenster));
    return antwort(request, { tage, ...statistikRunde(ergebnis) }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  'GET /api/admin/statistik': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const { tage, fenster } = statistikFenster(request);

    /* Alles in EINEM batch, die Runde und der Betrieb zusammen: zwei Batches
       waeren zwei Rundfluege zur Datenbank fuer eine einzige Seitenansicht. */
    const ergebnis = await env.DB.batch([
      ...statistikAbfragen(env, fenster),
      // 7 — Mails je Art, Fehler daneben.
      env.DB.prepare(`
        SELECT art, count(*) AS n, sum(fehler IS NOT NULL) AS kaputt
        FROM mail_ausgang WHERE gesendet_am > datetime('now', ?1)
        GROUP BY art ORDER BY n DESC
      `).bind(fenster),
      /* 7b — dieselben Mails, aber je Tag: die Kachel "Mails, 24 h" im Kopf
         nennt eine einzelne Zahl, und eine einzelne Zahl sagt nicht, ob das
         viel ist. Die Linie darunter schon. */
      env.DB.prepare(`
        SELECT date(gesendet_am) AS tag, count(*) AS n
        FROM mail_ausgang WHERE gesendet_am > datetime('now', ?1)
        GROUP BY tag ORDER BY tag
      `).bind(fenster),
      // Und eine Zahl ohne Bild.
      env.DB.prepare(`
        SELECT count(*) AS alle, sum(mail_stumm_am IS NULL) AS willig
        FROM users WHERE email IS NOT NULL AND entfernt_am IS NULL
      `),
      /* 8 — Aufrufe je Nutzer und Tag, im Fenster. Wird unten zu EINEM
         gestapelten Balken gebogen: die Hoehe der Saeule beantwortet "je
         Tag", die Schichten darin "je Nutzer und Tag" - zwei Fragen aus der
         einen Abfrage, wie schon bei "Betrieb je Woche". */
      env.DB.prepare(`
        SELECT z.user_id, coalesce(u.name,'Ehemaliger') AS name,
               date(z.erstellt) AS tag, count(*) AS n
        FROM zugriffe z JOIN users u ON u.id = z.user_id
        WHERE z.erstellt > datetime('now', ?1)
        GROUP BY z.user_id, tag ORDER BY tag
      `).bind(fenster),
      // 8b — dieselben Aufrufe je Nutzer, aber ueber die ganze Geschichte:
      // "insgesamt" ist keine Frage an den Zeitraum-Schalter, genau wie beim
      // Gastgeber und den Ziehungen oben.
      env.DB.prepare(`
        SELECT z.user_id, coalesce(u.name,'Ehemaliger') AS name, count(*) AS n
        FROM zugriffe z JOIN users u ON u.id = z.user_id
        GROUP BY z.user_id ORDER BY n DESC
      `),
      env.DB.prepare('SELECT count(*) AS n FROM zugriffe'),
    ]);

    const [mails, mailsJeTag, postwillig,
           aufrufeJeNutzerTag, aufrufeJeNutzer, aufrufeInsgesamt] = ergebnis.slice(STATISTIK_ABFRAGEN);

    /* Die Saeule je Tag, aus den flachen Zeilen gebaut: eine Gruppe je Tag,
       ein Feld je Nutzer darin. Die Reihenfolge der Reihen folgt der
       Rangliste `aufrufeJeNutzer` (meistbeschaeftigt zuerst) - dieselbe
       Reihenfolge, mit der die Seite ihnen Farben zuteilt. */
    const aufrufeNutzerReihen = aufrufeJeNutzer.results.map(z => ({
      feld: 'u' + z.user_id, titel: z.name,
    }));
    const tageJeAufruf = new Map();
    for (const z of aufrufeJeNutzerTag.results) {
      if (!tageJeAufruf.has(z.tag)) tageJeAufruf.set(z.tag, { tag: z.tag });
      tageJeAufruf.get(z.tag)['u' + z.user_id] = z.n;
    }
    const aufrufeJeTag = [...tageJeAufruf.values()].sort((a, b) => a.tag < b.tag ? -1 : 1);

    const p = postwillig.results[0];
    return antwort(request, {
      // Der Zeitraum geht mit zurueck: die Seite beschriftet die Bilder
      // damit, und sie soll dafuer nicht raten muessen, was sie gefragt hat.
      tage,
      ...statistikRunde(ergebnis),
      mails: mails.results.map(m => ({ ...m, kaputt: m.kaputt || 0 })),
      mails_je_tag: mailsJeTag.results,
      postwillig: { alle: p.alle, willig: p.willig || 0 },
      aufrufe_je_tag: aufrufeJeTag,
      aufrufe_nutzer_reihen: aufrufeNutzerReihen,
      aufrufe_je_nutzer: aufrufeJeNutzer.results,
      aufrufe_insgesamt: aufrufeInsgesamt.results[0].n,
    }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Der Jahresrueckblick. Wie die Bestenliste: nur fuer Angemeldete (401 ohne
     Token, kein Schaufenster). Alles in EINEM batch - jede Abfrage, die auf
     "Termine des Jahres" angewiesen ist (Abend des Jahres, dessen Kommentare),
     JOINT direkt gegen `termine`, statt eine ID-Liste aus einer vorherigen
     Antwort zu binden. Ein batch kennt seine eigenen Zwischenergebnisse nicht
     - siehe `/api/chronik` fuer den Gegenentwurf mit zwei Rundfluegen zur
     Datenbank. Hier reicht einer.

     "Tage auf Platz 1" (Eiskoenig) und die Kalt-Serie tragen den
     Tagesende-Stand per Carry-Forward fort (WRAPPED_VERFALL_TAGE bricht das
     nach einer Weile Funkstille ab) - geprueft an einer Testdatenbank durch
     einen Opus-Unteragenten, mit dem Nutzer abgestimmt (ideas/plan-wrapped.md,
     ideas/PROJECT-MEMORY.md). */
  'GET /api/wrapped': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const url = new URL(request.url);
    const jahr = Number(url.searchParams.get('jahr'));
    const heuteJahr = new Date().getUTCFullYear();
    // `String(jahr).length` allein liesse ein negatives Jahr durch (das
    // Minuszeichen zaehlt nicht mit) - deshalb zusaetzlich `jahr >= 1000`.
    if (!Number.isInteger(jahr) || jahr < 1000 || String(jahr).length !== 4) {
      return fehler(request, 'jahr: eine vierstellige Jahreszahl');
    }
    if (jahr > heuteJahr) return fehler(request, 'Dieses Jahr ist noch nicht dran');

    /* Vor dem grossen Rundflug: gibt es die Runde in diesem Jahr ueberhaupt
       schon? Billiger, hier abzubrechen, als erst den ganzen batch zu fahren
       und danach wegzuwerfen. */
    const erster = await env.DB.prepare('SELECT min(erstellt) AS erstellt FROM users').first();
    const ersteJahr = erster && erster.erstellt ? Number(erster.erstellt.slice(0, 4)) : heuteJahr;
    if (jahr < ersteJahr) return fehler(request, `Vor ${ersteJahr} gab es diese Runde noch nicht`);

    /* Datumsgrenzen. `letzterTag` ist der letzte Kalendertag, der in die
       Tagesserien eingeht - bei einem laufenden Jahr heute, sonst der 31.12.
       `jahrEndeExkl` ist die exklusive obere Grenze fuer alle datetime-
       Vergleiche (Reports, Kommentare, Bewertungen, ...), einen Tag NACH
       `letzterTag` - beide Rechnungen gelten so demselben Stichtag. */
    const jahrStart = `${jahr}-01-01`;
    const heute = new Date().toISOString().slice(0, 10);
    const silvester = `${jahr}-12-31`;
    const letzterTag = jahr === heuteJahr && heute < silvester ? heute : silvester;
    const naechsterTag = (() => {
      const d = new Date(letzterTag + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const jahrStartVoll = `${jahrStart} 00:00:00`;
    const jahrEndeExkl = `${naechsterTag} 00:00:00`;
    const jahrPrefix = `${jahr}-%`;

    const ergebnis = await env.DB.batch([
      // 0 - alle Melder, Anmeldereihenfolge = Melderfarbe auf der Seite.
      env.DB.prepare("SELECT id, coalesce(name,'Ehemaliger') AS name FROM users ORDER BY id"),

      /* 1 - Eiskoenig: Tage auf Platz 1, Tagesende-Stand mit Carry-Forward.
         `roh` schneidet die Historie auf das Jahr plus GENAU EINE Carry-in-
         Zeile je Melder (statt der ganzen Vergangenheit) - das war der
         Hebel, der die Laufzeit bei der Pruefung von 1,26s auf 0,03s brachte.
         `tages` haelt je Melder und Kalendertag nur die letzte Meldung,
         `intervall` spannt daraus Gueltigkeitsfenster, `stand` verbindet sie
         mit dem Tageskalender - mit Verfallsfrist, sonst gewinnt eine
         einzelne fruehe Meldung den Rest des Jahres. `rang` laesst Tage ohne
         jede kalte Flasche (biere = 0) ohne Sieger. */
      env.DB.prepare(`
        WITH RECURSIVE tage(tag) AS (
          SELECT date(?1) WHERE date(?1) <= ?2
          UNION ALL
          SELECT date(tag,'+1 day') FROM tage WHERE tag < ?2
        ),
        roh AS (
          SELECT r.id, r.user_id, r.biere, r.gemeldet_am
          FROM reports r
          WHERE r.gemeldet_am < datetime(?2,'+1 day')
            AND r.gemeldet_am >= coalesce(
              (SELECT max(v.gemeldet_am) FROM reports v
                WHERE v.user_id = r.user_id AND v.gemeldet_am < ?1), '')
        ),
        tages AS (
          SELECT id, user_id, biere, gemeldet_am FROM (
            SELECT id, user_id, biere, gemeldet_am,
              ROW_NUMBER() OVER (PARTITION BY user_id, date(gemeldet_am)
                                 ORDER BY gemeldet_am DESC, id DESC) AS rn
            FROM roh
          ) WHERE rn = 1
        ),
        intervall AS (
          SELECT id, user_id, biere, gemeldet_am,
            LEAD(gemeldet_am) OVER (PARTITION BY user_id ORDER BY gemeldet_am) AS bis
          FROM tages
        ),
        stand AS (
          SELECT t.tag, i.user_id, i.biere, i.gemeldet_am, i.id
          FROM tage t JOIN intervall i
            ON i.gemeldet_am < datetime(t.tag,'+1 day')
           AND (i.bis IS NULL OR i.bis >= datetime(t.tag,'+1 day'))
           AND julianday(t.tag) - julianday(date(i.gemeldet_am)) < ?3
        ),
        rang AS (
          SELECT tag, user_id,
            ROW_NUMBER() OVER (PARTITION BY tag
                               ORDER BY biere DESC, gemeldet_am ASC, id ASC) AS r
          FROM stand WHERE biere > 0
        )
        SELECT user_id, count(*) AS tage FROM rang WHERE r = 1
        GROUP BY user_id ORDER BY tage DESC, user_id
      `).bind(jahrStart, letzterTag, WRAPPED_VERFALL_TAGE),

      // 2 - wie oft im Jahr gemeldet wurde, je Monat. Kein geschaetzter
      // Verbrauch (LAG-Differenzen unterschaetzen bei Trinken-und-Nachlegen
      // zwischen zwei Meldungen systematisch) - eine ehrliche Zahl statt
      // einer geschoenten, mit dem Nutzer so abgestimmt.
      env.DB.prepare(`
        SELECT CAST(strftime('%m', gemeldet_am) AS INTEGER) AS monat, count(*) AS n
        FROM reports WHERE gemeldet_am >= ?1 AND gemeldet_am < ?2
        GROUP BY monat ORDER BY monat
      `).bind(jahrStartVoll, jahrEndeExkl),

      /* 3 - der kaelteste Moment. Die Grenze ist dieselbe wie in
         POST /api/report (MIN_GRAD/MAX_GRAD) - dort haelt sie jeden neuen
         Wert schon ein, hier faengt sie nur Ausreisser aus Altbestand oder
         einem Handgriff direkt in D1 ab (siehe ideas/PROJECT-MEMORY.md). */
      env.DB.prepare(`
        SELECT r.temperatur AS grad, r.user_id, coalesce(u.name,'Ehemaliger') AS name,
               u.quelle, r.gemeldet_am AS am
        FROM reports r JOIN users u ON u.id = r.user_id
        WHERE r.gemeldet_am >= ?1 AND r.gemeldet_am < ?2
          AND r.temperatur BETWEEN ?3 AND ?4
        ORDER BY r.temperatur ASC LIMIT 1
      `).bind(jahrStartVoll, jahrEndeExkl, MIN_GRAD, MAX_GRAD),

      // 4 - der waermste Moment, spiegelbildlich.
      env.DB.prepare(`
        SELECT r.temperatur AS grad, r.user_id, coalesce(u.name,'Ehemaliger') AS name,
               u.quelle, r.gemeldet_am AS am
        FROM reports r JOIN users u ON u.id = r.user_id
        WHERE r.gemeldet_am >= ?1 AND r.gemeldet_am < ?2
          AND r.temperatur BETWEEN ?3 AND ?4
        ORDER BY r.temperatur DESC LIMIT 1
      `).bind(jahrStartVoll, jahrEndeExkl, MIN_GRAD, MAX_GRAD),

      // 5 - das Rad: Ausgang der Ziehungen des Jahres.
      env.DB.prepare(`
        SELECT status, count(*) AS n FROM los WHERE tag LIKE ?1 GROUP BY status
      `).bind(jahrPrefix),

      // 6 - gewonnene (zugesagte) Lose je Melder.
      env.DB.prepare(`
        SELECT user_id, count(*) AS n FROM los
        WHERE tag LIKE ?1 AND status = 'zugesagt'
        GROUP BY user_id ORDER BY n DESC
      `).bind(jahrPrefix),

      // 7 - Bewertungen der Termine des Jahres, ueber den JOIN statt einer
      // ID-Liste - so bleibt alles in diesem einen batch.
      env.DB.prepare(`
        SELECT b.ziel_art, b.ziel_id, b.sterne
        FROM bewertungen b JOIN termine t ON t.id = b.ziel_id AND b.ziel_art = 'termin'
        WHERE t.beginnt_am >= ?1 AND t.beginnt_am < ?2 AND t.abgesagt_am IS NULL
      `).bind(jahrStartVoll, jahrEndeExkl),

      // 8 - Kommentar- und Fotozahl je Termin des Jahres.
      env.DB.prepare(`
        SELECT k.ziel_id, count(*) AS kommentare, sum(k.bild_key IS NOT NULL) AS fotos
        FROM kommentare k JOIN termine t ON t.id = k.ziel_id AND k.ziel_art = 'termin'
        WHERE k.geloescht_am IS NULL
          AND t.beginnt_am >= ?1 AND t.beginnt_am < ?2 AND t.abgesagt_am IS NULL
        GROUP BY k.ziel_id
      `).bind(jahrStartVoll, jahrEndeExkl),

      // 9 - die Termine des Jahres selbst: wann, bei wem.
      env.DB.prepare(`
        SELECT t.id, t.beginnt_am, t.gastgeber_id, coalesce(u.name,'Ehemaliger') AS gastgeber_name
        FROM termine t JOIN users u ON u.id = t.gastgeber_id
        WHERE t.beginnt_am >= ?1 AND t.beginnt_am < ?2 AND t.abgesagt_am IS NULL
      `).bind(jahrStartVoll, jahrEndeExkl),

      // 10 - Bewertungen fuer "Gastgeber des Jahres": die Dauer-Bewertung,
      // aber nur die Stimmen DIESES Jahres.
      env.DB.prepare(`
        SELECT ziel_id, sterne FROM bewertungen
        WHERE ziel_art = 'user' AND erstellt >= ?1 AND erstellt < ?2
      `).bind(jahrStartVoll, jahrEndeExkl),

      // 11 - wie viele Abende je Gastgeber im Jahr stattfanden.
      env.DB.prepare(`
        SELECT gastgeber_id, count(*) AS abende FROM termine
        WHERE beginnt_am >= ?1 AND beginnt_am < ?2 AND abgesagt_am IS NULL
        GROUP BY gastgeber_id
      `).bind(jahrStartVoll, jahrEndeExkl),

      // 12 - wie viele Kommentare insgesamt.
      env.DB.prepare(`
        SELECT count(*) AS n FROM kommentare
        WHERE geloescht_am IS NULL AND erstellt >= ?1 AND erstellt < ?2
      `).bind(jahrStartVoll, jahrEndeExkl),

      // 13 - die Reaktion des Jahres. `art` als zweiter Sortierschluessel
      // macht einen Gleichstand deterministisch statt zufaellig.
      env.DB.prepare(`
        SELECT art, count(*) AS n FROM reaktionen
        WHERE erstellt >= ?1 AND erstellt < ?2
        GROUP BY art ORDER BY n DESC, art LIMIT 1
      `).bind(jahrStartVoll, jahrEndeExkl),

      /* 14 - Bilder und GIFs, aus den tatsaechlich abgeschickten Kommentaren
         (nicht `bild_uploads`, die zaehlt auch Verwaistes mit). Fotos und
         Memes sind serverseitig nicht zu unterscheiden - beide laufen als
         image/jpeg ueber /api/bild, siehe ideas/gifs-und-memes.md. Deshalb
         zwei Kacheln statt der im Plan skizzierten drei: Bilder und GIFs. */
      env.DB.prepare(`
        SELECT sum(bild_key LIKE '%.gif') AS gifs,
               sum(bild_key NOT LIKE '%.gif') AS bilder
        FROM kommentare
        WHERE geloescht_am IS NULL AND bild_key IS NOT NULL
          AND erstellt >= ?1 AND erstellt < ?2
      `).bind(jahrStartVoll, jahrEndeExkl),

      /* 15 - Ich: die Kalt-Serie. Dieselbe Tagesserie wie Eiskoenig, aber auf
         den Abrufenden zugeschnitten - die Historie ist schon in `roh` auf
         diesen einen Nutzer gefiltert statt erst danach, das haelt die
         Pipeline auf einem Bruchteil der Zeilen (Empfehlung aus der
         Pruefung). */
      env.DB.prepare(`
        WITH RECURSIVE tage(tag) AS (
          SELECT date(?1) WHERE date(?1) <= ?2
          UNION ALL
          SELECT date(tag,'+1 day') FROM tage WHERE tag < ?2
        ),
        roh AS (
          SELECT r.id, r.biere, r.temperatur, r.gemeldet_am
          FROM reports r
          WHERE r.user_id = ?3
            AND r.gemeldet_am < datetime(?2,'+1 day')
            AND r.gemeldet_am >= coalesce(
              (SELECT max(v.gemeldet_am) FROM reports v
                WHERE v.user_id = ?3 AND v.gemeldet_am < ?1), '')
        ),
        tages AS (
          SELECT id, biere, temperatur, gemeldet_am FROM (
            SELECT id, biere, temperatur, gemeldet_am,
              ROW_NUMBER() OVER (PARTITION BY date(gemeldet_am)
                                 ORDER BY gemeldet_am DESC, id DESC) AS rn
            FROM roh
          ) WHERE rn = 1
        ),
        intervall AS (
          SELECT id, biere, temperatur, gemeldet_am,
            LEAD(gemeldet_am) OVER (ORDER BY gemeldet_am) AS bis
          FROM tages
        ),
        mein AS (
          SELECT t.tag, i.biere, i.temperatur
          FROM tage t JOIN intervall i
            ON i.gemeldet_am < datetime(t.tag,'+1 day')
           AND (i.bis IS NULL OR i.bis >= datetime(t.tag,'+1 day'))
           AND julianday(t.tag) - julianday(date(i.gemeldet_am)) < ?4
        ),
        markiert AS (
          SELECT tag, CASE WHEN biere > 0 AND temperatur < ?5 THEN 1 ELSE 0 END AS kalt
          FROM mein
        ),
        inseln AS (
          SELECT tag, kalt,
            julianday(tag) - ROW_NUMBER() OVER (PARTITION BY kalt ORDER BY tag) AS grp
          FROM markiert
        )
        SELECT min(tag) AS von, max(tag) AS bis, count(*) AS laenge
        FROM inseln WHERE kalt = 1
        GROUP BY grp ORDER BY laenge DESC, von ASC LIMIT 1
      `).bind(jahrStart, letzterTag, ich.id, WRAPPED_VERFALL_TAGE, WRAPPED_KALT_GRAD),

      // 16 - Ich: das eigene kaelteste Bier des Jahres.
      env.DB.prepare(`
        SELECT min(temperatur) AS grad FROM reports
        WHERE user_id = ?1 AND gemeldet_am >= ?2 AND gemeldet_am < ?3
      `).bind(ich.id, jahrStartVoll, jahrEndeExkl),

      // 17 - Ich: die Sterne, die ich in diesem Jahr vergeben habe.
      env.DB.prepare(`
        SELECT sterne FROM bewertungen
        WHERE autor_id = ?1 AND erstellt >= ?2 AND erstellt < ?3
      `).bind(ich.id, jahrStartVoll, jahrEndeExkl),
    ]);

    const [
      leute, eiskoenigZeilen, meldungenJeMonat, kaeltester, waermster,
      radUebersicht, radGewonnen, abendBewertungen, abendKommentare, abendListe,
      gastgeberBewertungen, gastgeberAbende, kommentareZahl, reaktionDesJahres,
      bilderSplit, ichKaltSerie, ichKaeltestes, ichSterneVergeben,
    ] = ergebnis;

    const namen = new Map(leute.results.map(u => [u.id, u.name]));
    const mitName = (zeilen, feld = 'user_id') =>
      zeilen.map(z => ({ ...z, name: namen.get(z[feld]) || 'Ehemaliger' }));

    // -- Eiskoenig ------------------------------------------------------------
    const eiskoenig = mitName(eiskoenigZeilen.results)
      .map(z => ({ id: z.user_id, name: z.name, tage: z.tage }));

    // -- wie oft gemeldet wurde, je Monat --------------------------------------
    const meldungMonat = Array(12).fill(0);
    for (const z of meldungenJeMonat.results) meldungMonat[z.monat - 1] = z.n;
    const meldungSumme = meldungMonat.reduce((a, c) => a + c, 0);

    // -- kaeltester/waermster Moment -------------------------------------------
    const momentAntwort = z => z ? {
      grad: z.grad, userId: z.user_id, name: z.name,
      gemessen: z.quelle === 'ha', am: utc(z.am),
    } : null;

    // -- das Rad ----------------------------------------------------------------
    const radZeilen = new Map(radUebersicht.results.map(z => [z.status, z.n]));
    const ziehungen = [...radZeilen.values()].reduce((a, c) => a + c, 0);
    const zugesagt = radZeilen.get('zugesagt') || 0;
    const quoteNenner = zugesagt + (radZeilen.get('abgelehnt') || 0) + (radZeilen.get('verfallen') || 0);
    const rad = ziehungen ? {
      ziehungen, zusagen: zugesagt,
      quote: quoteNenner ? Math.round(zugesagt / quoteNenner * 100) : 0,
      gewonnen: mitName(radGewonnen.results).map(z => ({ id: z.user_id, name: z.name, n: z.n })),
    } : null;

    // -- Abend des Jahres: bester Schnitt ab 2 Bewertungen, aelterer bei Gleichstand --
    const abendNoten = schnitte(abendBewertungen.results);
    const abendKommentareJe = new Map(
      abendKommentare.results.map(z => [z.ziel_id, { kommentare: z.kommentare, fotos: z.fotos || 0 }]));
    let abendGewinner = null;
    for (const t of abendListe.results) {
      const e = abendNoten.get(`termin:${t.id}`);
      if (!e || e.anzahl < 2) continue;
      const schnitt = note(e.summe, e.zahl);
      // note() gibt null, wenn niemand eine Kategorie ausgefuellt hat (nur
      // ein leerer Tap) - ohne diese Waeche wuerde .toFixed() weiter unten
      // auf null aufschlagen und das ganze Blatt risse ab.
      if (schnitt == null) continue;
      if (!abendGewinner || schnitt > abendGewinner.schnitt
          || (schnitt === abendGewinner.schnitt && t.beginnt_am < abendGewinner.t.beginnt_am)) {
        abendGewinner = { t, schnitt, e };
      }
    }
    const abend = abendGewinner ? (() => {
      const { t, schnitt, e } = abendGewinner;
      const k = abendKommentareJe.get(t.id) || { kommentare: 0, fotos: 0 };
      return {
        terminId: t.id, wann: utc(t.beginnt_am), gastgeberName: t.gastgeber_name, schnitt,
        sterne: KATEGORIEN.termin.map(([feld, name]) => {
          const j = e.je.get(feld);
          return { feld, name, schnitt: j ? note(j.summe, j.zahl) : null };
        }),
        kommentare: k.kommentare, fotos: k.fotos,
      };
    })() : null;

    // -- Gastgeber des Jahres: bester Schnitt ab 2 Bewerten --------------------
    const gastgeberNoten = schnitte(
      gastgeberBewertungen.results.map(z => ({ ziel_art: 'user', ziel_id: z.ziel_id, sterne: z.sterne })));
    const abendeJeGastgeber = new Map(gastgeberAbende.results.map(z => [z.gastgeber_id, z.abende]));
    let gastgeberGewinner = null;
    for (const [schluessel, e] of gastgeberNoten) {
      if (e.anzahl < 2) continue;
      const id = Number(schluessel.split(':')[1]);
      const schnitt = note(e.summe, e.zahl);
      if (schnitt == null) continue;
      // Bei Gleichstand die kleinere id - ohne Tie-Break haengt der Sieger
      // an der Map-Reihenfolge, und die ist nicht garantiert stabil.
      if (!gastgeberGewinner || schnitt > gastgeberGewinner.schnitt
          || (schnitt === gastgeberGewinner.schnitt && id < gastgeberGewinner.id)) {
        gastgeberGewinner = { id, schnitt };
      }
    }
    const gastgeber = gastgeberGewinner ? {
      id: gastgeberGewinner.id, name: namen.get(gastgeberGewinner.id) || 'Ehemaliger',
      schnitt: gastgeberGewinner.schnitt, abende: abendeJeGastgeber.get(gastgeberGewinner.id) || 0,
    } : null;

    // -- was gesagt wurde ---------------------------------------------------------
    const reaktion = reaktionDesJahres.results[0] || null;
    const bilderZeile = bilderSplit.results[0] || {};
    const gesagtes = {
      kommentare: kommentareZahl.results[0].n,
      reaktion: reaktion ? reaktion.art : null,
      reaktionN: reaktion ? reaktion.n : 0,
      bilder: bilderZeile.bilder || 0,
      gifs: bilderZeile.gifs || 0,
    };

    // -- Ich -------------------------------------------------------------------
    const serie = ichKaltSerie.results[0] || null;
    let sterneVergeben = 0;
    for (const z of ichSterneVergeben.results) {
      let s; try { s = JSON.parse(z.sterne); } catch { continue; }
      for (const wert of Object.values(s)) if (Number.isFinite(wert)) sterneVergeben++;
    }
    const meinPlatz1 = eiskoenigZeilen.results.find(z => z.user_id === ich.id);
    const ichAntwort = {
      serie: serie ? serie.laenge : 0,
      serieVon: serie ? serie.von : null,
      platz1: meinPlatz1 ? meinPlatz1.tage : 0,
      kaeltestes: ichKaeltestes.results[0].grad,
      sterneVergeben,
      abendeAusgerichtet: abendeJeGastgeber.get(ich.id) || 0,
    };

    return antwort(request, {
      jahr,
      runde: {
        eiskoenig,
        meldungen: meldungSumme ? { summe: meldungSumme, monat: meldungMonat } : null,
        kaeltester: momentAntwort(kaeltester.results[0]),
        waermster: momentAntwort(waermster.results[0]),
        rad, abend, gastgeber, gesagtes,
      },
      ich: ichAntwort,
      // Ein abgeschlossenes Jahr aendert sich nie wieder - die Edge darf es
      // laenger halten. Das laufende Jahr bleibt privat/kurz wie die Bestenliste.
    }, 200, jahr < heuteJahr
      ? { 'Cache-Control': 'private, max-age=86400', 'Vary': 'Origin, Authorization' }
      : KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Die Rundmail, sofort. Geht durch denselben Verteiler wie alles andere -
     also auch nur an die, die sie wollen, und mit demselben Abmeldelink.
     Ohne `bezug`, damit die Doppel-Sperre sie nicht nach der ersten fuer
     immer blockiert; gegen den Fehlgriff steht die Stundensperre in
     `rundmailAbschicken`. */
  'POST /api/admin/rundmail': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);

    try {
      const wieViele = await rundmailAbschicken(env, ctx, ich.id, geprueft);
      return antwort(request, { ok: true, empfaenger: wieViele }, 200, KEIN_FREMDER_CACHE);
    } catch (e) {
      if (e.sperre) return fehler(request, e.message, 429);
      throw e;
    }
  },

  // -------------------------------------------------------------------------
  /* Die Testmail - nur an den Admin selbst, der gerade im Kontor sitzt, und
     bewusst AUSSERHALB von `rundmailAbschicken`: keine Stundensperre (sie
     wuerde sonst den echten Versand danach blockieren), kein `admin_log`
     (sonst stuende sie im Protokoll als Rundmail), kein `mail_ausgang` (sonst
     zaehlte sie in der Mail-Statistik mit). Direkt `schickeMail`, mit einem
     Praefix im Betreff, damit sie im Postfach nicht mit einer echten
     verwechselt wird. */
  'POST /api/admin/rundmail/test': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);
    if (!ich.email) return fehler(request, 'Ohne eigene Adresse keine Testmail');

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);

    await schickeMail(env, ich.email, `[Test] ${geprueft.betreff}`,
      rundmailText(geprueft), mailRumpf(rundmailHtml(geprueft)));

    return antwort(request, { ok: true, email: ich.email }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Dieselbe Rundmail, aber fuer spaeter vorgemerkt statt sofort geschickt -
     editierbar und verwerfbar, solange sie noch ansteht. Der Versand selbst
     laeuft ueber `rundmailGeplantVersenden`, angestossen vom zehnminuetigen
     Cron in `scheduled()`. */
  'POST /api/admin/rundmail/planen': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);
    const p = pruefeVersand(daten.versand_am);
    if (p.fehler) return fehler(request, p.fehler);

    const zeile = await env.DB.prepare(`
      INSERT INTO rundmail_geplant
        (admin_id, betreff, text, bild_url, knopf_text, knopf_link, versand_am)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(ich.id, geprueft.betreff, geprueft.text, geprueft.bildUrl,
            geprueft.knopfText, geprueft.knopfLink, alsDbZeit(p.d)).first();

    return antwort(request, { ok: true, id: zeile.id }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  'GET /api/admin/rundmail/geplant': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    // 'fehlgeschlagen' steht mit da, sonst verschwindet eine Rundmail, deren
    // Versand scheiterte (etwa an der Stundensperre), spurlos aus der Liste.
    const zeilen = await env.DB.prepare(`
      SELECT id, betreff, text, bild_url, knopf_text, knopf_link,
             versand_am, status, fehler, empfaenger, erstellt
      FROM rundmail_geplant
      WHERE status IN ('geplant', 'fehlgeschlagen')
      ORDER BY versand_am
    `).all();

    return antwort(request, {
      zeilen: zeilen.results.map(z => ({
        id: z.id, betreff: z.betreff, text: z.text,
        bild_url: z.bild_url, knopf_text: z.knopf_text, knopf_link: z.knopf_link,
        versand_am: utc(z.versand_am), status: z.status, fehler: z.fehler,
        empfaenger: z.empfaenger, erstellt: utc(z.erstellt),
      })),
    }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Aendern oder verwerfen - eine Route fuer beides, wie bei
     '/api/kommentar/aendern'. Geht nur, solange die Rundmail noch 'geplant'
     ist: einmal rausgegangen oder fehlgeschlagen ruehrt niemand mehr dran. */
  'POST /api/admin/rundmail/geplant/aendern': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const daten = await json(request);
    if (!daten || !daten.id) return fehler(request, 'Ohne id kein Ziel');

    const zeile = await env.DB.prepare(
      'SELECT status FROM rundmail_geplant WHERE id = ?').bind(daten.id).first();
    if (!zeile) return fehler(request, 'Die gibt es nicht (mehr)', 404);
    if (zeile.status !== 'geplant') {
      return fehler(request,
        'Die ist schon dran oder weg — daran lässt sich nichts mehr ändern', 409);
    }

    if (daten.verwerfen) {
      await env.DB.prepare('DELETE FROM rundmail_geplant WHERE id = ?').bind(daten.id).run();
      return antwort(request, { ok: true }, 200, KEIN_FREMDER_CACHE);
    }

    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);
    const p = pruefeVersand(daten.versand_am);
    if (p.fehler) return fehler(request, p.fehler);

    await env.DB.prepare(`
      UPDATE rundmail_geplant SET
        betreff = ?, text = ?, bild_url = ?, knopf_text = ?, knopf_link = ?, versand_am = ?
      WHERE id = ?
    `).bind(geprueft.betreff, geprueft.text, geprueft.bildUrl,
            geprueft.knopfText, geprueft.knopfLink, alsDbZeit(p.d), daten.id).run();

    return antwort(request, { ok: true }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  'GET /api/admin/protokoll': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const zeilen = await env.DB.prepare(`
      SELECT l.id, l.aktion, l.detail, l.erstellt,
             coalesce(a.name, 'Ehemaliger') AS wer,
             coalesce(z.name, l.detail, '—') AS wen
      FROM admin_log l
      LEFT JOIN users a ON a.id = l.admin_id
      LEFT JOIN users z ON z.id = l.ziel_id
      ORDER BY l.id DESC LIMIT 50
    `).all();

    return antwort(request, {
      zeilen: zeilen.results.map(z => ({
        id: z.id, aktion: z.aktion, wer: z.wer, wen: z.wen,
        detail: z.detail, wann: utc(z.erstellt),
      })),
    }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Die Kartenkacheln, durch den Worker statt direkt aus dem Browser.
     -------------------------------------------------------------------------
     WARUM UEBERHAUPT UEBER UNS. Eine Kachel-URL IST der Standort: `/16/35123/
     22546.png` ist ein Quadrat von rund 600 Metern. Holte der Browser sie
     selbst, wuesste ein fremder Server die IP des Nutzers, den Referer auf
     diese Seite und die Koordinaten, minutengenau - und zwar genau in dem
     Moment, in dem jemand einen Notruf absetzt. Das ist formgleich mit der
     Spur, wegen der `status.json` abgeschafft wurde, nur praeziser. So sieht
     der Kachelserver Cloudflare und sonst nichts.

     WAS DAS KOSTET. Die Nutzungsbedingungen von tile.openstreetmap.org raten
     von einem eigenen Cache-Proxy ausdruecklich ab ("we generally do not
     recommend"). Erlaubt bleibt er unter Auflagen, und die sind hier alle
     erfuellt:
       - ein eigener, sprechender User-Agent mit Kontakt (Vorgabewerte von
         Bibliotheken werden ohne Vorwarnung gesperrt),
       - Cache-Kopfe des Servers achten oder mindestens sieben Tage halten -
         wir nehmen den laengeren der beiden Werte,
       - kein Vorabholen. Geholt wird ausschliesslich, was gerade jemand
         ansieht; die Karte der Seite laedt nichts auf Vorrat. Wer hier je
         eine Vorabladung einbaut ("die Nachbarkacheln schon mal"), verstoesst
         gegen genau diesen Punkt.
     Bei einer Runde von sechs Freunden und ein paar Dutzend Kacheln je Notruf
     ist das weit von "heavy use" entfernt. Wird die Route je oeffentlicher,
     gehoert sie auf einen Anbieter mit Schluessel.

     OFFEN, ABER NICHT FUER JEDEN. Ein `<img>` kann keinen Authorization-Kopf
     schicken, die Route kann also kein Token verlangen. Sie traegt aber auch
     nichts Schuetzenswertes aus - dieselbe Kachel bekommt jeder direkt bei
     OSM. Die Herkunftspruefung ist deshalb keine Sicherung, sondern eine
     Hoeflichkeit gegen fremde Seiten, die sich hier einen kostenlosen
     Kachelserver einrichten und uns die Sperre einbringen. Fehlt der Referer
     ganz (manche Browser streichen ihn), geht es durch. */
  'GET /api/kachel': async (request, env, ctx) => {
    const p = new URL(request.url).searchParams;
    const z = Number(p.get('z')), x = Number(p.get('x')), y = Number(p.get('y'));
    if (!Number.isInteger(z) || z < KACHEL_ZOOM_MIN || z > KACHEL_ZOOM_MAX) {
      return fehler(request, `z: ganze Zahl zwischen ${KACHEL_ZOOM_MIN} und ${KACHEL_ZOOM_MAX}`);
    }
    const kante = 2 ** z;
    if (!Number.isInteger(x) || x < 0 || x >= kante
        || !Number.isInteger(y) || y < 0 || y >= kante) {
      return fehler(request, `x/y: ganze Zahl zwischen 0 und ${kante - 1}`);
    }

    const ref = request.headers.get('Referer');
    if (ref) {
      let fremd = true;
      try { fremd = !ERLAUBTE_HERKUNFT.has(new URL(ref).origin); } catch {}
      if (fremd) return fehler(request, 'Nicht von hier', 403);
    }

    /* Der Schluessel ist eine eigene, aufgeraeumte URL und NICHT die
       eingehende Anfrage: die traegt je nach Aufrufer noch einen
       Cache-Buster oder eine andere Parameterreihenfolge, und jede Variante
       waere ein eigener Eintrag im Cache - der Proxy holte dann doch wieder
       jedes Mal bei OSM. */
    const schluessel = new Request(
      `https://kachel.invalid/${z}/${x}/${y}.png`, { method: 'GET' });
    const lager = caches.default;
    const schon = await lager.match(schluessel);
    if (schon) return schon;

    const oben = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
      headers: {
        // Sprechend und mit Kontakt, wie die Bedingungen es verlangen.
        'User-Agent': `beerstock/1.0 (+${env.SEITE || 'https://schnix84.github.io/beerstock/'})`,
        'Accept': 'image/png,image/*;q=0.8',
      },
    });
    if (!oben.ok) {
      // Kein 500er: eine fehlende Kachel ist ein Loch in der Karte, kein
      // kaputter Dienst. Die Seite zeichnet an der Stelle schlicht nichts.
      return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }

    /* Sieben Tage oder laenger - was der Server selbst sagt, wenn es mehr ist.
       `immutable` fehlt mit Absicht: eine Kachel aendert sich sehr wohl, wenn
       jemand die Karte verbessert, nur eben selten. */
    const eigene = Math.max(KACHEL_TTL, alterAus(oben.headers.get('Cache-Control')));
    const antw = new Response(oben.body, {
      status: 200,
      headers: {
        'Content-Type': oben.headers.get('Content-Type') || 'image/png',
        'Cache-Control': `public, max-age=${eigene}`,
        // Kachelbilder gehen als <img> in die Seite, dafuer braucht es kein
        // CORS - und ohne Freigabe kann sie auch niemand auslesen.
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
    // Eine Kopie ins Lager, die andere an den Aufrufer. Ohne `clone` liest
    // eine der beiden Seiten aus einem Koerper, der schon weg ist.
    if (ctx) ctx.waitUntil(lager.put(schluessel, antw.clone()));
    return antw;
  },

  'GET /api/leaderboard': async (request, env) => {
    /* Alles fuer eine Seitenansicht in einem Rutsch: aktueller Stand,
       Bestmarke, Verlauf, das Gluecksrad (Ziehung des Tages + wer heute im
       Topf ist) und die Termine. Der aktuelle Stand ist die juengste Meldung
       je Nutzer - deshalb wird nie ueberschrieben, der Verlauf faellt dabei
       von selbst an.
       Alles reitet hier mit statt auf eigenen Routen: eine Runde weniger, ein
       Cache-Verhalten weniger, und die Seite fragt ohnehin im Minutentakt nach.

       Ohne Token gibt es davon nur den Siegerplatz - wer fuehrt, mit wie viel
       und wie kalt. Das ist der Koeder, den die Seite draussen zeigt; das Feld
       dahinter, das Rad, die Abende und das Archiv gehen Vorbeikommende nichts
       an. Die eine kleine Abfrage steht bewusst VOR dem grossen `batch`:
       anonym kostet die Route dann eine Zeile statt neun Abfragen, und die
       Seite, die im Minutentakt nachfasst, ist die haeufigste Aufruferin. */
    const ich = await nutzer(request, env);
    if (!ich) {
      const spitze = await env.DB.prepare(`
        SELECT u.name, u.quelle, r.biere, r.temperatur, r.gemeldet_am,
               (SELECT max(biere) FROM reports WHERE user_id = u.id) AS best
        FROM users u
        JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j
          ON j.user_id = u.id
        JOIN reports r ON r.id = j.id
        WHERE u.name IS NOT NULL
        ORDER BY r.biere DESC, r.gemeldet_am ASC
        LIMIT 1
      `).first();

      /* Ohne `id`: eine Id waere die Adresse einer Bewertung, und die Routen
         dahinter sind jetzt zu. Ohne Verlauf und ohne Sternschnitt aus
         demselben Grund - der Kopf der Seite zeichnet sie nicht. */
      return antwort(request, {
        feld: spitze ? [{
          name: spitze.name,
          biere: spitze.biere,
          temperatur: spitze.temperatur,
          gemeldet: spitze.gemeldet_am.replace(' ', 'T') + 'Z',
          gemessen: spitze.quelle === 'ha',
          best: spitze.best ?? spitze.biere,
        }] : [],
        los: null, termine: [], chronik: 0,
        /* `draussen` sagt der Seite, dass diese Antwort beschnitten ist -
           sonst saehe eine Liste mit einem Eintrag aus wie eine Tafel, an der
           nur einer angeschrieben hat. */
        draussen: true,
      }, 200, KEIN_FREMDER_CACHE);
    }

    const tag = bierTag();
    const [stand, best, verlauf, los, losFeld, termine, bewertungen, zaehler, chronik, notrufe] =
      await env.DB.batch([
      /* Gesperrte bleiben in der Liste stehen - das ist Historie, und ein
         Name, der ueber Nacht verschwindet, sieht nach Datenverlust aus. Sie
         tragen nur eine stille Marke und fallen aus dem Topf (losFeldStmt).
         Entfernte fallen von selbst heraus: ihr Name ist dann NULL. */
      env.DB.prepare(`
        SELECT u.id, u.name, u.quelle, u.gesperrt_am, r.biere, r.temperatur, r.gemeldet_am
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
      /* Wie viele Abende die Chronik ueberhaupt herzugeben hat. Nur die Zahl,
         und nur, damit die Seite weiss, ob der Knopf dahin einen Sinn ergibt -
         ohne sie stuende er auch an einer Tafel, hinter der nichts liegt. */
      env.DB.prepare("SELECT count(*) AS n FROM termine WHERE beginnt_am <= datetime('now')"),
      /* Die Notrufe reiten hier mit statt auf einer eigenen Route - dieselbe
         Ueberlegung wie beim Rest: eine Runde weniger, und die Marke 'tafel'
         holt sie ohne eine zweite Sorte Anstoss mit nach. Dass sie NUR in
         diesem Zweig steht, ist der Punkt: der beschnittene Stand fuer
         Vorbeikommende oben enthaelt keine Zeile davon, und das ist keine
         Sparsamkeit, sondern die Bedingung. Ein Ort geht niemanden etwas an,
         der kein Token hat. */
      notrufeStmt(env, ich.id),
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
      gesperrt: !!r.gesperrt_am,
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
      chronik: chronik.results[0].n,
      notrufe: notrufe.results.map(n => notrufAntwort(n, ich.id)),
    }, 200, KEIN_FREMDER_CACHE);
  },
};

/* ---------------------------------------------------------------------------
   Die Waisen wegraeumen.

   `POST /api/bild` legt das Objekt ab, bevor der Kommentar geschrieben ist -
   wer hochlaedt und dann abbricht, hinterlaesst eines ohne Zeile. `0008` hat
   das Verzeichnis dafuer angelegt und das Aufraeumen offengelassen; hier ist
   es. Angehaengt an den einzigen Zeitgeber, den es gibt: eigener Cron waere
   ein zweiter Eintrag in `wrangler.jsonc` fuer eine Arbeit von Millisekunden.

   Mitgenommen werden dabei auch die Zeilen geloeschter Kommentare: dort ist
   das Objekt beim Loeschen schon weggeraeumt und `bild_key` auf NULL gesetzt
   worden, die Upload-Zeile blieb aber stehen. Sie faellt hier unter dieselbe
   Bedingung, das `delete()` darauf geht ins Leere - und das ist in R2 kein
   Fehler, sondern ein Nichts.

   REIHENFOLGE wie beim Kommentarloeschen, aus dem umgekehrten Grund: dort
   zuerst das Objekt, damit kein Foto ohne Zeile abrufbar bleibt. Hier zuerst
   das Objekt, weil die Zeile der EINZIGE Zeiger darauf ist - andersherum und
   der zweite Schritt scheitert, liegt es fuer immer im Bucket, ohne dass
   irgendetwas noch von ihm weiss. So bleibt im schlechteren Fall eine Zeile
   ohne Objekt stehen, und der naechste Lauf holt sie. */
async function waisenWegraeumen(env) {
  if (!env.BILDER) return 0;

  /* NOT EXISTS, nicht LEFT JOIN: haengt derselbe Schluessel an zwei
     Kommentaren, gaebe der Join die Upload-Zeile doppelt zurueck. Hier zaehlt
     nur, OB es irgendwo eine Verwendung gibt. */
  const waisen = await env.DB.prepare(`
    SELECT b.id, b.bild_key
    FROM bild_uploads b
    WHERE b.erstellt < datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM kommentare k WHERE k.bild_key = b.bild_key)
    ORDER BY b.erstellt
    LIMIT ?
  `).bind(WAISENFRIST, WAISEN_PRO_LAUF).all();

  if (!waisen.results.length) return 0;

  // Ein Aufruf fuer den ganzen Stapel; R2 nimmt bis zu 1000 Schluessel.
  await env.BILDER.delete(waisen.results.map(w => w.bild_key));

  const platzhalter = waisen.results.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM bild_uploads WHERE id IN (${platzhalter})`)
    .bind(...waisen.results.map(w => w.id)).run();

  return waisen.results.length;
}

export default {
  /* Zwei Zeitgeber im ganzen Dienst. Alles sonst traegt sich beim naechsten
     Schreiben nach (siehe `verfallStmt`).

     09:00 UTC raeumt einmal taeglich auf: erloschene Notrufe und verwaiste
     Bilder, die sich sonst unbegrenzt ansammeln. Die Uhrzeit selbst ist
     willkuerlich - nur niedrig genug, dass der Lauf niemanden stoert.

     Zweiter Cron seit Schema 15, siehe wrangler.jsonc: alle zehn Minuten,
     nur fuer faellige geplante Rundmails - eine eigene Weiche, damit das
     taegliche Aufraeumen nicht zehnmal die Stunde mitlaeuft. */
  async scheduled(event, env, ctx) {
    if (event.cron !== '0 9 * * *') {
      try {
        await rundmailGeplantVersenden(env, ctx);
      } catch (e) {
        console.error('Geplante Rundmail:', e && e.stack || e);
      }
      return;
    }

    /* Die erloschenen Notrufe. Zuerst unter den Aufraeumarbeiten, weil es das
       einzige Aufraeumen ist, das nicht nur Platz schafft: hier verschwindet
       der Aufenthaltsort eines Menschen, und der soll nicht deshalb liegen
       bleiben, weil der Bilder-Bucket gerade streikt. Eigener try, aus
       demselben Grund. */
    try {
      const weg = await env.DB.prepare(`
        DELETE FROM notrufe
        WHERE bis < datetime('now', ?) OR weg_am < datetime('now', ?)
      `).bind(`-${NOTRUF_MUELL} days`, `-${NOTRUF_MUELL} days`).run();
      if (weg.meta.changes) console.log(`Notrufe weggeraeumt: ${weg.meta.changes}`);

      /* Die Empfaengerkreise dazu. `ON DELETE CASCADE` steht am Fremdschluessel
         (migrations/0021) und sollte das schon erledigt haben - dieser Kehr
         ist der Guertel zum Hosentraeger, und er steht im SELBEN `try`: wenn
         oben nichts geloescht wurde, gibt es hier auch nichts zu kehren. */
      await env.DB.prepare(
        'DELETE FROM notruf_kreis WHERE notruf_id NOT IN (SELECT id FROM notrufe)').run();
    } catch (e) {
      console.error('Notrufe:', e && e.stack || e);
    }

    /* Eigener try wie oben: scheitert das eine Aufraeumen, soll das andere
       trotzdem laufen. */
    try {
      const weg = await waisenWegraeumen(env);
      if (weg) console.log(`Waisenbilder weggeraeumt: ${weg}`);
    } catch (e) {
      console.error('Waisenbilder:', e && e.stack || e);
    }
  },

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
      /* Die Sperre kommt aus `nutzer()` geflogen und landet hier - an einer
         Stelle statt in jeder Schreibroute. Ihr Text ist fuer den Nutzer
         bestimmt und darf darum ausnahmsweise mit hinaus. */
      if (e instanceof Gesperrt) return fehler(request, e.message, 403);
      /* Der Fehlertext geht ins Log, nicht an den Aufrufer: er kann
         Tabellennamen, Adressen oder Werte enthalten. */
      console.error('unerwartet:', e && e.stack || e);
      return fehler(request, 'Da ist etwas schiefgegangen', 500);
    }
  },
};
