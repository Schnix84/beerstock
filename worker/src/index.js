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

// Web-Push: VAPID und die Verschluesselung der Nutzlast, in purem WebCrypto.
// Die Datei weiss nichts von Nutzern und Datenbank - sie schickt EINE Meldung
// an EIN Abo. Wer wen bekommt, entscheidet `stosse()` weiter unten.
import { pushSenden, pushBereit } from './webpush.js';

// EPC-QR (Girocode) und die Aufbereitung der Zahlwege (Schema 36, Etappe 5).
// `qr.js` ist die vendorte QR-Bibliothek, `epc.js` unser Code darueber -
// siehe die Kommentare dort zur Lizenztrennung.
import { epcNutzlast, qrSvg, wegeAufbereiten, ibanNormalisieren, ibanGueltig, zweckBauen, ZAHLWEG_ARTEN } from './epc.js';

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

/* Dasselbe fuer `GET /api/notrufe`, nur ohne die halbe Minute: die Route wird
   im Fuenf-Sekunden-Takt gefragt, und ein Speicher, der laenger haelt als der
   Takt, gaebe dieselbe Nadel sechsmal zurueck - die Zeile stuende still,
   waehrend jemand geht. Die Seite fragt ohnehin mit `cache: 'no-store'`; das
   hier ist die Seite der Antwort, damit es nicht an EINER Zeile in EINER
   Datei haengt. */
const KEIN_NOTRUF_CACHE = {
  'Cache-Control': 'private, no-store',
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

/* Wie lange eine Vorschauzeile bleibt, an der kein Kommentar haengt. Seit der
   Karte SCHON BEIM TIPPEN ist das der Normalfall und nicht mehr die Ausnahme:
   jeder getippte und nie abgeschickte Link legt eine Zeile an, dazu die halb
   getippten Adressen aus dem Nachlauf - die meisten davon `fehler`-Zeilen ganz
   ohne Bild.

   Die Frist ist zugleich die Lebensdauer des Caches fuer so eine Adresse: ein
   toter Link wird nach dreissig Tagen einmal neu versucht. Das ist der Preis
   und er ist klein - ein Versuch je Monat und Adresse, und nur fuer Adressen,
   die niemand abgeschickt hat.

   Der Deckel je Lauf wie bei den Waisen und aus demselben Grund (siehe dort):
   er greift beim ersten Lauf mit Altbestand und laesst den ueber ein paar Tage
   abfliessen statt in einem Rutsch. */
const VORSCHAU_MUELL       = 30;              // Tage ohne Kommentar
const VORSCHAUEN_PRO_LAUF  = 200;

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
  /* Alles, was einem MENSCHEN ueber eine seiner Gruppen zu sagen ist: dass er
     nachgerueckt ist, dass sein Antrag beschieden wurde. Vorgabe an, weil es
     jedesmal etwas ist, das er wissen MUSS, um handeln zu koennen - und
     abwaehlbar wie jede Mail hier, sonst waere sie die erste, die man nicht
     abbestellen kann. */
  gruppe:         { vorgabe: true,  titel: 'Nachricht zu einer meiner Gruppen' },
  termin_neu:     { vorgabe: true,  titel: 'Ein Abend steht fest' },
  termin_aendert: { vorgabe: true,  titel: 'Ein Abend verschiebt sich oder fällt aus' },
  echo:           { vorgabe: false, titel: 'Antwort auf meinen Beitrag, Sterne für mich' },
  rundmail:       { vorgabe: true,  titel: 'Gelegentliche Nachricht vom Wirt' },
  /* Abwaehlbar wie alles hier, aber mit Vorgabe AN: eine Not, von der niemand
     erfaehrt, ist keine gemeldet. Wer sie abstellt, tut das bewusst. */
  notruf:         { vorgabe: true,  titel: 'Jemand braucht Bier oder Gesellschaft' },
  /* Nur an Gruppenadmins, hoechstens eine je Unterschreitung (Entscheidung 34,
     Bezug `bestand:<getraenk_id>:<warn_lauf>`). Vorgabe an, wie `notruf` -
     wer die Kasse fuehrt, soll das nicht verpassen, darf es aber abstellen. */
  bestand_knapp:  { vorgabe: true,  titel: 'Ein Getränk unterschreitet den Mindestbestand' },
  /* Der Empfaengerkreis ist genau EINE Person: der Betroffene (Entscheidung
     56). Zwei Anlaesse teilen sich die Art - verhaengt und erlassen -, weil es
     fuer den Empfaenger dieselbe Sache ist: was an seiner eigenen Strafe
     passiert. Vorgabe an, wie `notruf` und `bestand_knapp`: eine Strafe, von
     der der Bestrafte nichts erfaehrt, ist keine verhaengte. */
  strafe:         { vorgabe: true,  titel: 'Eine Strafe für mich, oder ihr Erlass' },
  /* Etappe 9. Kreis sind die GRUPPENADMINS, nicht die Gruppe - ein Mitglied
     kann an einem Vorschlag oder einem Einspruch nichts entscheiden, es zu
     benachrichtigen waere ein Alarm ohne Knopf davor (dieselbe Ueberlegung
     wie bei `bestand_knapp`). */
  einspruch:      { vorgabe: true,  titel: 'Ein Vorschlag oder Einspruch wartet auf mich' },
};

// Zwei Rollen, mehr nicht. Alles darueber waere Verwaltung von Verwaltung.
const ROLLEN = new Set(['user', 'admin']);

/* Die Melderfarbe (Schema 28). Sie haengt am MENSCHEN und nicht an seinem
   Platz in irgendeiner Liste: dieselbe Kreide am Rad-Bogen, an der Kurve in
   der Statistik und an der Karte im Kontor. Vorher faerbte jede Grafik der
   Reihe nach durch, und wer heute vorn lag, war gruen.

   Der Worker gibt eine ZAHL heraus, nie einen Farbwert: welcher Ton auf
   Platz 3 sitzt, ist eine Frage der Zeichnung und steht in der Seite. Er
   weiss nur, WIE VIELE es sind - und das muss er wissen, sonst liesse sich
   `farbe` nicht pruefen.

   NEUN, UND DIESE NEUN STEHEN AN VIER STELLEN: `MENSCHEN` in
   `index.html` (die Tafel ist eine geschlossene Datei und laedt `bilder.js`
   nicht), die Vorgabe in `bilder.js` und die `menschen`-Reihe, die
   `statistik.html` und `admin.html` an `Bilder.aufsetzen` reichen. Wer die
   Reihe aendert, aendert alle vier UND diese Zahl; erzwingen laesst sich das
   von hier aus nicht.

   Warum neun und was sie kosten - die zwei juengsten liegen ueber dem
   Kreideband - steht ausfuehrlich an `MENSCHEN` in `index.html`. */
const FARBEN = 9;

/* Der Platz, den es in der Reihe nicht gibt (Schema 29). Wen es heute trifft,
   traegt statt einer Kreide den Regenbogen. Der Gewinn: alles, was `farbe`
   schon liest - Rad, Tafel, Kurven, Balken, Rueckblick, das eingefrorene Feld
   einer Ziehung -, traegt den Regenbogen ohne eine zweite Zutat im Datenweg.
   Die Zeichnung entscheidet, wie er aussieht; hier ist er eine Zahl wie jede
   andere. WAEHLEN kann diesen Platz niemand, `aktion: 'farbe'` prueft gegen
   FARBEN.

   99 UND NICHT `FARBEN` - die Marke darf dem Ende der Reihe nicht folgen.
   Anfangs war es die 7, weil die Reihe bei 6 aufhoerte; als die Reihe auf
   neun wuchs, waere daraus die 9 geworden, und DIE haette ein Melder
   bekommen, ohne im Kreis zu sein: wer `farbe` NULL hat, bekommt seinen
   Platz aus der Anmeldereihenfolge (siehe `farbeSql`), der zehnte Melder
   also die 9. `FARBEN` haelt nur die WAHL im Kontor auf, den automatischen
   Platz nicht - der zehnte haette den Regenbogen getragen, jeden Tag, fuer
   alle. Eine Marke jenseits jeder erreichbaren Anmeldezahl kann das nicht
   passieren; sie muss mit der Reihe nie wieder mitwandern. */
const STOLZ = 99;

/* Der Platz eines Melders als SQL-Ausdruck: sein eingestellter, sonst der aus
   der Anmeldereihenfolge. Eine Funktion, weil nicht jede Abfrage ihre
   Nutzertabelle `u` nennt. Warum die Reihenfolge fuer immer haelt, steht in
   migrations/0028.

   `traeger` ist die Id dessen, den es heute trifft (`stolzTraeger`), oder
   null. ALLE BILDER wollen ihn - Tafel, Statistik der Runde UND die des
   Wirts: wer heute den Regenbogen traegt, traegt ihn auf jedem Blatt, sonst
   ist derselbe Mensch beim Vergleich zweier Bilder zweimal verschieden.

   AUSDRUECKLICH EIN ARGUMENT UND KEINE VORGABE bleibt es trotzdem, wegen der
   EINEN Abfrage, die ihn nicht haben darf: die Mitgliederliste im Kontor.
   Dort steht an jeder Karte die Farbreihe, und die muss zeigen, welche
   KREIDE gewaehlt ist - das ist ja die Farbe, auf die der Traeger
   zurueckfaellt, sobald es einen anderen trifft. Sie holt sich den
   Regenbogen darum getrennt, als `stolz_heute`. */
const farbeSql = (alias = 'u', traeger = null) => {
  const platz =
    `coalesce(${alias}.farbe, (SELECT count(*) FROM users x WHERE x.id < ${alias}.id))`;
  if (!Number.isInteger(traeger)) return platz;
  return `CASE WHEN ${alias}.id = ${traeger} THEN ${STOLZ} ELSE ${platz} END`;
};

/* Der Wurf des Tages, aus dem Tag selbst. FNV-1a ueber "2026-08-09" - eine
   Streuung, kein Zufallsgenerator: sie muss in jedem Isolat und bei jedem
   Abruf dasselbe ergeben, sonst traegt der Melder auf der Tafel eine andere
   Farbe als im Rad daneben. */
const wurf = s => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

/* Wen es heute trifft, oder null. Eine kleine Abfrage; wo es sich anbietet,
   laeuft sie neben `nutzer()` her und kostet dann gar keine Zeit.

   Gesperrte bleiben im Kreis: sie stehen weiter auf der Tafel (nur mit der
   Marke "ruht"), und wer im Kreis ist, entscheidet der Wirt und nicht die
   Sperre. Entfernte und Namenlose fallen heraus - sie sind niemand mehr, den
   man faerben koennte. */
async function stolzTraeger(env) {
  const { results } = await env.DB.prepare(`
    SELECT u.id,
           (SELECT aktiv   FROM stolz_regel WHERE id = 1) AS aktiv,
           (SELECT versatz FROM stolz_regel WHERE id = 1) AS versatz
    FROM users u
    WHERE u.stolz = 1 AND u.entfernt_am IS NULL AND u.name IS NOT NULL
    ORDER BY u.id
  `).all();
  if (!results.length || !results[0].aktiv) return null;
  /* `versatz` ist, wie oft der Wirt von Hand weitergedreht hat (Schema 30).
     Er wird ADDIERT und ersetzt nichts: gespeichert ist weiterhin kein
     Traeger, nur eine Verschiebung - die Ableitung aus dem Biertag bleibt. */
  const versatz = results[0].versatz || 0;
  return results[(wurf(bierTag()) + versatz) % results.length].id;
}

/* Wer heute Geburtstag hat (Schema 31). Eine LISTE und kein einzelner - anders
   als beim Regenbogen, den es je Tag genau einmal gibt, koennen hier zwei am
   selben Tag geboren sein, und der eine duerfte dann nicht den anderen
   verdraengen.

   `substr(?, -5)` ist der Tag OHNE Jahr: gespeichert ist entweder 'MM-TT' oder
   'JJJJ-MM-TT' (siehe 0031), und von hinten gelesen sind beide dasselbe. Ein
   `strftime('%m-%d', ...)` ginge nur auf der langen Form und gaebe auf der
   kurzen NULL zurueck - also stillschweigend nie Geburtstag.

   DER TAG KOMMT AUS `bierTag()` und nicht aus `date('now')`: die Tagesgrenze
   dieser Anwendung liegt um vier Uhr morgens Ortszeit. Wer um drei noch am
   Tisch sitzt, hat weiter Geburtstag - und niemand bekommt ihn zwei Stunden zu
   spaet, weil die Datenbank in UTC rechnet und der Melder nicht.

   Gesperrte bleiben dabei - genau wie im Regenbogenkreis: sie stehen weiter auf
   der Tafel, nur mit der Marke "ruht", und ein Geburtstag ist keine Belohnung
   fuers Mitspielen. Entfernte und Namenlose fallen heraus, sie sind niemand
   mehr, den man feiern koennte.

   DAS ALTER WIRD NICHT AUSGERECHNET UND NICHT HERAUSGEGEBEN. Es stand hier
   einmal ("wird 41") und ist auf Ansage wieder verschwunden: eine Zahl neben
   dem Namen ist eine Auskunft ueber einen Menschen, die er nicht selbst
   herausgibt, sondern die Tafel fuer ihn. Gefeiert wird DASS, nicht WIE OFT.
   Ein Jahr darf trotzdem in der Spalte stehen (das Kontor nimmt es an, siehe
   0031) - es geht nur nirgends hinaus. Deshalb gibt diese Funktion Ids zurueck
   und sonst nichts. */
async function geburtstagsKinder(env) {
  const { results } = await env.DB.prepare(`
    SELECT u.id
    FROM users u
    WHERE u.geburtstag IS NOT NULL
      AND substr(u.geburtstag, -5) = ?
      AND u.entfernt_am IS NULL AND u.name IS NOT NULL
    ORDER BY u.id
  `).bind(bierTag().slice(5)).all();
  return results.map(r => r.id);
}

/* --- DAS RAD AM GEBURTSTAG ------------------------------------------------
   Zwei Fragen auf einmal, und sie haengen zusammen:

     fuer   wem zu Ehren heute gedreht werden kann (Namen, in Radreihenfolge)
     nur    ob es dabei bleibt - also die echte Ziehung heute ausfaellt

   DIE REGEL. Hat ein Geburtstagskind fuer heute noch keinen Abend, gewinnt es
   die ERSTE Drehung des Tages in echt, mit Termin, Mail und allem - danach
   sind alle weiteren Drehungen Ehrenrunden. Steht der Abend dagegen schon
   (weil das Kind ihn eingetragen hat oder er bei ihm stattfindet), gibt es
   heute NUR Ehrenrunden: wo getrunken wird, ist dann ja bereits entschieden,
   und eine Ziehung daneben koennte es nur noch falsch beantworten.

   WER DAZUGEHOERT, MUSS IM TOPF SEIN. Ein Geburtstagskind ohne kaltes Bier hat
   kein Feld im Rad - die Flasche koennte gar nicht auf es zeigen, und ein
   Gastgeber ohne Bestand ist auch als Geschenk keine gute Idee. Es feiert
   dann an der Tafel weiter, nur eben ohne Rad.

   `beginnt_am` STEHT IN UTC UND WIRD GEGEN DEN BIERTAG GEHALTEN. Ein Abend um
   20 Uhr Ortszeit ist 18:00Z desselben Tages, einer um halb eins nachts noch
   22:30Z des Vortages - beide fallen damit auf den Biertag, an dem sie
   gefeiert werden. Genau das ist gemeint.

   Abgesagte Abende zaehlen nicht: eine Absage gibt den Tag frei, hier wie
   ueberall sonst. Und die Liste der Termine ist ein rollendes Fenster ueber
   Wochen (`termineStmt`), nicht der heutige Tag - deshalb wird hier gefiltert
   und nicht bloss gezaehlt. */
/* Ein eingetippter Geburtstag, geprueft und in die Form der Spalte gebracht -
   oder ein Satz, warum nicht. EINE Stelle fuer zwei Routen: der Wirt traegt
   im Kontor ein (`POST /api/admin/nutzer` mit `aktion: 'geburtstag'`), jeder
   fuer sich selbst am Deckel (`POST /api/geburtstag`), und zwei Kopien
   derselben Pruefung laufen frueher oder spaeter auseinander - dann nimmt die
   eine Route an, was die andere abweist.

   `{ wert }` oder `{ fehler }`, nie beides: der Aufrufer prueft auf `fehler`
   und gibt ihn weiter. `wert: null` ist ein gueltiges Ergebnis und heisst
   "loeschen" - deshalb taugt `wert` selbst nicht als Erfolgspruefung.

   DIE PRUEFUNG KANN MEHR ALS EINE FORM, und darum steht sie hier und nicht als
   CHECK im Schema: der 31. Februar hat die richtige Gestalt und ist trotzdem
   kein Tag. `Date.UTC` nimmt ihn an und rechnet ihn auf den 3. Maerz weiter -
   was zurueckkommt, muss deshalb wieder DERSELBE Monat und DERSELBE Tag sein.

   Das Schaltjahr braucht dafuer ein Jahr, das eines IST: geprueft wird gegen
   2024, damit der 29. Februar durchgeht. Ob er in einem gegebenen Jahr
   stattfindet, ist eine Frage fuer den Tag selbst und nicht fuers Eintragen
   (siehe 0031, dort auch, warum es dafuer keine Ausweichregel gibt). */
function geburtstagPruefen(roh) {
  if (roh === null || roh === undefined || roh === '') return { wert: null };
  let wert = String(roh).trim();
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(wert);
  if (!m) return { fehler: 'geburtstag: JJJJ-MM-TT, MM-TT oder null' };
  const [, jahr, monat, tag] = m;
  const probe = new Date(Date.UTC(jahr ? Number(jahr) : 2024, Number(monat) - 1, Number(tag)));
  if (probe.getUTCMonth() + 1 !== Number(monat) || probe.getUTCDate() !== Number(tag)) {
    return { fehler: 'Den Tag gibt es in dem Monat nicht' };
  }
  /* Ein Jahr in der Zukunft oder aus dem 18. Jahrhundert ist keine Angabe,
     sondern ein Tippfehler. `bierTag()` liefert das laufende Jahr; ein
     Geburtsjahr davor ist die einzige Richtung, die geht. */
  if (jahr && (Number(jahr) > Number(bierTag().slice(0, 4)) || Number(jahr) < 1900)) {
    return { fehler: 'Das Jahr sieht nach Vertipper aus' };
  }
  return { wert: (jahr ? jahr + '-' : '') + monat + '-' + tag };
}

function ehrenLage(kinder, topf, termine, tag) {
  if (!kinder.length) return null;
  const drin = new Set(kinder);
  const fuer = topf.filter(p => drin.has(p.id)).map(p => p.name);
  if (!fuer.length) return null;
  const nur = termine.some(t =>
    !t.abgesagt_am && String(t.beginnt_am || '').slice(0, 10) === tag &&
    (drin.has(t.gastgeber_id) || drin.has(t.erstellt_von)));
  return { fuer, nur };
}

/* Die Zeitraeume, die das Kontor zeigen darf. Der erste ist die Vorgabe.
   Eine LISTE, kein Bereich mit Ober- und Untergrenze: der Wert geht in ein
   `datetime('now', ?)`, und drei erlaubte Zahlen kann man ansehen und
   verstehen - eine Spanne muss man nachrechnen. */
const STATISTIK_TAGE = [30, 60, 90];

/* Wie lange ein gemeldeter Bestand fuer den "Vorrat der Runde" weitergilt.
   Die Kurve summiert die letzten Staende ALLER Melder je Tag und traegt sie
   ueber Tage ohne Meldung fort - ohne Grenze zaehlte jemand, der einmal 24
   gemeldet hat und danach nie wieder, bis in alle Ewigkeit mit.

   Dieselbe Zahl wie WRAPPED_VERFALL_TAGE, und das mit Absicht: "veraltet"
   soll im Rueckblick nicht etwas anderes heissen als in der Statistik. Ein
   eigener Name trotzdem, damit man die beiden verstellen kann, ohne die
   jeweils andere Kurve ungewollt mitzudrehen. */
const BESTAND_VERFALL_TAGE = WRAPPED_VERFALL_TAGE;

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

/* Die Gruppen (Schema 32). Der Name steht auf der Kachel in `start.html` und
   in der Kopfzeile der Tafel - vierzig Zeichen sind dort die Grenze, ab der
   er mitten im Wort bricht. Die Beschreibung sieht nur, wer sucht. */
const GRUPPE_NAME_MAX = 40;
const GRUPPE_TEXT_MAX = 200;
/* Dieselbe Sorte Bremse wie TERMINE_PRO_TAG: gegen den, der aus Versehen
   zwanzigmal drueckt, nicht gegen Missbrauch. Wer wirklich sechs Runden am
   Tag gruendet, wartet bis morgen. */
const GRUPPEN_PRO_TAG = 5;
// So weit darf ein Einladungslink in die Zukunft laufen. NULL bleibt erlaubt
// ("laeuft nie ab") - das ist die Ansage des Admins, nicht ein Versehen.
const EINLADUNG_TAGE_MAX = 365;
// Wieviele Treffer die Gruppensuche hoechstens zeigt.
const SUCHE_MAX = 30;
/* Die Schalterleiste, als Liste. Sie steht hier und nicht an der Route: die
   Reihenfolge ist die, in der die Verwaltung sie zeigt, und eine zweite
   Aufzaehlung im Frontend waere die eine, die beim siebten Schalter vergessen
   wird. */
const SCHALTER = ['tafel_an', 'rad_an', 'notruf_an', 'termine_an', 'kasse_an', 'statistik_an',
                  'regeln_an'];

/* Die Kasse (Schema 34, Etappe 3). */
const GETRAENK_NAME_MAX = 40;
const PREIS_CENT_MAX    = 5000;   // 50 Euro das Getraenk waere sicher ein Tippfehler
const BUCHUNG_MENGE_MAX = 24;     // ein Kasten auf einen Schlag, mehr ist ein Tippfehler
const STORNO_MINUTEN    = 5;      // fuer den Buchenden selbst (Entscheidung 15)
const BESTAND_GRUND_MAX = 200;

/* Die Abrechnung (Schema 35, Etappe 4). */
const SALDO_NOTIZ_MAX = 200;

/* Die Zahlwege (Schema 36, Etappe 5). `ZAHLWEG_ARTEN` kommt aus epc.js, EIN
   Ort fuer die vier gueltigen Arten statt einer zweiten Kopie hier. */
const ZAHLWEG_MAX = 8;        // vier Arten, aber mehrere IBANs/Adressen sind denkbar
const ZAHLWEG_WERT_MAX = 200; // Freitext bei 'bar' ist das grosszuegigste Feld

/* Die Hausordnung (Schema 38, Etappe 8). */
const REGEL_TITEL_MAX = 60;   // steht als Zeile in der Zunge, laenger bricht sie um
const REGEL_TEXT_MAX  = 400;  // der ausgeschriebene Satz darunter
const REGEL_TAT_MAX   = 120;  // "bringt einen Kasten mit"
const REGEL_MAX       = 40;   // Regeln je Gruppe - eine Hausordnung, kein Gesetzbuch
const STRAFE_GRUND_MAX = 200; // wie BESTAND_GRUND_MAX, dieselbe Sorte Freitext
/* Dieselbe Sorte Bremse wie PREIS_CENT_MAX: 100 Euro Strafe waere sicher ein
   Tippfehler, und wer wirklich mehr will, verhaengt zweimal. Gilt in BEIDE
   Richtungen - eine Gutschrift (Entscheidung 52) ist eine Strafe mit
   negativem Betrag und darf genauso wenig entgleiten. */
const STRAFE_CENT_MAX = 10000;

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
    /* PATCH kam mit den Gruppen dazu (Schema 32): `PATCH /api/gruppe` und
       `PATCH /api/gruppe/mitglied` sind Aenderungen an einem bestehenden Ding
       und heissen deshalb so. Steht das Verb hier nicht, weist schon der
       Vorabflug des Browsers ab - und der Fehler sieht auf der Seite aus wie
       "kein Netz", nicht wie ein fehlender Kopf. */
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, OPTIONS';
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
   nach.

   Vier Geschwister, kein einziges "an alle Gruppen des Schreibers" mehr
   (das war `anstoss()`, bis Etappe 2 es ablöste - siehe Nachgereicht #1 aus
   Etappe 1: wer in zwei Gruppen war, weckte mit jedem Schreiben auch die
   Tafel der jeweils anderen). Jede Schreibroute kennt ihre Gruppe seit dieser
   Etappe aus `inGruppe()`, direkt oder ueber ihr Ziel - und meldet gezielt. */

/* An EINE bestimmte Gruppe. Der Normalfall: jede Schreibroute kennt ihre
   Gruppe aus `inGruppe()`, direkt oder (bei Routen ohne eigenes Ziel im
   Rumpf) ueber die Zeile, die sie gerade angefasst hat. */
function anstossGruppe(gruppeId, request, env, ctx, ...marken) {
  if (!ctx || !env.TAFEL || !gruppeId) return;
  const von = request.headers.get('X-Tab') || null;
  ctx.waitUntil(verteile(env, Promise.resolve([gruppeId]), marken, von));
}

/* Dieselbe Meldung, aber nur an die Gruppen DES SCHREIBERS, in denen ein
   bestimmter Schalter an ist. Fuer die zwei Schreibrouten ohne eigenes Ziel -
   der Name (`POST /api/name`) und die Bestandsmeldung (`POST /api/report`)
   gehoeren der Person, nicht einer Gruppe (Entscheidung 2b), zeigen sich aber
   nur in Gruppen, die `tafel_an` fuehren (siehe "Was die Schalterleiste nach
   sich zieht" im Plan: `tafel_an` regelt, ob DIESE Gruppe die Meldungen ihrer
   Mitglieder zeigt). */
function anstossSchalter(schalterName, request, env, ctx, ...marken) {
  if (!ctx || !env.TAFEL) return;
  if (!SCHALTER.includes(schalterName)) {
    throw new Error(`anstossSchalter: unbekannter Schalter '${schalterName}'`);
  }
  const von = request.headers.get('X-Tab') || null;
  ctx.waitUntil(verteile(env, gruppenDesSchreibers(request, env, schalterName), marken, von));
}

/* Dieselbe Meldung, an ALLE Gruppen der Instanz - fuer `stolz_regel`
   (`POST /api/admin/stolz`): der Schalter und der Kreis gelten der ganzen
   Instanz (Entscheidung 25, Betrieb bleibt instanzweit), nicht den Gruppen
   des handelnden Admins. */
async function alleGruppen(env) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare('SELECT id FROM gruppen').all();
  return results.map(z => z.id);
}
function anstossAlle(request, env, ctx, ...marken) {
  if (!ctx || !env.TAFEL) return;
  const von = request.headers.get('X-Tab') || null;
  ctx.waitUntil(verteile(env, alleGruppen(env), marken, von));
}

/* WELCHE Leitungen eine Meldung erreicht - die eine Stelle, an der aus einer
   Marke ein Empfaengerkreis wird.

   Seit Schema 32 haelt das Durable Object nicht mehr EINE Tafel fuer alle,
   sondern eine je Gruppe (`idFromName('gruppe:' + id)`). Damit muss jede
   Meldung sagen, wohin sie gehoert - und weil die Seiten nach Gruppen
   getrennt lauschen, ist eine Meldung an die falsche Adresse keine falsche
   Meldung, sondern gar keine: sie kommt bei niemandem an.

   Reihum und nicht parallel waere hier verkehrt: wer in drei Gruppen ist,
   schriebe sonst drei Runden hintereinander. `allSettled`, weil eine Gruppe,
   deren Objekt gerade nicht mag, die anderen nicht mitnehmen darf. */
async function verteile(env, gruppenP, marken, von) {
  try {
    const gruppen = await gruppenP;
    if (!gruppen || !gruppen.length) return;
    await Promise.allSettled(gruppen.map(id =>
      env.TAFEL.get(env.TAFEL.idFromName('gruppe:' + id)).melden(marken, von)));
  } catch (e) {
    console.error('anstoss:', e && e.stack || e);
  }
}

/* Die Gruppen dessen, der gerade geschrieben hat - aufgeloest ueber sein
   Geraete-Token, nicht ueber einen durchgereichten Nutzer. Seit Etappe 2 nur
   noch fuer die zwei Schreibrouten OHNE eigenes Ziel (`POST /api/name`,
   `POST /api/report`, ueber `anstossSchalter()`) - jede andere Schreibroute
   kennt ihre Gruppe aus `inGruppe()` und meldet gezielt ueber
   `anstossGruppe()`.

   `schalter`, wenn gesetzt, siebt zusaetzlich auf Gruppen, die ihn fuehren.
   Der Spaltenname wird interpoliert statt gebunden, das darf er nur, weil er
   in `anstossSchalter()` gegen `SCHALTER` geprueft ist, BEVOR er hier
   ankommt. */
async function gruppenDesSchreibers(request, env, schalter = null) {
  const kopf = request.headers.get('Authorization') || '';
  const token = kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
  if (!token || !env.DB) return [];
  const filter = schalter ? ` AND g.${schalter} = 1` : '';
  const { results } = await env.DB.prepare(`
    SELECT m.gruppe_id AS id
      FROM tokens t
      JOIN gruppen_mitglied m ON m.user_id = t.user_id
      JOIN gruppen g ON g.id = m.gruppe_id
     WHERE t.token_hash = ?${filter}
  `).bind(await hash(token)).all();
  return results.map(z => z.id);
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

/* Entscheidung 44: `@googlemail.com` und `@gmail.com` sind DASSELBE Postfach -
   Google liefert beides in dieselbe Inbox. Fuer den Worker waren es bis
   Etappe 7 zwei Fremde, und genau daran hat sich am 11.08.2026 ein Melder ein
   zweites Konto angelegt (PROJECT-MEMORY, Doppelkonto).

   Die Faltung sitzt HIER und nicht an den Aufrufstellen: `normMail` wird an
   vier Stellen benutzt (Anmelden, Magic, Adresswechsel, Admin-Abgleich), und
   eine Faltung, die nur an dreien steht, ist schlimmer als gar keine.

   Punkte im lokalen Teil werden NICHT gefaltet, obwohl Google auch die
   ignoriert: `users.email` steht mit Punkt in der Datenbank, die Suche liefe
   also am Bestand vorbei - es muessten die gespeicherten Adressen mitwandern.
   Zu viel Umbau fuer zu wenig Gewinn. */
const normMail = s => String(s || '').trim().toLowerCase()
  .replace(/@googlemail\.com$/, '@gmail.com');

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
             u.mail_prefs, u.mail_stumm_am, u.geburtstag
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

/* Wer bin ich, in WELCHER Gruppe, und darf ich das hier?
   Genau EINE Stelle - eine Route, die die Gruppe selbst aus der URL fischt,
   vergisst irgendwann die Mitgliedschaftspruefung, und dann liest ein Fremder
   eine fremde Tafel.

   WIE DIE GRUPPE HEREINKOMMT: bei GET als `?g=<id>`, sonst als Feld `gruppe`
   im Rumpf. NICHT im Pfad - `ROUTEN` ist eine flache Tabelle, die auf
   `` `${method} ${pathname}` `` nachschlaegt, und dieselben Schluessel benutzt
   `SPERRE_FREI`. Ein Praefix `/api/g/:slug/…` haette den Verteiler und alle
   neunzig Schluessel umgebaut, fuer nichts als eine schoenere Adresse.

   GEPRUEFT WIRD IN DIESER REIHENFOLGE, und die Reihenfolge ist die Auskunft:
   erst "gibt es die Gruppe", dann "bin ich drin", dann "ist die Funktion an".
   Ein Fremder soll an einer privaten Gruppe nicht ablesen koennen, welche
   Funktionen sie fuehrt - deshalb kommt der Schalter zuletzt.

   `schalter` ist der Spaltenname aus `gruppen` ('kasse_an', 'rad_an', …) oder
   null, wenn die Route an keinem haengt.

   RUECKGABE: `{ gruppe, rolle, mitglied }` oder eine FERTIGE Fehlerantwort.
   Der Aufrufer schreibt darum immer:

     const g = await inGruppe(request, env, ich, daten);
     if (g instanceof Response) return g;

   Ein zweiter Rueckgabewert waere hier dasselbe Loch wie bei `nutzer()`: eine
   Stelle, die ihn nicht prueft, laesst jeden durch. */
async function inGruppe(request, env, ich, daten, schalter = null) {
  if (!ich) return fehler(request, 'Nicht angemeldet', 401);
  /* Gegen Tippfehler: `gruppe['temrine_an']` waere sonst still `undefined`
     und damit fuer immer 403, ohne dass es je auffiele. */
  if (schalter && !SCHALTER.includes(schalter)) {
    throw new Error(`inGruppe: unbekannter Schalter '${schalter}'`);
  }

  const roh = request.method === 'GET'
    ? new URL(request.url).searchParams.get('g')
    : (daten && daten.gruppe);
  const id = Number(roh);
  if (!roh || !Number.isInteger(id) || id <= 0) {
    return fehler(request, 'Welche Gruppe? (`g` bei GET, `gruppe` im Rumpf)');
  }

  const gruppe = await env.DB.prepare('SELECT * FROM gruppen WHERE id = ?').bind(id).first();
  /* Dieselbe Antwort wie fuer "gibt es nicht" waere ehrlicher gewesen, aber
     es GIBT sie ja - und wer eine Id durchprobiert, erfaehrt hier nur, dass
     eine Zahl belegt ist. Namen, Bestaende und Mitglieder stehen erst hinter
     der Mitgliedschaftspruefung. */
  if (!gruppe) return fehler(request, 'Diese Gruppe gibt es nicht', 404);

  const m = await env.DB.prepare(
    'SELECT rolle FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
    .bind(id, ich.id).first();

  /* Der Generaladmin kommt ueberall hinein, auch ohne Mitgliedschaft - er ist
     der Wirt, ihm gehoert der Laden. Er zaehlt dabei als Gruppenadmin, aber
     NICHT als Mitglied: `mitglied` bleibt falsch, damit ihn keine Route in
     eine Mitgliederliste schreibt, in der er nicht steht. Was er dabei
     AENDERT, steht wie jede Amtshandlung im `admin_log`, seit Schema 32 mit
     der Gruppe daneben - gelesen wird ohne Eintrag, wie ueberall sonst. */
  if (!m && !istAdmin(ich)) {
    return fehler(request, 'Du bist nicht in dieser Gruppe', 403);
  }

  if (schalter && !gruppe[schalter]) {
    return fehler(request, `Das ist in „${gruppe.name}" abgeschaltet`, 403);
  }

  return { gruppe, rolle: m ? m.rolle : 'admin', mitglied: !!m };
}

// Fuehrt DIESEN Tisch - nicht zu verwechseln mit `istAdmin`, dem der Laden
// gehoert. Der Wirt bekommt aus `inGruppe()` ebenfalls 'admin'.
const istGruppenAdmin = g => g && g.rolle === 'admin';

/* Welchen CHARAKTER eine Gruppe hat - abgeleitet, nicht gespeichert (Etappe 11).
   `gruppen` bekommt KEIN `art`-Feld: der Charakter steht schon in der
   Schalterleiste aus 0032/0038, und `index.html` uebersetzt sie seit Etappe 10
   in die zwei Blaetter "Privat" und "Verein". Eine zweite Wahrheit daneben waere
   die Sorte Feld, das am dritten Tag nicht mehr zum Schalterstand passt.

   `statistik_an` steht in KEINER der beiden Listen - er ist der Einstieg, nicht
   der Inhalt. Eine Gruppe, die nur ihn traegt, hat nichts zu zeigen. */
const privatSeite = g => !!(g.tafel_an || g.rad_an || g.notruf_an || g.termine_an);
const vereinSeite = g => !!(g.kasse_an || g.regeln_an);

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
   Topf - aus dem gezeichneten wie aus dem gezogenen, in einem Zug.

   `gruppeId` ist PFLICHT seit Etappe 2: der `JOIN gruppen_mitglied` steht in
   BEIDEN Zweigen, sonst dreht eine Tafel-Gruppe weiter mit fremden Namen.
   `tafelAn` entscheidet nur noch, WIE gezogen wird (Entscheidung 40): mit
   Tafel bleibt der alte Bestandsfilter samt Sortierung nach Bestand, ohne
   Tafel faellt beides weg - der Bestand ist dort unsichtbar, ein Filter
   darauf waere ein Ausschluss ohne erkennbaren Grund. `LEFT JOIN reports`
   plus `r.biere >= ?` im Tafel-Zweig verhaelt sich dabei wie der alte
   `JOIN`: ein NULL faellt an der Bedingung genauso durch. */
const losFeldStmt = (env, traeger, gruppeId, tafelAn) => env.DB.prepare(`
  SELECT u.id, u.name, u.quelle, coalesce(r.biere, 0) AS biere, ${farbeSql('u', traeger)} AS farbe
  FROM gruppen_mitglied m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j ON j.user_id = u.id
  LEFT JOIN reports r ON r.id = j.id
  WHERE m.gruppe_id = ?
    AND u.name IS NOT NULL
    AND u.gesperrt_am IS NULL
    AND u.entfernt_am IS NULL
    ${tafelAn ? 'AND r.biere >= ?' : ''}
  ORDER BY ${tafelAn ? 'r.biere DESC, ' : ''}u.name ASC
`).bind(...(tafelAn ? [gruppeId, LOS_MIN] : [gruppeId]));

/* ALLE Lose eines Tages, nicht nur das geltende - seit der Zusage kann es je
   Tag mehrere geben. `abgelaufen` rechnet die Frist gleich mit aus, damit
   Lesen und Schreiben dieselbe Grenze benutzen: der Verfall wird nur beim
   Schreiben in die Datenbank eingetragen, gelten muss er sofort.

   `gruppeId` seit Schema 33, und `null` heisst ausdruecklich "ueber alle
   Gruppen": dabei bleiben die Leserouten (Bestenliste, Kachel), bis die
   Schalterleiste ihnen ihre Gruppe gibt. Wer SCHREIBT, nennt sie schon jetzt -
   sonst blockierte das Los der einen Gruppe die Ziehung aller anderen, und der
   neue Index `los_gueltig(gruppe_id, tag)` liefe ins Leere.

   Die Gruppe wird ZWEIMAL gebunden statt als ?3 nummeriert: SQLite vergibt
   unnummerierten Platzhaltern "eins mehr als der groesste bisherige Index",
   eine Mischung aus beiden Schreibweisen haette also stillschweigend zwei
   Werte vertauscht. */
const losTagStmt = (env, tag, gruppeId = null) => env.DB.prepare(`
  SELECT l.id, l.tag, l.gruppe_id, l.user_id, l.biere, l.feld, l.gedreht_am,
         l.status, l.grund, l.entschieden_am,
         coalesce(u.name, 'Ehemaliger') AS gewinner,
         coalesce(g.name, 'Ehemaliger') AS von,
         (l.status = 'offen' AND l.gedreht_am < datetime('now', ?)) AS abgelaufen
  FROM los l
  JOIN users u ON u.id = l.user_id
  LEFT JOIN users g ON g.id = l.gedreht_von
  WHERE l.tag = ? AND (? IS NULL OR l.gruppe_id = ?)
  ORDER BY l.id
`).bind(`-${LOS_FRIST} hours`, tag, gruppeId, gruppeId);

/* Der Verfall, festgeschrieben. Gehoert vor jede Schreibhandlung am Los und
   IN DENSELBEN batch: die Anweisungen laufen der Reihe nach in einer
   Transaktion, die Abfragen danach sehen das Ergebnis also schon. */
const verfallStmt = (env, tag, gruppeId = null) => env.DB.prepare(`
  UPDATE los SET status = 'verfallen', entschieden_am = datetime('now')
  WHERE tag = ? AND status = 'offen' AND gedreht_am < datetime('now', ?)
    AND (? IS NULL OR gruppe_id = ?)
`).bind(tag, `-${LOS_FRIST} hours`, gruppeId, gruppeId);

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

/* `tafelAn = true` bleibt die Vorgabe, damit ein Aufrufer, der das Argument
   vergisst, das alte Verhalten bekommt und nicht eine stumme Gleichverteilung.
   Ohne Tafel zaehlt jeder gleich (Entscheidung 40) - EIN Gewicht-Begriff mit
   einem Schalter, nicht zwei Ziehwege, die auseinanderlaufen koennten (siehe
   `losFeldStmt` und `losTopf`, die aus demselben Grund je EINE Abfrage sind). */
const gewicht = (biere, tafelAn = true) => tafelAn ? Math.min(biere, LOS_DECKEL) : 1;

/* Gewichtet gezogen, aus echtem Zufall statt aus Math.random - es geht um die
   Frage, wer heute den Abend ausrichtet, da ist ein vorhersagbarer Generator
   die falsche Zutat. */
function ziehe(feld, tafelAn = true) {
  const summe = feld.reduce((a, p) => a + gewicht(p.biere, tafelAn), 0);
  const wurf = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * summe;
  let r = wurf;
  for (const p of feld) { r -= gewicht(p.biere, tafelAn); if (r < 0) return p; }
  return feld[feld.length - 1];
}

/* Was die Seite braucht, um das Rad zu zeichnen - egal ob schon gedreht wurde.
   ZWEI Zahlen je Melder, und der Unterschied ist Absicht: `gewicht` ist die
   Chance und damit die Bogenlaenge, gedeckelt bei einem Kasten; `biere` ist,
   was er wirklich gemeldet hat, und das steht als Zahl am Bogen. Vorher stand
   dort das Gewicht - bei 72 Flaschen also "24 kalt", waehrend die Bestenliste
   zwei Zeilen weiter 72 sagte.

   Das Feld wird bei der Ziehung als JSON eingefroren. In alten Zeilen fehlt
   `biere` deshalb; die Seite faellt dort auf `gewicht` zurueck. */
/* `farbe` reitet mit und wird MITEINGEFROREN: das Feld einer alten Ziehung
   liegt als JSON in `los.feld`, und ein Rad, das beim Nachzeichnen andere
   Farben bekaeme als am Abend selbst, waere kein Beleg mehr. Zeilen von vor
   Schema 28 haben sie nicht - die Seite faellt dort auf den Platz im Rad
   zurueck, so wie bei `biere` auch. */
/* `geburtstag` reitet aus demselben Grund mit und wird ebenso eingefroren: die
   Krone am Bogen ist eine Aussage ueber DEN TAG der Ziehung. Wer im naechsten
   Jahr auf ein altes Rad sieht, soll dort die Krone finden, die an dem Abend
   auch dranstand - und nicht die von heute.
   Die Ids kommen von `geburtstagsKinder`, dieselbe Liste, aus der `ehrenLage`
   ihre Ehrenrunde macht; die Route rechnet sie nicht ein zweites Mal aus. Ohne
   die Liste bleibt die Marke schlicht `false`, wie bei jedem alten Feld. */
/* `biere: null` statt `p.biere` ohne Tafel - eine 0 behauptete einen leeren
   Bestand, den es in einer Gruppe ohne Tafel gar nicht gibt (dasselbe
   Argument wie bei `offen_cent: null` in der Statistik). Der Bogen bleibt
   trotzdem da, nur ohne Zahl: `gewicht` ist ueberall 1, also gleich lang. */
const losSegmente = (feld, kinder = [], tafelAn = true) => {
  const feiern = new Set(kinder);
  return feld.map(p => ({ name: p.name, gewicht: gewicht(p.biere, tafelAn),
                          biere: tafelAn ? p.biere : null,
                          gemessen: p.quelle === 'ha', farbe: p.farbe,
                          geburtstag: feiern.has(p.id) }));
};

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

/* Wann ein Preis zu gelten beginnt (Entscheidung 38). Leer heisst "sofort" -
   der WORKER schreibt dann seine eigene Uhr, nicht eine leere Zeichenkette:
   sonst stuende irgendeine Vorgabe neben echten Zeiten in einer Spalte, die
   nur als Zeichenkette verglichen wird (`preis.gueltig_ab`, siehe
   migrations/0034). Keine Obergrenze wie bei Terminen - ein weit
   vorausgeplanter Preis ist keine Fehlbedienung, sondern der Sinn des
   Feldes. */
function pruefeGueltigAb(roh) {
  if (roh == null || roh === '') return { d: new Date() };
  const d = new Date(String(roh));
  if (isNaN(d)) return { fehler: 'gueltig_ab: ISO-8601 in UTC, etwa 2026-09-01T00:00:00Z' };
  return { d };
}

/* Kommende Termine plus ein Rueckblick: der letzte Abend soll noch dastehen,
   damit man ihn bewerten kann. Abgesagte bleiben in der Liste, sie tragen ihre
   Absage sichtbar - sonst verschwindet ein Abend, unter dem Kommentare stehen. */
/* `gruppeId` seit Etappe 2, `null` bedeutet "ueber alle Gruppen" - siehe
   `losTagStmt`. Wer schreibt, kennt seine Gruppe schon aus `inGruppe()`. */
const termineStmt = (env, traeger = null, gruppeId = null) => env.DB.prepare(`
  SELECT t.id, t.gastgeber_id, t.beginnt_am, t.endet_am, t.titel, t.los_id,
         t.abgesagt_am, t.erstellt_von, t.ort,
         coalesce(u.name, 'Ehemaliger') AS gastgeber,
         ${farbeSql('u', traeger)} AS gastgeber_farbe,
         coalesce(e.name, 'Ehemaliger') AS eingetragen_von,
         CASE WHEN e.id IS NULL THEN NULL ELSE ${farbeSql('e', traeger)} END AS von_farbe
  FROM termine t
  JOIN users u ON u.id = t.gastgeber_id
  LEFT JOIN users e ON e.id = t.erstellt_von
  WHERE t.beginnt_am > datetime('now', ?) AND (? IS NULL OR t.gruppe_id = ?)
  ORDER BY t.beginnt_am
`).bind(`-${TERMINE_RUECKBLICK} days`, gruppeId, gruppeId);

/* `von` steht dabei, damit die Seite den Absagen-Knopf ohne Rueckfrage setzen
   kann: aendern darf Gastgeber ODER Eintragender, und die Seite soll nicht
   erst am 403 merken, dass sie ihn nicht haette zeigen duerfen. */
const terminAntwort = (t, noten, wieViele) => ({
  id: t.id,
  /* Auswaerts gibt es KEINEN Gastgeber (siehe migrations/0024): in der Spalte
     steht dann der Eintragende, weil sie NOT NULL ist. Der Name geht deshalb
     hier gar nicht erst hinaus - eine Stelle auf der Seite, die ihn trotzdem
     hinschreibt, faellt so sofort auf, statt still den Falschen zu nennen. */
  gastgeber: t.ort ? null : t.gastgeber,
  /* Seine Kreide - und mit `traeger` die Regenbogenmarke, wenn er heute den
     Regenbogen traegt. Sie faellt mit dem Namen weg und nicht erst danach:
     auswaerts gibt es keinen Gastgeber, also auch keine Farbe fuer einen. */
  gastgeber_farbe: t.ort ? null : t.gastgeber_farbe,
  ort: t.ort || null,
  von: t.eingetragen_von || null,
  von_farbe: t.eingetragen_von ? (t.von_farbe ?? null) : null,
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
// `gruppeId` seit Etappe 2, `null` bedeutet "ueber alle Gruppen" - siehe `losTagStmt`.
const notrufeStmt = (env, ichId, traeger = null, gruppeId = null) => env.DB.prepare(`
  SELECT n.id, n.user_id, n.art, n.lat, n.lon, n.genau, n.erstellt, n.bis,
         n.live, n.standort_am, u.name, ${farbeSql('u', traeger)} AS farbe,
         (SELECT count(*) FROM notruf_kreis k WHERE k.notruf_id = n.id) AS kreis_gross,
         (SELECT group_concat(k.user_id) FROM notruf_kreis k WHERE k.notruf_id = n.id) AS kreis_ids
  FROM notrufe n
  JOIN users u ON u.id = n.user_id
  WHERE n.weg_am IS NULL AND n.bis > datetime('now') AND u.name IS NOT NULL
    AND (?2 IS NULL OR n.gruppe_id = ?2)
    AND (n.user_id = ?1
         OR NOT EXISTS (SELECT 1 FROM notruf_kreis k WHERE k.notruf_id = n.id)
         OR EXISTS (SELECT 1 FROM notruf_kreis k
                    WHERE k.notruf_id = n.id AND k.user_id = ?1))
  ORDER BY n.erstellt DESC
`).bind(ichId, gruppeId);

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
  /* Sein Platz in der Kreidereihe. Die Zeile schreibt einen ganzen Satz
     ("Basti braucht Bier"), der Regenbogen faellt darin aber nur auf den
     NAMEN - der Rest ist die Not und nicht der Mensch. */
  farbe: n.farbe ?? null,
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
   keine Bestenliste, und wer jemanden sucht, sucht ihn alphabetisch.

   `gruppeId` seit Etappe 2, PFLICHT: ein Notruf gehoert einer Gruppe, sein
   Empfaengerkreis darf nur aus DEREN Mitgliedern kommen - sonst waehlte
   jemand einen Namen aus einer fremden Runde an, die von dem Notruf nie
   erfaehrt. */
const kreisWaehlbarStmt = (env, ichId, gruppeId, traeger = null) => env.DB.prepare(`
  SELECT u.id, u.name, ${farbeSql('u', traeger)} AS farbe
  FROM gruppen_mitglied m
  JOIN users u ON u.id = m.user_id
  WHERE m.gruppe_id = ? AND u.id <> ? AND u.name IS NOT NULL
    AND u.gesperrt_am IS NULL AND u.entfernt_am IS NULL
  ORDER BY u.name COLLATE NOCASE
`).bind(gruppeId, ichId);

/* Den gewuenschten Kreis aus dem Rumpf lesen. Gibt `{ fehler }` oder
   `{ ids }`, wobei `ids === null` "an alle" heisst.

   VIER EINGABEN, VIER BEDEUTUNGEN, und die Asymmetrie ist Absicht:

     kein `kreis` / null   an alle - so wie jeder Notruf vor dieser Migration
     [1, 7, 12]            nur an diese
     [eigene Id]           die PROBE - siehe unten
     []                    Fehler, kein "an niemanden"

   Die leere Liste ist der gefaehrliche Fall: ein Fehler in der Seite, der ein
   leeres Feld schickt, wuerde sonst einen Notruf anlegen, den NIEMAND sieht -
   ein Hilferuf ins Leere, der auf der eigenen Tafel trotzdem so aussieht, als
   waere er raus. Also 400 statt Stille.

   DIE PROBE ist derselbe Fall, nur ausdruecklich gewollt: ein Kreis aus genau
   einem Namen, dem eigenen. Sie ist der einzige Weg, den Notruf in der
   LAUFENDEN Anlage auszuprobieren - Karte, Marke, Frist, Zuruecknehmen -, ohne
   die Runde zu wecken. Der Aufrufer sagt mit `darfProbe`, ob sie erlaubt ist;
   heute darf sie der Wirt (`istAdmin`). Fuer alle anderen bleibt es bei der
   alten Antwort: wer nur sich selbst waehlt, hat sich vertippt.

   `probe` zieht sich durch beide Routen und schaltet dort ZWEIERLEI ab - die
   Post und den Zaehler. Eine Spalte am Notruf braucht es dafuer nicht: dass
   der Kreis aus einem Namen besteht und das der eigene ist, steht schon in
   `notruf_kreis`, und eine zweite Fassung derselben Tatsache liefe irgendwann
   auseinander.

   Nur die ALLEINIGE eigene Id ist eine Probe. `[ich, Anna]` bleibt, was es
   war: ein echter Notruf an Anna, die eigene Id faellt still heraus - man
   steht ja ohnehin auf der eigenen Tafel.

   Geprueft wird gegen `kreisWaehlbarStmt`, nicht nur auf "ist eine Zahl":
   sonst legte ein erfundener Wert Zeilen an, die auf niemanden zeigen, und
   der Absender saehe einen Kreis von vier, von denen drei nie existiert
   haben. */
async function notrufKreis(daten, env, ichId, gruppeId, darfProbe = false) {
  const roh = daten.kreis;
  if (roh === undefined || roh === null) return { ids: null };
  if (!Array.isArray(roh)) return { fehler: 'kreis: eine Liste von Ids oder null' };
  if (!roh.length) return { fehler: 'kreis: mindestens einer - sonst sieht ihn niemand' };

  if (roh.length === 1 && Number(roh[0]) === ichId) {
    if (!darfProbe) return { fehler: 'kreis: dich selbst zu rufen hilft dir nicht' };
    return { ids: [ichId], probe: true };
  }

  const gewuenscht = new Set();
  for (const w of roh) {
    const id = Number(w);
    if (!Number.isInteger(id)) return { fehler: 'kreis: nur Ids' };
    if (id !== ichId) gewuenscht.add(id);
  }

  const waehlbar = await kreisWaehlbarStmt(env, ichId, gruppeId).all();
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
function notrufPost(env, ctx, ich, notrufId, art, lat, lon, empfaenger, bis = null, live = false) {
  const wohin = mapsLink(lat, lon);
  const was = art === 'bier' ? `${ich.name} braucht Bier`
    : art === 'kamerad' ? `${ich.name} sucht Gesellschaft`
    : `${ich.name} braucht Bier und Gesellschaft`;
  /* Dasselbe ohne den Namen davor. Die Mail traegt ihn im Betreff, der Push
     hat ihn schon im Titel - und dort ist er auch besser aufgehoben, siehe
     unten. */
  const wasKurz = art === 'bier' ? 'Braucht Bier'
    : art === 'kamerad' ? 'Sucht Gesellschaft'
    : 'Braucht Bier und Gesellschaft';

  /* Das Klopfen an der Tuer, an derselben Stelle und an denselben Kreis. Fuer
     den Notruf ist es der wichtigere der beiden Wege: er gilt neunzig Minuten,
     und so lange liegt eine Mail gern ungelesen.

     Die Haltbarkeit ist die RESTLAUFZEIT, nicht die volle Frist - beim
     Dazunehmen ist der Notruf schon eine Weile alt. Ein Push, den der
     Push-Dienst laenger aufhebt als den Notruf selbst, weckt jemanden zu
     einem Hilferuf, den es nicht mehr gibt. Eine Minute Untergrenze, damit
     ein knapp erloschener nicht mit TTL 0 rausgeht (das hiesse "nur
     zustellen, wenn das Geraet gerade wach ist" - hier waere es schlicht ein
     Rechenfehler, der wie Absicht aussieht).

     Dieselbe Marke wie beim ersten Ruf: nimmt der Rufende spaeter jemanden
     dazu, ersetzt die neue Meldung auf den Geraeten des alten Kreises die
     liegende, statt sich danebenzustellen. Das Gatter, das bei der Mail der
     UNIQUE-Index auf `mail_ausgang` uebernimmt, ist hier also der `tag`. */
  const rest = bis
    ? Math.max(60, Math.round((Date.parse(utc(bis)) - Date.now()) / 1000))
    : NOTRUF_MINUTEN * 60;

  /* DER NAME STEHT IM TITEL, DIE NOT IN DER ZEILE DARUNTER - und das ist am
     echten Geraet entschieden worden, nicht am Schreibtisch. `Anna braucht
     Bier und Gesellschaft` ist als Titel zu lang: das Handy schnitt es zu
     "Anna braucht Bier und Gesellsc..." ab, und damit fiel ausgerechnet
     weg, WAS fehlt. Ein Titel muss in eine Zeile passen; "Notruf von Anna"
     tut das immer, egal wie lang der Name ist.

     Der Satz "Auf der Tafel steht der Notruf noch 90 Minuten" ist ganz
     entfallen. Er sagte nichts, was der Empfaenger tun koennte - dass ein
     Notruf auf der Tafel steht, ist der Normalfall und keine Nachricht.

     Die Restlaufzeit steht jetzt nur noch bei LIVE-Notrufen da, und dort
     bedeutet sie etwas anderes: nicht "der Ruf gilt noch so lange", sondern
     "der Standort wandert so lange mit". Das ist der Unterschied, der fuer
     den, der sich auf den Weg macht, zaehlt.

     DAS `\n` IST ABSICHT UND ES TRAEGT - am iPhone nachgesehen, nicht
     geglaubt. Ein weicher Umbruch riss die Angabe mittendurch ("90 Min."
     oben, "live" unten), und dagegen half weder Kuerzen noch ein geschuetztes
     Leerzeichen zuverlaessig: wo eine Zeile endet, entscheidet die
     Systemschriftgroesse, nicht wir. Mit dem harten Umbruch steht die
     Trennung da, wo sie hingehoert, und die Angabe darf wieder ausgeschrieben
     sein. Wer hier kuerzt, um "Platz zu sparen", macht es schlechter. */
  stosse(env, ctx, 'notruf', empfaenger, {
    titel: `Notruf von ${ich.name}`,
    text: wasKurz + (live ? `\nlive für ${Math.round(rest / 60)} Minuten` : ''),
    url: `${env.SEITE}#notruf`,
    tag: `notruf-${notrufId}`,
    ttl: rest,
    dringend: true,
    ausloeser: ich.id,
  });

  benachrichtige(env, ctx, 'notruf', empfaenger, {
    bezug: `notruf:${notrufId}`,
    ausloeser: ich.id,
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
/* `kinder` sind die Ids derer, die heute Geburtstag haben (Schema 31). Ein
   Argument mit Vorgabe und keine Pflicht: die Routen, die das Rad nur
   nebenher mitliefern, sollen es nicht holen muessen - ohne die Liste fehlt
   `ehre` schlicht, und die Seite zeichnet dann das gewoehnliche Rad. */
function losAntwort(tag, lage, topf, termine = [], kinder = [], tafelAn = true) {
  const z = lage.gueltig;
  const ehre = ehrenLage(kinder, topf, termine, tag);
  const gemeinsam = {
    tag,
    /* Wem zu Ehren gedreht werden kann, und ob es dabei bleibt - oder gar
       nicht erst da: ein FEHLENDER Schluessel ist die richtige Auskunft fuer
       "heute niemand". Die Seite prueft auf sein Dasein und faellt damit auch
       in der halben Minute nach einem Deploy sauber zurueck, in der noch ein
       Worker ohne dieses Feld antwortet. */
    ...(ehre ? { ehre } : {}),
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
    /* `ehre.nur` schliesst die echte Ziehung fuer heute - der Abend des
       Geburtstagskindes steht ja schon. Gedreht wird trotzdem, aber nur zu
       seinen Ehren, und das entscheidet die Seite an `ehre` und nicht hier:
       `darf_drehen` beantwortet weiterhin genau eine Frage, naemlich ob
       `POST /api/drehen` etwas ausrichten wuerde. Die Route sagt dasselbe
       noch einmal mit einem 409 - ein Tab, der seit dem Morgen offensteht,
       kennt diese Antwort ja noch nicht. */
    const genug = topf.length >= lage.mindest && !(ehre && ehre.nur);
    return {
      ...gemeinsam, gewinner: null, status: null, feld: losSegmente(topf, kinder, tafelAn),
      // `offen` heisst seit jeher "es kann gedreht werden"; `darf_drehen` ist
      // derselbe Wert unter dem Namen, der ihn erklaert.
      offen: genug, darf_drehen: genug,
    };
  }

  // Der Abend, den die Zusage angelegt hat. Die Seite schreibt daraus die
  // Uhrzeit hinter den Namen: "Maike hat zugesagt - 19 Uhr".
  const t = termine.find(x => x.los_id === z.id) || null;

  /* Aus dem EINGEFRORENEN Feld hergeleitet, nicht aus der heutigen
     Schalterstellung: die Aussage "an diesem Abend zaehlte kein Bestand"
     gehoert dem Abend, nicht der Gruppe von heute (dieselbe Begruendung wie
     bei `farbe` und `geburtstag` oben an `losSegmente`). Ein altes Feld ohne
     `biere`-Schluessel (vor Schema 28) ist `undefined`, nicht `null` - der
     Test bleibt dort `false`, und `z.biere` reist unveraendert durch. */
  const feld = JSON.parse(z.feld);
  const biere = feld.length && feld.every(s => s.biere === null) ? null : z.biere;

  return {
    ...gemeinsam,
    gewinner: z.gewinner,
    biere,
    feld,
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
// Kasse (Schema 34, Etappe 3)
// ---------------------------------------------------------------------------

/* Der geltende Preis: die juengste Zeile, deren `gueltig_ab` nicht in der
   Zukunft liegt (Entscheidung 38). `id DESC` als zweiter Schluessel ist
   Pflicht, nicht Zierrat - siehe migrations/0034. `null`, wenn fuer dieses
   Getraenk noch nie ein Preis gesetzt wurde; das ist KEIN Fehlerfall im
   Datenmodell, sondern der Normalzustand eines gerade erst angelegten
   Getraenks, und die Buchungsroute weist ihn ausdruecklich ab statt mit
   `cent = 0` durchzubuchen. */
function geltenderPreis(env, getraenkId, zeitpunktDb) {
  return env.DB.prepare(`
    SELECT cent, gueltig_ab FROM preis
     WHERE getraenk_id = ? AND gueltig_ab <= ?
     ORDER BY gueltig_ab DESC, id DESC LIMIT 1
  `).bind(getraenkId, zeitpunktDb).first();
}

/* Der Bestand ist die Summe seiner Ereigniszeilen - keine gepflegte Zahl,
   dieselbe Bauweise wie `reports`. EIN Ort fuer diese Formel: `GET /api/kasse`,
   die Mindestbestandspruefung und der Bestandsverlauf aus Etappe 6 muessen
   dieselbe Summe lesen, sonst driften sie auseinander, und Drift heisst hier:
   die Warnmail geht raus, waehrend die Seite noch genug zeigt. */
function bestandStand(env, gruppeId, getraenkId) {
  return env.DB.prepare(
    'SELECT coalesce(sum(menge),0) AS n FROM bestand WHERE gruppe_id = ? AND getraenk_id = ?')
    .bind(gruppeId, getraenkId).first().then(r => r.n);
}

/* Nach JEDER Bestandsaenderung aufzurufen - Buchung, Storno, Lieferung,
   Korrektur, und wenn der Admin `mindest` erst gerade setzt (Entscheidung 34).
   Unter der Schwelle: eine Mail, aber nur EINE je Unterschreitung - das
   uebernimmt der partielle UNIQUE-Index `mail_einmal` ueber den Bezug
   `bestand:<getraenk_id>:<warn_lauf>`, hier steht keine eigene Sperre.
   Ueber der Schwelle: die laufende Nummer zaehlt hoch, aber nur EINMAL und
   nur, wenn fuer den GERADE GUELTIGEN Bezug wirklich eine Mail rausging -
   das bedingte UPDATE macht den Ruecksetzer unabhaengig von der Reihenfolge,
   in der zwei gleichzeitige Aenderungen hier ankommen. Ohne eine tatsaechlich
   verschickte Mail (kein AGENTMAIL_KEY, oder die Schwelle wurde nie
   unterschritten) bleibt `warn_lauf` stehen - das ist richtig, es gibt dann
   nichts zurueckzusetzen. */
async function pruefeMindestbestand(env, ctx, gruppeId, getraenkId, stand) {
  const d = await env.DB.prepare('SELECT name, mindest, warn_lauf FROM getraenk WHERE id = ?')
    .bind(getraenkId).first();
  if (!d || d.mindest == null) return;

  if (stand < d.mindest) {
    const g = await env.DB.prepare('SELECT name FROM gruppen WHERE id = ?').bind(gruppeId).first();
    benachrichtige(env, ctx, 'bestand_knapp', gruppenAdminKreis(env, gruppeId), {
      bezug: `bestand:${getraenkId}:${d.warn_lauf}`,
      betreff: `${d.name} wird knapp — ${g.name}`,
      text: `${d.name} steht bei ${stand}, die Schwelle liegt bei ${d.mindest}.\n\n`
          + `Zeit für Nachschub: ${env.SEITE}`,
      html: `<p>${nurText(d.name)} steht bei <strong>${stand}</strong>, die Schwelle liegt `
          + `bei ${d.mindest}.</p>` + mailKnopf(env.SEITE, 'Zur Kasse'),
    });
    return;
  }

  /* Tabellenalias im UPDATE ist Pflicht: `mail_ausgang` traegt selbst ein
     `id` - ohne `g.` waere die Unterabfrage gegen sich selbst mehrdeutig und
     zaehlte bei jedem Mailversand irgendeines Getraenks hoch. */
  await env.DB.prepare(`
    UPDATE getraenk AS g SET warn_lauf = warn_lauf + 1
     WHERE g.id = ? AND g.mindest IS NOT NULL AND EXISTS (
       SELECT 1 FROM mail_ausgang m WHERE m.art = 'bestand_knapp'
        AND m.bezug = 'bestand:' || g.id || ':' || g.warn_lauf)
  `).bind(getraenkId).run();
}

/* Der Wirt greift durch, ohne Mitglied zu sein - das gehoert ins Protokoll,
   wie bei `PATCH /api/gruppe` und dem Nachruecken (§4.4). Ein Gruppenadmin,
   der seine eigene Kasse pflegt, tut nichts Protokollwuerdiges: es ist
   seine. */
function kasseAdminLog(env, ich, g, aktion, detail) {
  if (g.mitglied) return;
  return env.DB.prepare(`
    INSERT INTO admin_log (admin_id, aktion, ziel_id, detail, gruppe_id)
    VALUES (?, ?, NULL, ?, ?)
  `).bind(ich.id, aktion, detail, g.gruppe.id).run();
}

// ---------------------------------------------------------------------------
// Abrechnung (Schema 35, Etappe 4)
// ---------------------------------------------------------------------------

// 'YYYY-MM' - derselbe Schluessel wie `strftime('%Y-%m', gebucht_am)` in
// `buchung`, EIN Ausdruck fuer Vorschau und Abschluss (siehe `SALDO_SUMMEN_SQL`
// unten). Muss zu ihm passen wie ein Schluessel zum Schloss - kein eigenes
// Datumsformat erfinden.
const monatSchluessel = (jahr, monat) => `${jahr}-${String(monat).padStart(2, '0')}`;

// Jahr und Monat als Ganzzahlen aus einer `gebucht_am`-Zeitangabe
// ('YYYY-MM-DD HH:MM:SS') - fuer die Storno-/Gegenbuchungs-Guards, die
// `abrechnungFuer()` mit den Feldern einer BUCHUNG statt eines gewaehlten
// Monats aufrufen.
const jahrMonatAus = zeit => [Number(zeit.slice(0, 4)), Number(zeit.slice(5, 7))];

// Die `abrechnung`-Zeile eines Monats, oder `null`, wenn er noch offen ist -
// "offen" ist die ABWESENHEIT der Zeile (siehe migrations/0035). `jahr`/
// `monat` als getrennte Ganzzahlen, nicht als zusammengesetzter Schluessel -
// `WHERE gruppe_id=? AND jahr=? AND monat=?` kann den UNIQUE-Index
// `abrechnung_monat` nutzen, ein `printf()` auf jeder Zeile könnte es nicht.
// Ruft diese Funktion mit einer `gebucht_am`-Zeitangabe auf, zerlegt der
// Aufrufer sie selbst in `Number(zeit.slice(0,4))`/`Number(zeit.slice(5,7))`.
function abrechnungFuer(env, gruppeId, jahr, monat) {
  return env.DB.prepare(
    'SELECT id, status FROM abrechnung WHERE gruppe_id = ? AND jahr = ? AND monat = ?')
    .bind(gruppeId, jahr, monat).first();
}

/* Die Monatssummen je Mensch - EIN Ausdruck fuer Vorschau (`GET
   /api/abrechnung`) und Abschluss (`POST /api/abrechnung/abschluss`), sonst
   laufen sie auseinander wie beinahe `naechster_preis` in Etappe 3. Derselbe
   `strftime`-Ausdruck wie `mein_monat` in `GET /api/kasse`. KEIN JOIN auf
   `gruppen_mitglied` - der Wirt kann in einer Gruppe buchen, in der er kein
   Mitglied ist (`inGruppe()` laesst ihn als Admin durch), und diese Buchung
   braucht trotzdem ihren Saldo. `gebucht_am` wird nie gebunden - immer
   Server-Jetzt, es gibt kein rueckdatiertes Buchen. `ehemalig` greift auf
   `b.gruppe_id` zurueck, das die Query ohnehin schon bindet - kein zweiter
   Parameter noetig. `ORDER BY u.name` gleich hier, nicht erst beim Aufrufer -
   dieselbe Reihenfolge wie die eingefrorene Fassung nach dem Abschluss.

   ZWEI QUELLEN SEIT ETAPPE 8 (Entscheidung 50): Getraenkebuchungen UND
   Geldstrafen desselben Monats, in EINEN Saldo. Einer schuldet einen Betrag,
   nicht zwei - und deshalb wird hier summiert und nicht an drei Aufrufstellen
   nachtraeglich addiert. Genau diese Konstante ist in Etappe 4 entstanden,
   weil zwei auseinandergelaufene Kopien derselben Abfrage der erste Blocker
   jener Abnahme waren; Etappe 8 erweitert sie und legt keine zweite an.

   Die Halbierung in `cent` und `strafe_cent`: der Saldo braucht die Summe,
   die Anzeige braucht die Aufteilung ("davon 4,50 € Strafen"). `biere` bleibt
   dabei sauber - eine Strafe traegt 0 Getraenke, drei Strafen sehen nicht aus
   wie drei Bier.

   ACHT PLATZHALTER STATT VIER... nein, VIER statt zwei, und sie sind
   POSITIONSABHAENGIG: Gruppe und Monatsschluessel zweimal, erst fuer die
   Buchungen, dann fuer die Strafen. Nummerierte Platzhalter (`?1`) waeren
   lesbarer, gingen hier aber schief - `SALDO_INSERT_SQL` setzt EIN eigenes `?`
   davor, und SQLite vergibt einem unnummerierten `?` den naechsten freien
   Index; das eigene `?` bekaeme die 1 und kollidierte mit `?1` im Rumpf.

   `s.status IN ('offen','abgerechnet')`: 'offen' ist die noch nicht
   abgerechnete Strafe, 'abgerechnet' die schon eingeflossene. BEIDE zaehlen,
   damit die Summe eines Monats dieselbe bleibt, egal ob er gerade
   abgeschlossen wird oder es laengst ist - sonst schrumpfte das CSV eines
   abgerechneten Monats gegenueber der Vorschau, die es erzeugt hat. 'erlassen'
   faellt heraus, ebenso die drei Zustaende aus Etappe 9 (vorgeschlagen,
   verworfen, bestritten): ein Vorschlag ist keine Strafe, und eine bestrittene
   ist ausgesetzt, bis sie entschieden ist. */
const SALDO_SUMMEN_SQL = `
  SELECT q.user_id, u.name,
         sum(q.biere) AS biere, sum(q.cent) AS cent, sum(q.strafe_cent) AS strafe_cent,
         NOT EXISTS(SELECT 1 FROM gruppen_mitglied gm
                     WHERE gm.gruppe_id = q.gruppe_id AND gm.user_id = q.user_id) AS ehemalig
    FROM (
      SELECT b.user_id, b.gruppe_id,
             b.menge AS biere, b.menge * b.cent AS cent, 0 AS strafe_cent
        FROM buchung b
       WHERE b.gruppe_id = ? AND b.storniert_am IS NULL
         AND strftime('%Y-%m', b.gebucht_am) = ?
      UNION ALL
      SELECT s.user_id, s.gruppe_id,
             0 AS biere, s.cent AS cent, s.cent AS strafe_cent
        FROM strafe s
       WHERE s.gruppe_id = ? AND s.art = 'geld'
         AND s.status IN ('offen','abgerechnet')
         AND strftime('%Y-%m', s.verhaengt_am) = ?
    ) q JOIN users u ON u.id = q.user_id
   GROUP BY q.user_id
   ORDER BY u.name
`;

/* Die Bindeliste zu `SALDO_SUMMEN_SQL` - vier Werte in genau dieser
   Reihenfolge, an DREI Aufrufstellen dieselbe. Eine Funktion statt vierer
   getippter Argumente, damit eine fuenfte Aufrufstelle sie nicht halb
   hinschreibt. */
const saldoSummenWerte = (gruppeId, key) => [gruppeId, key, gruppeId, key];

/* SEIT WANN es fuer diese Gruppe Abrechnungsmonate gibt, als 'YYYY-MM'.
   Der Boden des Monatsblaetterers in `gruppe.html` - und, seit der Meldung vom
   2026-08-17, auch die Schranke der beiden Routen selbst. Ohne sie blaetterte
   die Seite unbegrenzt zurueck, bis Dezember 2025 und weiter, in Monate, in
   denen es die Gruppe nicht gab: leere Liste, darunter ein Knopf
   "abschliessen". Ein Monatsabschluss ueber ein Nichts, das nie zur Gruppe
   gehoerte, ist keine Buchhaltung.

   DER BODEN IST DER MONAT DER GRUPPENGRUENDUNG - aber nie spaeter als der
   aelteste Monat, in dem tatsaechlich etwas liegt. Der Zusatz ist kein
   Misstrauen gegen `gruppen.erstellt`, sondern gegen dessen Bedeutung bei der
   Auffanggruppe: die hat migrations/0032 angelegt, ihr `erstellt` ist also der
   Tag des Rollouts und nicht der Tag, an dem die Runde anfing. Ohne den Zusatz
   verschwaende ein Monat mit echten Buchungen hinter dem Boden - Daten, die es
   gibt, waeren nicht mehr erreichbar.

   VIER QUELLEN, und die letzte ist die wichtigste: ein abgeschlossener Monat
   MUSS erreichbar bleiben, auch wenn seine Buchungen spaeter storniert wurden
   und die anderen Zweige nichts mehr finden. Die ersten drei sind dieselben wie
   beim Monatswaehler der Statistikseite - zwei Blaetterer ueber Kalendermonate,
   eine Regel. */
const abrechnungSeit = async (env, gruppeId) => {
  const z = await env.DB.prepare(`
    SELECT min(m) AS seit FROM (
      SELECT strftime('%Y-%m', erstellt) AS m FROM gruppen WHERE id = ?1
      UNION ALL
      SELECT min(strftime('%Y-%m', gebucht_am)) FROM buchung
        WHERE gruppe_id = ?1 AND storniert_am IS NULL
      UNION ALL
      SELECT min(strftime('%Y-%m', verhaengt_am)) FROM strafe
        WHERE gruppe_id = ?1 AND art = 'geld' AND status IN ('offen','abgerechnet')
      UNION ALL
      SELECT min(printf('%04d-%02d', jahr, monat)) FROM abrechnung WHERE gruppe_id = ?1
    )
  `).bind(gruppeId).first();
  return (z || {}).seit || null;
};

// Der Monatsabschluss selbst - EIN Statement statt einer Schleife ueber
// potenziell viele Mitglieder, kein Fenster zwischen Aggregieren und
// Schreiben. `s.cent > 0`: Guthaben (0 oder negativ, eine Gegenbuchung hat
// mehr ausgeglichen als gebucht wurde) gilt sofort als 'bezahlt', mit
// `gezahlt_cent = 0` - die Spalte traegt nur von einem Admin bestaetigtes
// Geld, kein Guthaben.
const SALDO_INSERT_SQL = `
  INSERT INTO saldo (abrechnung_id, user_id, betrag_cent, status)
  SELECT ?, s.user_id, s.cent, CASE WHEN s.cent > 0 THEN 'offen' ELSE 'bezahlt' END
    FROM (${SALDO_SUMMEN_SQL}) s
`;

/* Die Strafen EINES Monats, Zeile fuer Zeile - fuer die Anzeige und das CSV,
   nicht fuer die Summe (die steckt schon in `SALDO_SUMMEN_SQL`). Anders als
   dort stehen hier ALLE Arten und alle noch geltenden Zustaende drin: eine
   Tatstrafe kostet kein Geld, gehoert aber sichtbar zum Monat, und wer sie
   erledigt hat, will das sehen.

   'erlassen' faellt heraus - eine erlassene Strafe ist keine mehr. Sie steht
   weiter in `strafe_log`, wo die Frage "was ist damit passiert" hingehoert.
   Seit Etappe 9 faellt 'verworfen' aus demselben Grund mit heraus: ein
   abgelehnter Vorschlag war nie eine Strafe. */
const STRAFEN_MONAT_SQL = `
  SELECT s.id, s.user_id, u.name, s.titel, s.art, s.cent, s.tat, s.grund, s.status,
         s.verhaengt_am, s.gemeldet_am, s.erledigt_am, s.bezug_strafe_id,
         v.name AS von_name
    FROM strafe s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN users v ON v.id = s.verhaengt_von
   WHERE s.gruppe_id = ? AND s.status NOT IN ('erlassen','verworfen')
     AND strftime('%Y-%m', s.verhaengt_am) = ?
   ORDER BY s.verhaengt_am DESC, s.id DESC
`;

/* Die eingefrorenen Salden EINES Abschlusses, samt `s.id` - ohne die geht
   weder Melden noch Bestaetigen (Etappe-4-Abnahmefund: beide fehlten, weil
   diese Abfrage einmal fuer `GET /api/abrechnung` und einmal fuer das CSV
   geschrieben wurde, und `id` blieb an BEIDEN Stellen weg). EIN Ausdruck fuer
   beide Aufrufer, wie `SALDO_SUMMEN_SQL` fuer die Vorschau. */
const SALDO_ZEILEN_SQL = `
  SELECT s.id, s.user_id, u.name, s.betrag_cent, s.gezahlt_cent, s.status, s.gemeldet_am, s.bestaetigt_am,
         EXISTS(SELECT 1 FROM gruppen_mitglied m
                 WHERE m.gruppe_id = ? AND m.user_id = s.user_id) AS drin
    FROM saldo s JOIN users u ON u.id = s.user_id
   WHERE s.abrechnung_id = ?
   ORDER BY u.name
`;

// Cent als deutsche Kommazahl, fuer das CSV - dieselbe Schreibweise wie die
// Beispielbetraege in der Statuskette (Plan §6: "5,00 € auf 12,50 €").
const centStr = cent => (cent / 100).toFixed(2).replace('.', ',');

// Ein CSV-Feld nach RFC 4180: gequotet, wenn es das Trennzeichen, ein
// Anfuehrungszeichen oder einen Zeilenumbruch traegt; ein Anfuehrungszeichen
// im Feld wird verdoppelt. `;` als Trennzeichen (nicht `,`) - die Betraege
// tragen ein Dezimalkomma ("12,50"), das erzwingt das Semikolon.
function csvFeld(wert) {
  const s = String(wert ?? '');
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvZeile(felder) {
  return felder.map(csvFeld).join(';') + '\r\n';
}

// ---------------------------------------------------------------------------
// Hausordnung und Strafen (Schema 38, Etappe 8)
// ---------------------------------------------------------------------------

/* Jeder Statuswechsel einer Strafe, ohne Ausnahme - wortgleich zu
   `saldo_log` (Entscheidung 22, jetzt 49/55). EINE Funktion statt vierer
   getippter INSERTs: die Etappe-4-Lehre gilt hier genauso, nur dass es diesmal
   nicht um eine Abfrage geht, sondern um eine Pflicht, die man an genau der
   fuenften Stelle vergisst.

   `admin_log` bekommt hiervon NICHTS ab - das traegt Instanz- und
   Durchgriffshandlungen (Entscheidung 4), nicht den Alltag eines
   Gruppenadmins in seiner eigenen Gruppe. Der Durchgriff des WIRTS steht
   trotzdem dort, ueber `kasseAdminLog()`, wie ueberall sonst. */
function strafeLog(env, strafeId, alt, neu, vonId, notiz = null) {
  return env.DB.prepare(
    'INSERT INTO strafe_log (strafe_id, alt, neu, von, notiz) VALUES (?, ?, ?, ?, ?)')
    .bind(strafeId, alt, neu, vonId, notiz || null).run();
}

// Wie eine Strafe auf der Leitung aussieht - EINE Form fuer alle Routen, damit
// `index.html` und `gruppe.html` nicht zwei verschiedene Zeilenformen bauen.
const strafeRaus = s => ({
  id: s.id, user_id: s.user_id, name: s.name, titel: s.titel, art: s.art,
  cent: s.cent, tat: s.tat, grund: s.grund, status: s.status,
  verhaengt_am: utc(s.verhaengt_am), von: s.von_name ?? null,
  gutschrift_zu: s.bezug_strafe_id ?? null,
});

/* Post an den Betroffenen (Entscheidung 56). Der Kreis ist genau EINE Person -
   ausgeschrieben, weil jede Mail seit Etappe 1 ihren Kreis nennen muss
   (Nachgereicht #8) und `null` hier "an alle" hiesse.

   `bezug` sperrt die Wiederholung ueber denselben partiellen Unique-Index
   (`mail_einmal`), den schon die Mindestbestandsmail benutzt: ein zweiter Ruf
   derselben Route - Doppelklick, Wiederholung nach Abbruch - schickt nicht
   zweimal. Je Strafe und Anlass genau eine. */
function strafeMail(env, ctx, { strafe, gruppeName, anlass }) {
  const was = strafe.art === 'geld'
    ? centStr(Math.abs(strafe.cent ?? 0)) + ' €'
    : (strafe.tat || 'eine Auflage');
  const kopf = anlass === 'erlassen'
    ? `Erlassen: ${strafe.titel} — ${gruppeName}`
    : `Strafe: ${strafe.titel} — ${gruppeName}`;
  const satz = anlass === 'erlassen'
    ? `Die Sache ist vom Tisch: „${strafe.titel}" (${was}) wurde erlassen.`
    : `„${strafe.titel}" — ${was}.`
      + (strafe.grund ? `\n\nGrund: ${strafe.grund}` : '')
      + (strafe.art === 'geld'
          ? '\n\nDer Betrag laeuft mit der naechsten Monatsabrechnung mit.'
          : '\n\nWenn es erledigt ist, sag Bescheid.');

  benachrichtige(env, ctx, 'strafe', [strafe.user_id], {
    bezug: `strafe:${strafe.id}:${anlass}`,
    betreff: kopf,
    text: `${satz}\n\n${env.SEITE}`,
    html: `<p>${nurText(satz).replace(/\n/g, '<br>')}</p>`
        + mailKnopf(env.SEITE, 'Zur Hausordnung'),
  });
}

/* Post an die Gruppenadmins (Etappe 9): ein Vorschlag oder ein Einspruch
   wartet. Eigene Mailart, nicht `strafe` - die geht an den Betroffenen, diese
   an die, die entscheiden muessen. Zwei verschiedene Kreise sind zwei
   verschiedene Arten, sonst kann man nur beide zusammen abbestellen. */
function einspruchMail(env, ctx, { strafe, gruppeId, gruppeName, anlass, von }) {
  const was = anlass === 'vorschlag'
    ? `${von} schlägt eine Strafe vor: „${strafe.titel}"`
    : `${von} widerspricht der Strafe „${strafe.titel}"`;
  benachrichtige(env, ctx, 'einspruch', gruppenAdminKreis(env, gruppeId), {
    bezug: `strafe:${strafe.id}:${anlass}`,
    betreff: `${anlass === 'vorschlag' ? 'Vorschlag' : 'Einspruch'} — ${gruppeName}`,
    text: `${was}\n\nEntscheiden lässt sich das in der Gruppenverwaltung:\n${env.SEITE}`,
    html: `<p>${nurText(was)}</p>` + mailKnopf(env.SEITE, 'Zur Gruppe'),
  });
}

/* Die Grenzen eines Strafbetrags, an EINER Stelle - Verhaengen und Gutschrift
   pruefen dasselbe. `erlaubtNegativ` nur fuer die Gutschrift (Entscheidung
   52): eine verhaengte Strafe kostet, eine Gutschrift erstattet. */
function strafeCentPruefen(roh, erlaubtNegativ = false) {
  const cent = Number(roh);
  if (!Number.isInteger(cent)) return { fehler: 'cent: eine ganze Zahl' };
  if (!erlaubtNegativ && cent <= 0) return { fehler: 'cent: eine ganze Zahl größer 0' };
  if (Math.abs(cent) > STRAFE_CENT_MAX) {
    return { fehler: `cent: höchstens ${STRAFE_CENT_MAX} (${centStr(STRAFE_CENT_MAX)} €)` };
  }
  return { cent };
}

// ---------------------------------------------------------------------------
// Zahlwege (Schema 36, Etappe 5)
// ---------------------------------------------------------------------------

/* Der Besitz-Zugang zu EINEM Saldo - das Gegenstueck zu `inGruppe()`, aber
   OHNE Mitgliedschafts- oder Schalterpruefung (Opus-Konsultation vor der
   Festlegung, 2026-08-11, dieselbe Begruendung wie bei `GET /api/salden` und
   `POST /api/saldo/bestaetigung`: ein Ausgetretener hat keine
   `gruppen_mitglied`-Zeile mehr und muss seine Schuld trotzdem begleichen
   koennen, und ein abgeschaltetes `kasse_an` heisst "wir buchen gerade
   nichts", nicht "eine bestehende Schuld ist unbezahlbar"). Der Besitzcheck
   IST `id = ? AND user_id = ?`, dieselbe Antwort fuer "gibt es nicht" und
   "nicht deiner".

   `GET /api/zahlwege?saldo=` UND `GET /api/zahlung/qr.svg` rufen diese EINE
   Funktion - der Guard auf "schon ausgeglichen" (Restschuld < 1 Cent) sitzt
   hier zentral, nicht an beiden Routen getrennt, sonst verliert ihn eine der
   beiden irgendwann (dieselbe Lehre wie bei `SALDO_ZEILEN_SQL`). Die
   EPC-Obergrenze (999.999.999,99 EUR) gehoert NICHT hierher, sondern allein
   in `GET /api/zahlung/qr.svg` - sie ist eine Eigenschaft des Girocodes,
   kein allgemeiner Zahlwege-Guard, und wuerde hier einen absurd hohen (in
   der Praxis nie erreichten) Saldo auch fuer PayPal/Wero/Bar sperren, die
   diese Grenze gar nicht kennen. */
async function saldoBesitz(request, env, ich, saldoId) {
  if (!ich) return fehler(request, 'Nicht angemeldet', 401);
  if (!Number.isInteger(saldoId) || saldoId <= 0) return fehler(request, 'Welcher Saldo?');

  const saldo = await env.DB.prepare(
    'SELECT id, abrechnung_id, betrag_cent, gezahlt_cent FROM saldo WHERE id = ? AND user_id = ?')
    .bind(saldoId, ich.id).first();
  if (!saldo) return fehler(request, 'Diesen Saldo gibt es nicht', 404);

  const abrechnung = await env.DB.prepare(
    'SELECT gruppe_id, jahr, monat FROM abrechnung WHERE id = ?').bind(saldo.abrechnung_id).first();
  const gruppe = await env.DB.prepare('SELECT id, name FROM gruppen WHERE id = ?')
    .bind(abrechnung.gruppe_id).first();

  const offenCent = saldo.betrag_cent - saldo.gezahlt_cent;
  if (offenCent < 1) return fehler(request, 'Dieser Saldo ist bereits ausgeglichen', 409);

  return { saldo, abrechnung, gruppe, offenCent };
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
/* `gruppeId` ist hier PFLICHT, nicht optional: seit Entscheidung 17 ist ein
   Schnitt einer je GRUPPE, ein ungefiltertes `bewertungen` mischte den vom
   Tresen mit dem vom Buero. */
const bewertungenStmt = (env, gruppeId) => env.DB.prepare(`
  SELECT ziel_art, ziel_id, sterne FROM bewertungen
  WHERE gruppe_id = ?
    AND (ziel_art = 'user'
         OR ziel_id IN (SELECT id FROM termine WHERE beginnt_am > datetime('now', ?)))
`).bind(gruppeId, `-${TERMINE_RUECKBLICK} days`);

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
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/* Satzzeichen am Ende gehoeren dem Satz. Steht WOERTLICH auch in `index.html`. */
function linkPutzen(roh) {
  while (/[.,;:!?»"']$/.test(roh)) roh = roh.slice(0, -1);
  if (roh.endsWith(')') && !roh.includes('(')) roh = roh.slice(0, -1);
  return roh;
}

/* Aus der gefundenen Rohform die abrufbare Adresse: `www.x.de` bekommt sein
   Schema, alles andere bringt es mit. GETRENNT von `linkPutzen`, und das ist
   kein Geschmack — `linkPutzen` KUERZT nur, sein Ergebnis bleibt damit ein
   Praefix des Treffers. Die Seite rechnet genau damit, wenn sie im Fliesstext
   weiterzaehlt (`zuletzt = t.index + roh.length`). Haenge man das Schema dort
   an, waere die Rohform acht Zeichen laenger als der Treffer, und der Zaehler
   naehme acht Zeichen des folgenden Satzes mit weg.

   Nur `www.` und keine nackte Domain: ein Muster auf Punkt-plus-Buchstaben
   traefe „z.B.", „ca.5" und jede Abkuerzung im Text — und dann stuende eine
   Vorschaukarte ueber einem Satz ohne Link. Steht WOERTLICH auch in
   `index.html`. */
function linkZiel(roh) {
  return /^www\./i.test(roh) ? 'https://' + roh : roh;
}

/* Der ERSTE Link im Text, mehr nicht - ein Kommentar bekommt hoechstens eine
   Karte. `matchAll` und nicht `exec`: das klont die Regexp, waehrend `exec` auf
   einem `/g`-Muster `lastIndex` behaelt. Der bliebe im Isolat zwischen zwei
   Anfragen stehen, und dann faende der zweite Kommentar seinen Link nicht. */
function linkAusText(text) {
  for (const t of String(text || '').matchAll(LINK_RE)) {
    const roh = linkPutzen(t[0]);
    if (roh) return linkZiel(roh);
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
       Beerstock-Seite selbst war der Beweis - aus `<title>Wer hat kalt</title>`
       plus dem `<title>` im Bierglas-SVG wurde ein zusammengeklebtes
       "Wer hat kaltBierglas: Fuellstand nach Bestand …". Der Dokumenttitel ist
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
   nie Waise. `waisenWegraeumen()` sieht diese Objekte darum nicht; weggeraeumt
   werden sie ueber ihre Zeile, von `vorschauenWegraeumen()` weiter unten. */
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
      /* `RETURNING gruppe_id` statt `meta.changes`: die Meldung unten braucht
         seit Schema 32 die Gruppe, und die steht am Kommentar selbst. Sie hier
         mitzunehmen kostet nichts - eine zweite Abfrage danach waere eine
         Runde zur Datenbank fuer eine Zahl, die gerade in der Hand lag. Kommt
         keine Zeile zurueck, hat die WHERE-Klausel oben nicht getroffen. */
      const auf = await env.DB.prepare(`
        UPDATE kommentare SET vorschau_id = ?
        WHERE id = ? AND text = ? AND vorschau_id IS NULL AND geloescht_am IS NULL
        RETURNING gruppe_id
      `).bind(id, kommentarId, text).first();
      if (!auf) return;
      if (!env.TAFEL || !auf.gruppe_id) return;
      /* `von` bleibt NULL - und das ist der eine Ruf im ganzen Worker, bei dem
         das so sein muss. Sonst reicht `anstoss()` die Tab-Kennung des
         Schreibers durch, und die Seite verwirft die eigene Meldung
         (`index.html`, `d.von === TAB`) - richtig ueberall dort, wo der
         Schreiber die Antwort seines POSTs schon hat. Hier hat er sie eben
         NICHT: die Karte entsteht lange nach der Antwort, und der Poster waere
         als einziger der, der sie nicht zu sehen bekommt. */
      const stub = env.TAFEL.get(env.TAFEL.idFromName('gruppe:' + auf.gruppe_id));
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

/* Dass das Ziel existiert UND zur Gruppe gehoert, prueft der Worker - einen
   Fremdschluessel kann es auf ein polymorphes Paar nicht geben. `gruppeId`
   steht in der WHERE-Klausel, nicht in einer Pruefung danach (Nachgereicht #1
   aus Etappe 1): ein Ziel einer fremden Gruppe soll sich hier genauso wenig
   finden wie eines, das es nicht gibt - dieselbe Fehlermeldung, keine
   zusaetzliche Auskunft. Gibt den Fehlertext zurueck oder null. */
async function zielFehlt(env, ziel, gruppeId) {
  if (ziel.art === 'user') {
    const u = await env.DB.prepare(`
      SELECT 1 FROM users u JOIN gruppen_mitglied m ON m.user_id = u.id
       WHERE u.id = ? AND u.name IS NOT NULL AND m.gruppe_id = ?
    `).bind(ziel.id, gruppeId).first();
    return u ? null : 'Den gibt es nicht';
  }
  const t = await env.DB.prepare('SELECT 1 FROM termine WHERE id = ? AND gruppe_id = ?')
    .bind(ziel.id, gruppeId).first();
  return t ? null : 'Den Termin gibt es nicht';
}

/* Der Baum, fertig zusammengesteckt. Zwei Abfragen in einem batch, weil eine
   verschachtelte SQL-Fassung dieselbe Arbeit in einer schlechter lesbaren Form
   taete: die Kommentare, und die Reaktionen dazu.

   Die Reaktionen kommen ROH, Zeile fuer Zeile mit Namen - nicht gezaehlt. Die
   Seite zeigt auf Tippen, wer wie reagiert hat, und dafuer ist die Zahl allein
   zu wenig. Gezaehlt wird jetzt beim Zusammenstecken, und die eigene Reaktion
   faellt dabei ab: die dritte Abfrage (nur die eigenen) ist damit weg. */
/* `gruppeId` PFLICHT seit Etappe 2 (Gegenlesen-Fund): bei `ziel_art='user'`
   ist `ziel_id` die rohe, gruppenunabhaengige user_id - ohne diesen Filter
   zeigte das Blatt eines Menschen denselben Kommentarfaden in JEDER Gruppe,
   der man mit ihm gemeinsam angehoert, auch die, die "am Tresen" ueber ihn
   gesagt wurden (Entscheidung 17: "was am Tresen gesagt wird, bleibt am
   Tresen"). Bei `ziel_art='termin'` ist es eine zweite Absicherung: ein
   Termin gehoert ohnehin nur einer Gruppe (Nachgereicht #1), aber zwei
   Filter, die dasselbe zweimal sagen, sind hier billiger als einer, der es
   nur einmal tut und beim naechsten Umbau vergessen wird. */
const baumStmts = (env, ziel, gruppeId, traeger = null) => [
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
  /* Zwei Stufen, weil die 200er-Grenze sonst genau den Fall zerreisst, fuer den
     die Reihenfolge gemacht ist: wer auf einen alten Faden antwortet, holt ihn
     nach unten - dessen Wurzel liegt aber laengst jenseits der juengsten 200,
     und `baumBauen` warf die Antwort dann weg (die Stelle mit `nachId.has`).
     Die Antwort kam an und war nirgends zu sehen.

     `noetig` legt darum die Wurzeln der geholten Antworten dazu. Genau EINE
     Runde reicht: `antwort_auf` traegt immer die Wurzel, nie eine Antwort -
     die Schreibroute normalisiert das beim Anlegen (`wurzel = auf.antwort_auf
     || auf.id`). Ein nachgeladener Faden zeigt dann seine Wurzel und die
     Antworten, die es in die 200 geschafft haben; was dazwischen liegt, bleibt
     weg. Das ist der Preis der Grenze und nicht zu vermeiden, ohne sie ganz
     aufzugeben.

     Die Grenze bindet seither die ID-LISTE, nicht mehr die Zeilen: heraus
     kommen die 200 plus die dazu nachgeladenen Wurzeln, im schlimmsten Fall
     also 400. Mehr geht nicht - nachgeladen wird nur je Antwort eine Wurzel,
     und `UNION` wirft Doppelte weg. Ein LIMIT auf der aeusseren Abfrage waere
     hier falsch herum: sortiert wird absteigend, es schnitte genau die alten
     Wurzeln wieder ab, um die es geht.

     Die Bedingung auf `ziel` steht ABSICHTLICH zweimal da. Innen waehlt sie
     aus, aussen sperrt sie: `antwort_auf` ist eine rohe Spalte, und zeigte
     eine Zeile jemals auf einen Kommentar an einem anderen Ziel, haenge dessen
     Karte ohne die zweite Bedingung in diesem Faden. */
  env.DB.prepare(`
    WITH neueste AS (
      SELECT id, antwort_auf FROM kommentare
      WHERE gruppe_id = ? AND ziel_art = ? AND ziel_id = ?
      ORDER BY id DESC LIMIT ?
    ),
    noetig AS (
      SELECT id FROM neueste
      UNION
      SELECT antwort_auf FROM neueste WHERE antwort_auf IS NOT NULL
    )
    SELECT k.id, k.autor_id, k.antwort_auf, k.an_id, k.text, k.erstellt, k.geaendert,
           k.geloescht_am, k.bild_key, k.sterne,
           coalesce(u.name, 'Ehemaliger') AS autor,
           /* Seine Kreide, und mit einem Traeger die Regenbogenmarke. Ein
              Ehemaliger hat
              keine mehr - farbeSql rechnet ihm trotzdem eine aus der
              Anmeldereihenfolge aus, und das ist richtig so: sein Name steht
              ja auch noch da, nur eben als "Ehemaliger". */
           ${farbeSql('u', traeger)} AS autor_farbe,
           au.name AS an_autor,
           /* Und dieselbe Auskunft fuer den Angesprochenen. Die Zeile au kann
              fehlen (Antwort von vor 0020, Karte inzwischen weg) - dann steht
              hier NULL, und die Seite laesst es bei Kreide. */
           CASE WHEN au.id IS NULL THEN NULL ELSE ${farbeSql('au', traeger)} END AS an_autor_farbe,
           v.url AS v_url, v.titel AS v_titel, v.text AS v_text,
           v.host AS v_host, v.bild_key AS v_bild, v.fehler AS v_fehler
    FROM kommentare k
    JOIN noetig n ON n.id = k.id
    JOIN users u ON u.id = k.autor_id
    LEFT JOIN kommentare ak ON ak.id = k.an_id
    LEFT JOIN users au ON au.id = ak.autor_id
    LEFT JOIN vorschauen v ON v.id = k.vorschau_id
    WHERE k.gruppe_id = ? AND k.ziel_art = ? AND k.ziel_id = ?
    ORDER BY k.id DESC
  `).bind(gruppeId, ziel.art, ziel.id, KOMMENTARE_ZIEL, gruppeId, ziel.art, ziel.id),
  env.DB.prepare(`
    SELECT r.kommentar_id, r.art, r.autor_id, coalesce(u.name, 'Ehemaliger') AS autor
    FROM reaktionen r
    JOIN kommentare k ON k.id = r.kommentar_id
    JOIN users u ON u.id = r.autor_id
    WHERE k.gruppe_id = ? AND k.ziel_art = ? AND k.ziel_id = ?
    ORDER BY r.erstellt
  `).bind(gruppeId, ziel.art, ziel.id),
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
      /* Der Platz des Autors in der Kreidereihe - 7 heisst Regenbogen. Er
         reitet an JEDER Karte mit und nicht nur an der obersten: derselbe
         Mensch schreibt im selben Faden mehrfach, und ein Name, der einmal
         den Regenbogen traegt und drei Karten weiter nicht mehr, saehe wie
         zwei Menschen aus. */
      farbe: z.autor_farbe,
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
      an_farbe: z.an_id ? (z.an_autor_farbe ?? null) : null,
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

  /* Ein Faden steht dort, wo zuletzt etwas in ihm gesagt wurde - nicht dort,
     wo er angefangen hat. Wer auf eine alte Konversation antwortet, holt sie
     damit ans Ende, wie man es aus einem Kanal kennt. Ohne das versackt die
     Antwort weit oben, zwischen Karten von vor drei Wochen, und niemand sieht
     sie.

     Sortiert wird ueber die groesste ID im Faden, nicht ueber ein Datum: IDs
     laufen monoton, das spart das Parsen und kann nicht danebengreifen. Und es
     bumpen NUR Antworten - eine Reaktion oder eine nachtraegliche Aenderung
     ruecken den Faden nicht, die sind kein neues Wort. `sort` ist stabil, also
     behalten zwei Faden ohne Antwort ihre Reihenfolge nach Alter. */
  const zuletzt = w => w.antworten.reduce((m, a) => Math.max(m, a.id), w.id);
  wurzeln.sort((a, b) => zuletzt(a) - zuletzt(b));
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
   Liste, damit ein "4,2 · 3" ohne den Detailabruf gezeichnet werden kann.
   `gruppeId` PFLICHT (Gegenlesen-Fund): die Funktion nahm ihn nie als
   Parameter an, der Aufrufer gab ihn trotzdem mit - JavaScript verwarf das
   zweite Argument still, und die Zahl zaehlte ueber alle Gruppen eines
   mehrfach Mitgliedes hinweg zusammen (Bruch von Entscheidung 17). */
const kommentarZaehlerStmt = (env, gruppeId) => env.DB.prepare(`
  SELECT ziel_art, ziel_id, count(*) AS anzahl FROM kommentare
  WHERE gruppe_id = ? AND geloescht_am IS NULL
    AND (ziel_art = 'user'
         OR ziel_id IN (SELECT id FROM termine WHERE beginnt_am > datetime('now', ?)))
  GROUP BY ziel_art, ziel_id
`).bind(gruppeId, `-${TERMINE_RUECKBLICK} days`);

// ---------------------------------------------------------------------------
// Die Statistik der Runde
//
// Die Abfragen, die zwei Routen gemeinsam haben: `/api/statistik` fuer jeden
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
  /* Der VORLAUF gehoert nur dem Vorrat der Runde. Seine Kurve traegt den
     zuletzt gemeldeten Stand ueber meldungslose Tage fort; faenge sie am
     Fensterrand bei null an, stiege sie in der ersten Woche scheinbar an -
     eine Steigung, die es nie gab, weil dort nur der Blick fehlt. Genau
     BESTAND_VERFALL_TAGE weit zurueck und keinen Tag weiter: was aelter ist,
     gilt auch innerhalb des Fensters nicht mehr. */
  /* `von`/`bis` sind KEIN zweiter Filter - gefiltert wird weiter mit
     `fenster`. Sie sagen der Seite nur, wo die Achse anfangen und aufhoeren
     soll. Ohne sie zeichnete "Meldungen je Tag, 90 Tage" eine Achse ueber
     genau die Tage, an denen jemand gemeldet hat - bei einer Runde, deren
     Geschichte 30 Tage zurueckreicht, sehen 60 und 90 Tage dann gleich aus,
     und der Regler wirkt tot, obwohl er greift.

     GERECHNET WIRD HIER UND NICHT AUF DER SEITE, damit es EINE Uhr bleibt:
     `datetime('now', ?)` laeuft in SQLite in UTC, `Date` im Worker ebenso.
     Die Seite rechnet in Ortszeit, und ein selbst gerechneter Fensterrand
     laege dort je nach Zone einen Tag daneben - genau an der Kante, an der
     man es fuer einen Fehler in den Daten hielte. */
  const tagAb = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return {
    tage,
    fenster: `-${tage} days`,
    vorlauf: `-${tage + BESTAND_VERFALL_TAGE} days`,
    von: tagAb(tage),
    bis: tagAb(0),
  };
};

/* Derselbe Gedanke wie `statistikFenster`, aber fuer die Kassenbilder
   (Entscheidung 28): sie laufen ueber Kalendermonate, nicht ueber ein
   Tage-Fenster - ein eigener Zeitbegriff verdient einen eigenen Pruefer,
   sonst verwechselt die naechste Aenderung die beiden Regler.

   Faellt der Wunsch durch (kein `?monat=`, falsches Format, ein Monat in
   der Zukunft), gilt derselbe Grundsatz wie oben: stiller Ruecksprung auf
   den laufenden Monat in UTC, keine 400er. */
const statistikMonat = (request) => {
  const heute = new Date();
  const jahrHeute = heute.getUTCFullYear(), monatHeute = heute.getUTCMonth() + 1;
  /* Wie `von`/`bis` bei `statistikFenster`, nur fuer den Kalendermonat: der
     Erste bis zum Letzten - im LAUFENDEN Monat aber nur bis heute. Ein Bild,
     dessen Achse bis zum 31. reicht, waehrend der 16. ist, zeigt eine halbe
     leere Zukunft und liesse den Verbrauch der zweiten Monatshaelfte wie einen
     Einbruch aussehen. */
  const kanten = (jahr, m) => {
    const letzter = new Date(Date.UTC(jahr, m, 0)).getUTCDate();
    const heutigerTag = heute.getUTCDate();
    const bisTag = (jahr === jahrHeute && m === monatHeute) ? Math.min(letzter, heutigerTag) : letzter;
    const mm = String(m).padStart(2, '0');
    return { von: `${jahr}-${mm}-01`, bis: `${jahr}-${mm}-${String(bisTag).padStart(2, '0')}` };
  };
  const laufend = () => ({ monat: `${jahrHeute}-${String(monatHeute).padStart(2, '0')}`,
                           jahr: jahrHeute, monatZahl: monatHeute, ...kanten(jahrHeute, monatHeute) });
  const wunsch = new URL(request.url).searchParams.get('monat');
  const passt = wunsch && /^\d{4}-(0[1-9]|1[0-2])$/.test(wunsch);
  if (!passt) return laufend();
  const [jahr, monatZahl] = wunsch.split('-').map(Number);
  if (jahr > jahrHeute || (jahr === jahrHeute && monatZahl > monatHeute)) return laufend();
  return { monat: wunsch, jahr, monatZahl, ...kanten(jahr, monatZahl) };
};

/* `traeger` ist die Id dessen, den der Regenbogen heute trifft, oder null
   (Schema 29). BEIDE Aufrufer geben ihn weiter - die Statistik der Runde und
   die des Wirts zeigen dieselben Bilder, und ein Melder, der hier bunt und
   dort gruen waere, machte aus zwei Ansichten zwei Wahrheiten. Ein Argument
   ist es trotzdem, weil `farbeSql` es an anderer Stelle ohne braucht.

   `gruppeId` seit Etappe 2, PFLICHT. Zwei Sorten Filter, je nachdem, ob eine
   Tabelle eine `gruppe_id` fuehrt:
     - `termine`, `los`, `kommentare`, `bewertungen` haben sie (Schema 33) -
       direkter Filter auf der Tabelle selbst.
     - `reports` hat sie NICHT (Entscheidung 2b, eine Meldung gehoert der
       Person) und `users` sowieso nicht - dort filtert `JOIN gruppen_mitglied`
       nach der HEUTIGEN Mitgliedschaft (Entscheidung 24). Das heisst
       ausdruecklich: diese Bilder aendern sich rueckwirkend, wenn jemand
       kommt oder geht - der einzige Ort im System, an dem eine Vergangenheit
       nicht feststeht. `reaktionen` hat ebenfalls keine eigene `gruppe_id`
       und haengt am `kommentar_id` - gefiltert wird ueber einen Join auf
       `kommentare`.
     - Abfrage 7 (Notrufe) ist ein Grenzfall: `notrufe` selbst hat seit
       Schema 33 eine Gruppe, aber die Rangliste liest den DENORMALISIERTEN
       Zaehler `users.notrufe_insgesamt` (Migration 0017), der ueber alle
       Gruppen hinweg zaehlt - eine Aufteilung je Gruppe braeuchte eine eigene
       Spalte oder Tabelle und damit eine Migration, die diese Etappe nicht
       vorsieht. Gefiltert wird darum wie bei `reports`, ueber die heutige
       Mitgliedschaft: die Zahl selbst bleibt instanzweit gezaehlt. */
const statistikAbfragen = (env, fenster, vorlauf, gruppeId, traeger = null) => [
  // 1 — Meldungen je Tag. Flaechenkurve.
  env.DB.prepare(`
    SELECT date(r.gemeldet_am) AS tag, count(*) AS n
    FROM reports r JOIN gruppen_mitglied m ON m.user_id = r.user_id
    WHERE m.gruppe_id = ?2 AND r.gemeldet_am > datetime('now', ?1)
    GROUP BY tag ORDER BY tag
  `).bind(fenster, gruppeId),
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
           ${farbeSql('u', traeger)} AS farbe,
           j.tag, r.biere, r.temperatur, j.tief, j.hoch, j.n
    FROM reports r
    JOIN users u ON u.id = r.user_id
    JOIN gruppen_mitglied gm ON gm.user_id = r.user_id AND gm.gruppe_id = ?2
    JOIN (
      SELECT user_id, date(gemeldet_am) AS tag, max(id) AS id,
             min(temperatur) AS tief, max(temperatur) AS hoch, count(*) AS n
      FROM reports WHERE gemeldet_am > datetime('now', ?1)
      GROUP BY user_id, date(gemeldet_am)
    ) j ON j.id = r.id
    ORDER BY r.user_id, j.tag
  `).bind(fenster, gruppeId),
  // 3 — Wer war wie oft Gastgeber. Liegende Balken.
  // `ort IS NULL`: ein Abend auswaerts hat keinen Gastgeber (migrations/0024),
  // in der Spalte steht dort nur der, der ihn ausgemacht hat.
  env.DB.prepare(`
    SELECT coalesce(u.name,'Ehemaliger') AS name, ${farbeSql('u', traeger)} AS farbe,
           count(*) AS n
    FROM termine t JOIN users u ON u.id = t.gastgeber_id
    WHERE t.gruppe_id = ? AND t.abgesagt_am IS NULL AND t.ort IS NULL
    GROUP BY t.gastgeber_id ORDER BY n DESC
  `).bind(gruppeId),
  // 4 — Ausgang der Ziehungen. Gestapelter Balken.
  env.DB.prepare('SELECT status, count(*) AS n FROM los WHERE gruppe_id = ? GROUP BY status')
    .bind(gruppeId),
  // 4b — dasselbe je Melder: wer wurde wie oft gezogen, und was hat er daraus
  // gemacht. Der Balken daneben beantwortet nur den Anteil ueber alle; wer
  // dauernd zieht und dauernd absagt, faellt darin nicht auf.
  /* `farbe` reitet mit, obwohl die Balken hier nach AUSGANG gefaerbt sind und
     nicht nach Mensch: der NAME davor gehoert trotzdem einem, und wer heute
     den Regenbogen traegt, traegt ihn auf jedem Blatt. Ohne die Spalte stuende
     derselbe Mensch zwei Bilder weiter oben bunt und hier grau. */
  env.DB.prepare(`
    SELECT l.user_id, coalesce(u.name,'Ehemaliger') AS name,
           ${farbeSql('u', traeger)} AS farbe,
           l.status, count(*) AS n
    FROM los l JOIN users u ON u.id = l.user_id
    WHERE l.gruppe_id = ?
    GROUP BY l.user_id, l.status
  `).bind(gruppeId),
  /* 5 — Betrieb je Woche: Kommentare, Reaktionen, Sterne. Das Fenster steht
     in jedem der drei Zweige: eines aussen um die Vereinigung herum liesse
     SQLite erst alle drei Tabellen vollstaendig lesen. `reaktionen` traegt
     keine eigene `gruppe_id` (haengt an `kommentar_id`) - der Filter laeuft
     ueber einen Join auf `kommentare`. */
  env.DB.prepare(`
    SELECT woche, sum(k) AS kommentare, sum(r) AS reaktionen, sum(b) AS sterne FROM (
      SELECT strftime('%Y-%W', erstellt) AS woche, 1 AS k, 0 AS r, 0 AS b
      FROM kommentare WHERE gruppe_id = ?2 AND erstellt > datetime('now', ?1)
      UNION ALL
      SELECT strftime('%Y-%W', rk.erstellt), 0, 1, 0
      FROM reaktionen rk JOIN kommentare k ON k.id = rk.kommentar_id
      WHERE k.gruppe_id = ?2 AND rk.erstellt > datetime('now', ?1)
      UNION ALL
      SELECT strftime('%Y-%W', erstellt), 0, 0, 1
      FROM bewertungen WHERE gruppe_id = ?2 AND erstellt > datetime('now', ?1)
    ) GROUP BY woche ORDER BY woche
  `).bind(fenster, gruppeId),
  /* 6 — Anmeldungen je Tag, ueber die ganze Geschichte: "wie viele sind wir
     inzwischen" ist wie Gastgeber und Ziehungen oben eine Frage an die ganze
     Runde, kein Fenster. Die Seite baut daraus eine Wachstumskurve.
     `users` traegt keine `gruppe_id` - gefiltert wird ueber die heutige
     Mitgliedschaft (Entscheidung 24), wie bei den Meldungen oben. */
  env.DB.prepare(`
    SELECT date(u.erstellt) AS tag, count(*) AS n
    FROM users u JOIN gruppen_mitglied m ON m.user_id = u.id
    WHERE m.gruppe_id = ? AND u.entfernt_am IS NULL GROUP BY tag ORDER BY tag
  `).bind(gruppeId),
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
     ein "Ehemaliger" ohne erkennbaren Bezug - hier lieber ganz weg.

     Der Zaehler selbst bleibt INSTANZWEIT (siehe die Begruendung am
     Funktionskopf) - gefiltert wird nur, WER in der Liste steht. */
  env.DB.prepare(`
    SELECT u.name, ${farbeSql('u', traeger)} AS farbe, u.notrufe_insgesamt AS n
    FROM users u JOIN gruppen_mitglied m ON m.user_id = u.id
    WHERE m.gruppe_id = ? AND u.notrufe_insgesamt > 0 AND u.entfernt_am IS NULL
    ORDER BY n DESC
  `).bind(gruppeId),
  /* 8 — derselbe Betrieb, aber je MELDER statt je Woche. Das Wochenbild sagt,
     wie laut es war; dieses sagt, wer geredet hat. Bewusst dieselben drei
     Toepfe, dieselbe Zaehlweise und dieselbe UNION-Form wie in Abfrage 5 -
     zwei Bilder desselben Namens, die sich in der Summe widersprechen, waeren
     schlimmer als gar kein zweites.

     Das heisst ausdruecklich AUCH: weich geloeschte Kommentare zaehlen hier
     mit, genau wie drueben. Wer geschrieben hat, hat geschrieben.

     `coalesce(name,'Ehemaliger')` wie beim Gastgeber und ANDERS als beim
     Notruf: hier steht ein Fenster von 30 bis 90 Tagen davor, und wer in
     dieser Zeit die Haelfte geschrieben hat, darf nicht spurlos aus dem Bild
     fallen, bloss weil er inzwischen weg ist. */
  env.DB.prepare(`
    SELECT coalesce(u.name,'Ehemaliger') AS name,
           sum(k) AS kommentare, sum(r) AS reaktionen, sum(b) AS sterne
    FROM (
      SELECT autor_id, 1 AS k, 0 AS r, 0 AS b
      FROM kommentare WHERE gruppe_id = ?2 AND erstellt > datetime('now', ?1)
      UNION ALL
      SELECT rk.autor_id, 0, 1, 0
      FROM reaktionen rk JOIN kommentare k ON k.id = rk.kommentar_id
      WHERE k.gruppe_id = ?2 AND rk.erstellt > datetime('now', ?1)
      UNION ALL
      SELECT autor_id, 0, 0, 1
      FROM bewertungen WHERE gruppe_id = ?2 AND erstellt > datetime('now', ?1)
    ) x JOIN users u ON u.id = x.autor_id
    GROUP BY x.autor_id
    ORDER BY sum(k) + sum(r) + sum(b) DESC
  `).bind(fenster, gruppeId),
  /* 9 — die Abende selbst, je Monat. Die Gastgeber-Rangliste beantwortet nur,
     BEI WEM man war, nie, wie oft die Runde ueberhaupt zusammenkommt.

     Je Monat und nicht je Woche wie der Betrieb: bei einem Abend die Woche
     waeren es lauter Saeulen der Hoehe eins - eine Zeile Text mit Achsen
     drumherum. Der Monat buendelt genug, dass ein Sommerloch sichtbar wird.

     OHNE FENSTER, und das ist hier kein Versehen: bei einem Abend die Woche
     sind 30 Tage genau ein oder zwei Saeulen, und zwei Saeulen sind kein
     Verlauf. "Wie oft kommen wir zusammen" ist ausserdem dieselbe Sorte Frage
     wie "wie viele sind wir inzwischen" - und jene Kurve (Abfrage 6) folgt
     dem Schalter aus demselben Grund schon lange nicht.

     Drei Reihen aus zwei Spalten: `abgesagt_am` sticht, danach trennt `ort`
     zwischen einem Abend beim Gastgeber (NULL) und einem auswaerts. Dieselbe
     Unterscheidung wie in Abfrage 3, dort nur als Filter.

     Auch nach OBEN offen: ein Termin, der naechste Woche ansteht, steht mit
     im laufenden Monat. Das Bild heisst "Bierabende", nicht "gewesene
     Bierabende" - und ein leerer kommender Monat waere die unehrlichere
     Auskunft. Dass daraus kein Vertipper "2036" wird, der das Bild auf 120
     Saeulen aufblaeht, haelt `pruefeBeginn` schon beim Eintragen ab
     (TERMIN_VORAUS = 90 Tage). Eine zweite Grenze hier waere dieselbe Regel
     ein zweites Mal, an einer Stelle, die sie nicht durchsetzen kann. */
  env.DB.prepare(`
    SELECT strftime('%Y-%m', beginnt_am) AS monat,
           sum(abgesagt_am IS     NULL AND ort IS     NULL) AS zuhause,
           sum(abgesagt_am IS     NULL AND ort IS NOT NULL) AS auswaerts,
           sum(abgesagt_am IS NOT NULL)                     AS abgesagt
    FROM termine WHERE gruppe_id = ? GROUP BY monat ORDER BY monat
  `).bind(gruppeId),
  /* 10 — die SAAT fuer den Vorrat der Runde: je Melder der letzte Stand VOR
     dem Fenster. Ohne sie begaenne die Summenkurve bei null und stiege in der
     ersten Woche an, waehrend in Wahrheit nur nach und nach jeder einmal
     gemeldet haette (siehe `statistikFenster`).

     `max(id)` als "der letzte" - dieselbe Wahl wie in Abfrage 2, und aus
     demselben Grund: zwei Meldungen in derselben Sekunde trennt nur die id.
     Der Tag faehrt mit, weil die Seite ab ihm den Verfall zaehlt. */
  env.DB.prepare(`
    SELECT r.user_id, r.biere, date(r.gemeldet_am) AS tag
    FROM reports r
    JOIN gruppen_mitglied gm ON gm.user_id = r.user_id AND gm.gruppe_id = ?3
    JOIN (
      SELECT user_id, max(id) AS id FROM reports
      WHERE gemeldet_am <= datetime('now', ?1)
        AND gemeldet_am >  datetime('now', ?2)
      GROUP BY user_id
    ) j ON j.id = r.id
  `).bind(fenster, vorlauf, gruppeId),
];

/* Der Vorrat der Runde: eine Zahl je Tag, die Summe der zuletzt gemeldeten
   Staende ALLER Melder. Hier und nicht in SQL, weil es in SQL ein rekursives
   Kalender-CTE mit Fortschreibung waere - die Fassung im Rueckblick
   (Eiskoenig) steht da als Warnung. Die Zeilen liegen ohnehin schon vor: die
   Kurvenschar in Abfrage 2 ist dieselbe Datenmenge, nur anders gebuendelt.

   Fortgetragen wird als TREPPE, nicht als Gerade: wer am Montag 12 meldet und
   am Freitag 4, hatte am Mittwoch 12 - und nicht 8. Was in der Schar wie eine
   Gerade zwischen zwei Punkten aussieht, ist dort die Verbindung zweier
   Messungen; hier wird eine Zwischenzahl behauptet, und die einzige, die man
   verantworten kann, ist die zuletzt gemeldete.

   Faellt der letzte Stand eines Melders hinter BESTAND_VERFALL_TAGE zurueck,
   faellt er ganz heraus. Sinkt die Kurve dadurch auf null, heisst das nicht
   "nichts mehr da", sondern "seit einer Woche sagt es keiner" - fuer eine
   Runde, in der Melden der ganze Zweck ist, ist das dieselbe Auskunft. */
const vorratReihe = (tage, saat, bestandZeilen) => {
  if (!saat.length && !bestandZeilen.length) return [];

  const proTag = new Map();
  for (const z of bestandZeilen) {
    if (!proTag.has(z.tag)) proTag.set(z.tag, []);
    proTag.get(z.tag).push(z);
  }
  // Der Stand VOR dem Fenster, mit dem Tag, an dem er gemeldet wurde.
  const stand = new Map();
  for (const z of saat) stand.set(z.user_id, { biere: z.biere, tag: z.tag });

  const TAG = 86400000;
  const jetzt = Date.now();
  const reihe = [];
  let begonnen = false;
  // `tage` Schritte zurueck bis heute - dieselbe Spanne, die die Abfragen
  // sehen, und in UTC wie `date()` in SQLite.
  for (let i = tage; i >= 0; i--) {
    const tag = new Date(jetzt - i * TAG).toISOString().slice(0, 10);
    for (const z of proTag.get(tag) || []) stand.set(z.user_id, { biere: z.biere, tag });

    /* Vor der ersten Meldung ueberhaupt faengt die Kurve gar nicht erst an.
       Eine junge Runde im 90-Tage-Fenster bekaeme sonst sechzig Tage Null
       vorweg, und eine Null heisst hier "leer", waehrend es in Wahrheit
       "noch niemand da" war. Dieselbe Zurueckhaltung wie bei den Meldungen
       je Tag: die haben fuer Tage ohne Meldung schlicht keinen Punkt.

       Die Sperre gilt nur VOR dem ersten Stand, darum das eigene Merkzeichen
       und nicht `stand.size` allein: faellt spaeter der letzte Melder aus dem
       Verfall, soll die Kurve auf null SINKEN und nicht abreissen. */
    if (!begonnen && !stand.size) continue;
    begonnen = true;

    let summe = 0;
    for (const [id, s] of stand) {
      if ((Date.parse(tag) - Date.parse(s.tag)) / TAG > BESTAND_VERFALL_TAGE) stand.delete(id);
      else summe += s.biere;
    }
    reihe.push({ tag, n: summe });
  }
  return reihe;
};

/* Aus den elf Ergebnissen die Form, die gezeichnet wird. Vier davon werden
   umgebaut, der Rest geht durch. */
const statistikRunde = (ergebnis, tage) => {
  const [meldungen, bestand, gastgeber, lose, jeMelder, betrieb, anmeldungen, notrufe,
         betriebJeMelder, abende, saat] = ergebnis;

  /* Die Kurvenschar je Nutzer buendeln - eine Linie je Melder, zweimal:
     einmal die Flaschen, einmal die Grad. Dieselbe Zeile fuellt beide, denn
     beide Zahlen stehen in derselben Meldung. */
  const kurven = new Map();
  const gradKurven = new Map();
  for (const z of bestand.results) {
    if (!kurven.has(z.user_id)) {
      /* `farbe` steht EINMAL an der Kurve und wandert nicht mit den Tagen
         mit: sie gehoert dem Menschen, nicht der Meldung. */
      kurven.set(z.user_id, { name: z.name, farbe: z.farbe, tage: [], werte: [] });
      gradKurven.set(z.user_id,
        { name: z.name, farbe: z.farbe, tage: [], werte: [], tief: [], hoch: [], n: [] });
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
        name: z.name, farbe: z.farbe, gezogen: 0,
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
    betrieb_je_melder: betriebJeMelder.results,
    abende: abende.results,
    vorrat: vorratReihe(tage, saat.results, bestand.results),
    wachstum,
    notrufe: notrufe.results,
  };
};

// ---------------------------------------------------------------------------
// Die fünf Kassenbilder (Entscheidungen 26 und 32, Etappe 6)
//
// Eigene Funktion statt ein Anhang an `statistikAbfragen`: die Kassenbilder
// laufen über Kalendermonate, nicht über das `?tage=`-Fenster (Entscheidung
// 28), und sie laufen NUR, wenn `kasse_an` steht - ein bedingter Anhang
// mitten im selben Array hätte den alten, gezählten Schnitt
// (`STATISTIK_ABFRAGEN`) nur durch einen neuen ersetzt. Stattdessen haengt
// die Route (`GET /api/statistik`) diese Abfragen HINTEN an denselben
// `batch()` an - ein Rundflug bleibt es trotzdem - und liest sie über
// `runde.length` aus, nicht über eine Zahl.
// ---------------------------------------------------------------------------

/* `buchung.gruppe_id` ist eine echte Spalte (Schema 34), kein Umweg über die
   heutige Mitgliedschaft wie bei `reports` - ein Ausgetretener bleibt darum
   in "Wer hat wieviel getrunken" stehen, genau wie schon bei "Gastgeber".
   Gegenbuchungen (Entscheidung 31, `grund LIKE 'gegenbuchung:%'`) fliegen aus
   BEIDEN Trink-Bildern raus: sie sind eine Korrektur der Rechnung, kein
   Schluck. Im Kassenstand (Bild 5) zaehlen sie dagegen mit - dort ist Geld
   gemeint, nicht Konsum. */
const kasseAbfragen = (env, gruppeId, jahr, monatZahl, traeger = null) => {
  const monat = `${jahr}-${String(monatZahl).padStart(2, '0')}`;
  return [
    // 1 — Wer hat wieviel getrunken. Liegende Balken wie beim Gastgeber.
    env.DB.prepare(`
      SELECT b.user_id, coalesce(u.name,'Ehemaliger') AS name,
             ${farbeSql('u', traeger)} AS farbe, sum(b.menge) AS n
      FROM buchung b JOIN users u ON u.id = b.user_id
      WHERE b.gruppe_id = ?1 AND b.storniert_am IS NULL
        AND (b.grund IS NULL OR b.grund NOT LIKE 'gegenbuchung:%')
        AND strftime('%Y-%m', b.gebucht_am) = ?2
      GROUP BY b.user_id ORDER BY n DESC
    `).bind(gruppeId, monat),
    // 2 — Verbrauch je Tag. Flächenkurve wie "Meldungen je Tag".
    env.DB.prepare(`
      SELECT date(b.gebucht_am) AS tag, sum(b.menge) AS n
      FROM buchung b
      WHERE b.gruppe_id = ?1 AND b.storniert_am IS NULL
        AND (b.grund IS NULL OR b.grund NOT LIKE 'gegenbuchung:%')
        AND strftime('%Y-%m', b.gebucht_am) = ?2
      GROUP BY tag ORDER BY tag
    `).bind(gruppeId, monat),
    /* 3 — Bestandsverlauf, eine Linie je Getränkeart, Lieferungen als
       Sprünge. `bestand.menge` ist bereits vorzeichenbehaftet (Schema 34:
       "+ Lieferung/Storno, − Verbrauch/Schwund"), `sum(...) OVER (...)` ist
       darum die ganze Rechnung.

       DIE FENSTERFUNKTION LÄUFT ÜBER DIE UNGEFILTERTE GESCHICHTE, nicht nur
       über den gewählten Monat - sonst begänne jede Kurve am Monatsersten
       bei null, als wäre der Kühlraum leer gewesen. Dasselbe Prinzip wie der
       `vorlauf` bei "Vorrat der Runde" oben, nur als Fensterfunktion statt
       als eigene Saat-Abfrage: gerechnet wird über alles, gezeigt nur der
       Monat - der äußere `WHERE`-Filter sitzt darum außen, nicht innen.

       Der innere `j`-Join wählt je Getränk und Tag die LETZTE Zeile
       (höchste `id`) - der Tagesstand, nicht jede einzelne Buchung als
       eigener Punkt. Dieselbe Wahl wie bei "Bestand je Melder" (Abfrage 2
       der elf), aus demselben Grund. */
    env.DB.prepare(`
      SELECT r.tag, r.getraenk_id, g.name, r.stand
      FROM (
        SELECT b.id, b.getraenk_id, date(b.erstellt) AS tag,
               sum(b.menge) OVER (
                 PARTITION BY b.getraenk_id ORDER BY b.erstellt, b.id
               ) AS stand
        FROM bestand b WHERE b.gruppe_id = ?1
      ) r
      JOIN (
        SELECT getraenk_id, date(erstellt) AS tag, max(id) AS id
        FROM bestand WHERE gruppe_id = ?1 GROUP BY getraenk_id, date(erstellt)
      ) j ON j.id = r.id
      JOIN getraenk g ON g.id = r.getraenk_id
      WHERE strftime('%Y-%m', r.tag) = ?2
      ORDER BY g.name, r.tag
    `).bind(gruppeId, monat),
    /* 4 — Offene Beträge je Mitglied, nach Status gefärbt. Nur echte Reste
       (`betrag_cent - gezahlt_cent > 0`): ein längst bezahltes Mitglied hat
       hier nichts zu suchen und soll nicht als Balken der Länge null
       auftauchen. `jahr`/`monatZahl` statt der `monat`-Zeichenkette, weil
       `abrechnung.jahr`/`.monat` echte INTEGER-Spalten sind (Schema 35). */
    env.DB.prepare(`
      SELECT s.user_id, coalesce(u.name,'Ehemaliger') AS name,
             ${farbeSql('u', traeger)} AS farbe,
             s.status, (s.betrag_cent - s.gezahlt_cent) AS offen
      FROM saldo s
      JOIN abrechnung a ON a.id = s.abrechnung_id
      JOIN users u ON u.id = s.user_id
      WHERE a.gruppe_id = ?1 AND a.jahr = ?2 AND a.monat = ?3
        AND s.betrag_cent - s.gezahlt_cent > 0
      ORDER BY offen DESC
    `).bind(gruppeId, jahr, monatZahl),
    /* 5 — Kassenstand: eingenommen (Buchungen, MIT Gegenbuchungen - hier ist
       Geld gemeint, kein Schluck) und ausgegeben (Lieferungen). Der Saldo
       wird daraus gerechnet, nicht gespeichert.

       `menge * cent`, NICHT `cent` allein (Abnahmefund): `buchung.cent` ist
       der eingefrorene EINZELPREIS (Schema 34), `SALDO_SUMMEN_SQL` rechnet
       den Umsatz folgerichtig als `sum(menge * cent)`. Mit nacktem `cent`
       zaehlten drei Flaschen als eine, UND eine Gegenbuchung (negatives
       `menge`, aber positives `cent` - Entscheidung 31) erhoehte die
       Einnahme, statt sie auszugleichen - genau das Gegenteil dessen, was
       der Kommentar oben verspricht. */
    env.DB.prepare(`
      SELECT
        (SELECT coalesce(sum(menge * cent),0) FROM buchung
          WHERE gruppe_id = ?1 AND storniert_am IS NULL
            AND strftime('%Y-%m', gebucht_am) = ?2) AS eingenommen,
        (SELECT coalesce(sum(einkauf_cent),0) FROM bestand
          WHERE gruppe_id = ?1 AND art = 'lieferung'
            AND strftime('%Y-%m', erstellt) = ?2) AS ausgegeben,
        -- Strafgeld als EIGENER Posten (Entscheidung 53) - nicht in
        -- "eingenommen" verruehrt, sonst sieht eine Gruppe nicht mehr, wovon
        -- sie lebt. OHNE Schalterpruefung, und das ist Absicht: regeln_an
        -- blendet die Hausordnung aus, loescht aber nichts (Entscheidung 18).
        -- Eine Gruppe, die die Regeln nachtraeglich abschaltet, hat das Geld
        -- trotzdem eingenommen - es steht in echten Salden. Liesse man es hier
        -- weg, ginge die Kasse nicht mehr auf, und das waere ein falscher
        -- Stand, kein ausgeblendeter. Die ZEICHNUNG blendet den dritten Balken
        -- bei strafgeld === 0 aus, und genau dann ist er auch nichts wert.
        -- Dieselbe Statusliste wie SALDO_SUMMEN_SQL: 'offen' und 'abgerechnet'
        -- sind das Geld, das gilt.
        (SELECT coalesce(sum(cent),0) FROM strafe
          WHERE gruppe_id = ?1 AND art = 'geld'
            AND status IN ('offen','abgerechnet')
            AND strftime('%Y-%m', verhaengt_am) = ?2) AS strafgeld
    `).bind(gruppeId, monat),
    /* 6 — SEIT WANN es hier ueberhaupt etwas zu sehen gibt. Kein Bild, sondern
       der Boden fuer den Monatswaehler der Seite: der bot bis dahin stur die
       letzten zwoelf Monate an, auch einer Runde, die es vor drei Monaten noch
       gar nicht gab. Wer dort in den Februar sprang, bekam sechs leere Bilder
       und keine Auskunft darueber, ob nichts da ist oder etwas fehlt.

       Es ist bewusst nur ein BODEN und keine Liste der Monate mit Inhalt: ein
       leerer Monat MITTEN in der Geschichte ist eine Antwort ("da war nichts
       los") und gehoert in die Auswahl. Einer VOR dem ersten Eintrag ist keine.

       Die drei Quellen sind genau die der fuenf Bilder darueber - Buchungen,
       Lieferungen/Schwund und das Strafgeld im Kassenstand. `abrechnung` fehlt
       absichtlich: eine Abrechnung entsteht aus Buchungen, sie kann nicht
       aelter sein als die aelteste. Storniertes zaehlt NICHT (die Bilder
       zeigen es auch nicht), `min()` ueber eine leere Menge ist NULL, und
       `min()` ueber lauter NULL ist wieder NULL - eine Runde ohne jede
       Buchung bekommt also `seit: null` und behaelt genau einen Monat zur
       Wahl, den laufenden. */
    env.DB.prepare(`
      SELECT min(m) AS seit FROM (
        SELECT min(strftime('%Y-%m', gebucht_am)) AS m FROM buchung
          WHERE gruppe_id = ?1 AND storniert_am IS NULL
        UNION ALL
        SELECT min(strftime('%Y-%m', erstellt)) FROM bestand WHERE gruppe_id = ?1
        UNION ALL
        SELECT min(strftime('%Y-%m', verhaengt_am)) FROM strafe
          WHERE gruppe_id = ?1 AND art = 'geld' AND status IN ('offen','abgerechnet')
      )
    `).bind(gruppeId),
  ];
};

/* Das SECHSTE Kassenbild (Entscheidung 53) - und es haengt an `regeln_an`,
   NICHT an `kasse_an`. Genau der Fall, fuer den Etappe 6 den gezaehlten
   Schnitt durch `runde.length` ersetzt hat: die Zahl der Abfragen haengt
   jetzt an ZWEI Schaltern, eine Position von Hand waere bei der ersten
   Gruppe mit Regeln, aber ohne Kasse falsch.

   GEZAEHLT WIRD DIE ANZAHL, NICHT DER BETRAG. Eine Gruppe mit `regeln_an = 1,
   kasse_an = 0` hat nur Auflagen, und die tragen ueberhaupt keinen Cent - ein
   Geldbild waere dort strukturell leer. Der Betrag reist als zweite Zahl mit
   und steht in der Beschriftung.

   DIE STATUSLISTE IST EINE EIGENE, und zwar mit Absicht (Abnahmefund Etappe 9:
   hier stand einmal nur `<> 'erlassen'`, und damit trug jeder Vorschlag - auch
   jeder abgelehnte - einen Balken gegen den Betroffenen). Sie ist um EINEN
   Wert strenger als `STRAFEN_MONAT_SQL`: 'vorgeschlagen' faellt zusaetzlich
   heraus. Grund ist die Bauart des Bildes - ein Balken ist eine Summe und kann
   keinen Status nennen; in der LISTE steht neben dem Vorschlag das Wort
   "vorgeschlagen", im Balken waere er von einer verhaengten Strafe nicht mehr
   zu unterscheiden. 'bestritten' bleibt dagegen DRIN, wie in der Liste: die
   Strafe wurde verhaengt, der Einspruch laeuft erst, und 'halten' setzt sie
   ohne Umweg auf 'offen' zurueck. Die Geldliste (`SALDO_SUMMEN_SQL`) ist hier
   die falsche Schablone - gezaehlt wird, was gilt, nicht was kostet. */
const regelnAbfragen = (env, gruppeId, jahr, monatZahl, traeger = null) => {
  const monat = `${jahr}-${String(monatZahl).padStart(2, '0')}`;
  return [
    env.DB.prepare(`
      SELECT s.user_id, coalesce(u.name,'Ehemaliger') AS name,
             ${farbeSql('u', traeger)} AS farbe,
             count(*) AS n,
             coalesce(sum(CASE WHEN s.art = 'geld' THEN s.cent ELSE 0 END),0) AS cent
      FROM strafe s JOIN users u ON u.id = s.user_id
      WHERE s.gruppe_id = ?1
        AND s.status NOT IN ('erlassen','verworfen','vorgeschlagen')
        AND strftime('%Y-%m', s.verhaengt_am) = ?2
      GROUP BY s.user_id ORDER BY n DESC, cent DESC
    `).bind(gruppeId, monat),
    // Was gerade noch aussteht - monatsunabhaengig, wie die zweite Liste in
    // `GET /api/hausordnung`: eine Auflage laeuft ueber den Monatswechsel
    // hinweg weiter, kein Abschluss holt sie ab.
    env.DB.prepare(`
      SELECT count(*) AS n FROM strafe
       WHERE gruppe_id = ? AND status IN ('offen','gemeldet') AND art = 'tat'
    `).bind(gruppeId),
    /* Der Boden fuer den Monatswaehler, wie bei den Kassenbildern - dieselbe
       Statusliste wie im Bild darueber, damit der aelteste waehlbare Monat
       auch wirklich einen Balken traegt. Eine Gruppe mit Regeln, aber ohne
       Kasse hat sonst gar keinen Boden: die Seite nimmt den frueheren der
       beiden, und einer von beiden kann fehlen. */
    env.DB.prepare(`
      SELECT min(strftime('%Y-%m', verhaengt_am)) AS seit FROM strafe
       WHERE gruppe_id = ?
         AND status NOT IN ('erlassen','verworfen','vorgeschlagen')
    `).bind(gruppeId),
  ];
};

/* Die achtzehn Abfragen des Jahresrueckblicks - Privatseite (Etappe 11).
   Ausgelagert aus `GET /api/wrapped` nach dem Muster von `statistikAbfragen`
   und `kasseAbfragen`, und aus demselben Grund: sie laufen NUR, wenn die
   Gruppe eine Privatseite fuehrt (`privatSeite`). Eine Gruppe, die bloss Kasse
   und Hausordnung hat, hat keinen Eiskoenig, kein Rad und keinen Abend des
   Jahres - achtzehn Abfragen, die garantiert leer zurueckkommen, sind kein
   Rundflug, sondern Ballast.

   AUSGELESEN WIRD UEBER `.length` DES BLOCKS, nie ueber eine getippte Position.
   Das ist der Fehler, den Etappe 6 an der Statistik schon einmal repariert hat:
   sobald die Zahl der Abfragen an einem SCHALTER haengt, ist jede Zahl im Code
   bei der ersten Gruppe mit anderer Schalterstellung falsch. */
/* Die Vereinsseite des Rueckblicks (Etappe 11) - Kasse und Hausordnung ueber
   ein ganzes Jahr. Alle Quellen tragen eine echte `gruppe_id` (Schema 34/35/38),
   also ueberall der direkte Filter; die Mitgliedschaft spielt hier keine Rolle,
   und das ist Absicht: ein Ausgetretener bleibt in "Der Durstigste" stehen,
   genau wie schon im Kassenbild der Statistik.

   DREI BLOECKE, NICHT EINER, jeder an seinem Schalter:
     `wrappedVereinSeitAbfragen`  - laeuft bei `vereinSeite`, eine Abfrage
     `wrappedKasseJahrAbfragen`   - laeuft bei `kasse_an`,  sieben Abfragen
     `wrappedRegelnJahrAbfragen`  - laeuft bei `regeln_an`, drei Abfragen
   Ein gemeinsamer Block haette bei `kasse_an = 0, regeln_an = 1` fuenf
   Kassenabfragen mitgeschleppt, die garantiert leer sind. Ausgelesen wird
   jeder Block ueber sein eigenes `.length`.

   Die Statuslisten sind WOERTLICH die der Monatsbilder uebernommen, nicht neu
   erfunden - `kasseAbfragen` fuer das Geld, `regelnAbfragen` fuer die Strafen.
   Die beiden sind verschieden, und der Unterschied ist begruendet (siehe dort). */

const wrappedVereinSeitAbfragen = (env, { gruppeId }) => [
  /* SEIT WANN diese Gruppe rechnet. Kasse und Hausordnung sind erst im August
     2026 ausgerollt worden - der erste Vereins-Rueckblick zeigt ein Jahr, das
     ein halbes ist. Ohne diese Zahl behauptet der Hero eine Jahressumme, die
     eine Halbjahressumme ist. `min()` ueber BEIDE Quellen: eine Gruppe mit
     Hausordnung, aber ohne Kasse hat sonst gar keinen Boden. */
  env.DB.prepare(`
    SELECT min(am) AS seit FROM (
      SELECT min(gebucht_am)   AS am FROM buchung WHERE gruppe_id = ?1
      UNION ALL
      SELECT min(verhaengt_am) AS am FROM strafe  WHERE gruppe_id = ?1
    )
  `).bind(gruppeId),
];

const wrappedKasseJahrAbfragen = (env, {
  gruppeId, traeger, jahr, jahrStartVoll, jahrEndeExkl, ichId,
}) => [
  /* 1 - was durchgegangen ist, je Monat. Gegenbuchungen fliegen raus
     (`grund NOT LIKE 'gegenbuchung:%'`, Entscheidung 31) - sie sind eine
     Korrektur der Rechnung, kein Schluck. Woertlich wie `kasseAbfragen` 1/2. */
  env.DB.prepare(`
    SELECT CAST(strftime('%m', b.gebucht_am) AS INTEGER) AS monat, sum(b.menge) AS n
    FROM buchung b
    WHERE b.gruppe_id = ?1 AND b.storniert_am IS NULL
      AND (b.grund IS NULL OR b.grund NOT LIKE 'gegenbuchung:%')
      AND b.gebucht_am >= ?2 AND b.gebucht_am < ?3
    GROUP BY monat ORDER BY monat
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  // 2 - der Durstigste: je Mensch, mit Melderfarbe fuer die Balken.
  env.DB.prepare(`
    SELECT b.user_id, coalesce(u.name,'Ehemaliger') AS name,
           ${farbeSql('u', traeger)} AS farbe, sum(b.menge) AS n
    FROM buchung b JOIN users u ON u.id = b.user_id
    WHERE b.gruppe_id = ?1 AND b.storniert_am IS NULL
      AND (b.grund IS NULL OR b.grund NOT LIKE 'gegenbuchung:%')
      AND b.gebucht_am >= ?2 AND b.gebucht_am < ?3
    GROUP BY b.user_id ORDER BY n DESC, b.user_id
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  /* 3 - das Getraenk des Jahres. `getraenk.name` und nicht die Id: eine
     abgeschaltete Sorte bleibt fuer immer stehen (Schema 34), und im Rueckblick
     soll sie ihren Namen behalten. */
  env.DB.prepare(`
    SELECT g.name, sum(b.menge) AS n
    FROM buchung b JOIN getraenk g ON g.id = b.getraenk_id
    WHERE b.gruppe_id = ?1 AND b.storniert_am IS NULL
      AND (b.grund IS NULL OR b.grund NOT LIKE 'gegenbuchung:%')
      AND b.gebucht_am >= ?2 AND b.gebucht_am < ?3
    GROUP BY b.getraenk_id ORDER BY n DESC, g.name
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  /* 4 - was die Kasse bewegt hat. `menge * cent`, NIE `cent` allein:
     `buchung.cent` ist der eingefrorene EINZELPREIS (Schema 34). Mit nacktem
     `cent` zaehlten drei Flaschen als eine, UND eine Gegenbuchung (negatives
     `menge`, positives `cent`) ERHOEHTE die Einnahme statt sie auszugleichen.
     Das war der vierte Blocker der Etappe-6-Abnahme und ist hier dieselbe
     Falle. Hier zaehlen Gegenbuchungen MIT - es ist Geld gemeint, kein Konsum.
     Die Strafgeld-Statusliste ist die von `SALDO_SUMMEN_SQL`, wie im
     Monatsbild: 'offen' und 'abgerechnet' sind das Geld, das gilt. */
  env.DB.prepare(`
    SELECT
      (SELECT coalesce(sum(menge * cent),0) FROM buchung
        WHERE gruppe_id = ?1 AND storniert_am IS NULL
          AND gebucht_am >= ?2 AND gebucht_am < ?3) AS eingenommen,
      (SELECT coalesce(sum(einkauf_cent),0) FROM bestand
        WHERE gruppe_id = ?1 AND art = 'lieferung'
          AND erstellt >= ?2 AND erstellt < ?3) AS ausgegeben,
      (SELECT coalesce(sum(cent),0) FROM strafe
        WHERE gruppe_id = ?1 AND art = 'geld'
          AND status IN ('offen','abgerechnet')
          AND verhaengt_am >= ?2 AND verhaengt_am < ?3) AS strafgeld
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  // 5 - Nachschub: wie oft geschleppt, wie viel, die groesste Fuhre, der Wert.
  env.DB.prepare(`
    SELECT count(*) AS lieferungen, coalesce(sum(menge),0) AS flaschen,
           coalesce(max(menge),0) AS groesste, coalesce(sum(einkauf_cent),0) AS wert
    FROM bestand
    WHERE gruppe_id = ?1 AND art = 'lieferung'
      AND erstellt >= ?2 AND erstellt < ?3
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  // 6 - Ich: meine Flaschen und mein Anteil in Geld. Derselbe Ausschluss der
  // Gegenbuchungen fuer die MENGE, derselbe Einschluss fuer das GELD - darum
  // zwei Summen in einer Zeile statt zweier Abfragen.
  env.DB.prepare(`
    SELECT
      (SELECT coalesce(sum(menge),0) FROM buchung
        WHERE gruppe_id = ?1 AND user_id = ?4 AND storniert_am IS NULL
          AND (grund IS NULL OR grund NOT LIKE 'gegenbuchung:%')
          AND gebucht_am >= ?2 AND gebucht_am < ?3) AS flaschen,
      (SELECT coalesce(sum(menge * cent),0) FROM buchung
        WHERE gruppe_id = ?1 AND user_id = ?4 AND storniert_am IS NULL
          AND gebucht_am >= ?2 AND gebucht_am < ?3) AS gezahlt
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl, ichId),

  /* 7 - Ich: die Zahlmoral. DER NENNER IST DER PUNKT. `avg(...)` allein liesse
     die Zeilen ohne `bestaetigt_am` (offen, gemeldet, abgelehnt) stillschweigend
     fallen - wer nie gezahlt hat, bekaeme einen schmeichelhaften Schnitt ueber
     nichts. Deshalb drei Zahlen: `monate` ist der ehrliche Nenner, `bezahlt`
     der Zaehler, und `tage` gilt AUSDRUECKLICH nur fuer die `gerechnet`
     bestaetigten. Die Kachel schreibt "x von y Monaten" als fuehrende Zahl und
     den Schnitt nur daneben, wenn `gerechnet > 0`. */
  env.DB.prepare(`
    SELECT count(*) AS monate,
           coalesce(sum(s.status = 'bezahlt'),0) AS bezahlt,
           count(s.bestaetigt_am) AS gerechnet,
           avg(julianday(s.bestaetigt_am) - julianday(s.gemeldet_am)) AS tage
    FROM saldo s JOIN abrechnung a ON a.id = s.abrechnung_id
    WHERE a.gruppe_id = ?1 AND a.jahr = ?2 AND s.user_id = ?3
  `).bind(gruppeId, jahr, ichId),
];

const wrappedRegelnJahrAbfragen = (env, {
  gruppeId, traeger, jahrStartVoll, jahrEndeExkl, ichId,
}) => [
  /* 1 - die Hausordnung: Strafen je Regeltitel. `s.titel` und nicht
     `hausregel.titel`: der Titel ist in `strafe` EINGEFROREN (Schema 38,
     dieselbe Bauweise wie `buchung.cent`), und eine spaeter umbenannte Regel
     soll den Rueckblick nicht rueckwirkend umschreiben.

     DIE STATUSLISTE IST DIE VON `regelnAbfragen`, nicht die von
     `SALDO_SUMMEN_SQL`: 'vorgeschlagen' und 'verworfen' fallen heraus (ein
     Balken ist eine Summe und kann keinen Status nennen - ein Vorschlag waere
     von einer verhaengten Strafe nicht zu unterscheiden), 'bestritten' bleibt
     drin (die Strafe ist verhaengt, der Einspruch laeuft erst).

     `sum(cent)`, NICHT `sum(menge*cent)` - eine Strafe hat keine Menge (0038),
     der genaue Gegensatz zur `buchung` eine Funktion weiter oben. */
  env.DB.prepare(`
    SELECT s.titel AS name, count(*) AS n,
           coalesce(sum(CASE WHEN s.art = 'geld' THEN s.cent ELSE 0 END),0) AS cent
    FROM strafe s
    WHERE s.gruppe_id = ?1
      AND s.status NOT IN ('erlassen','verworfen','vorgeschlagen')
      AND s.verhaengt_am >= ?2 AND s.verhaengt_am < ?3
    GROUP BY s.titel ORDER BY n DESC, s.titel
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  // 2 - wer am haeufigsten dran war.
  env.DB.prepare(`
    SELECT s.user_id, coalesce(u.name,'Ehemaliger') AS name,
           ${farbeSql('u', traeger)} AS farbe, count(*) AS n,
           coalesce(sum(CASE WHEN s.art = 'geld' THEN s.cent ELSE 0 END),0) AS cent
    FROM strafe s JOIN users u ON u.id = s.user_id
    WHERE s.gruppe_id = ?1
      AND s.status NOT IN ('erlassen','verworfen','vorgeschlagen')
      AND s.verhaengt_am >= ?2 AND s.verhaengt_am < ?3
    GROUP BY s.user_id ORDER BY n DESC, s.user_id
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl),

  // 3 - Ich: meine Strafen, Anzahl und davon in Geld.
  env.DB.prepare(`
    SELECT count(*) AS n,
           coalesce(sum(CASE WHEN art = 'geld' THEN cent ELSE 0 END),0) AS cent
    FROM strafe
    WHERE gruppe_id = ?1 AND user_id = ?4
      AND status NOT IN ('erlassen','verworfen','vorgeschlagen')
      AND verhaengt_am >= ?2 AND verhaengt_am < ?3
  `).bind(gruppeId, jahrStartVoll, jahrEndeExkl, ichId),
];

/* Die Namens- und Farbkarte. Ein EIGENER Block, der immer laeuft - sie war
   Abfrage 0 der Privatseite, und dort ist sie ab Etappe 11 falsch aufgehoben:
   auch die Vereinsbalken ("Der Durstigste", "Wer am haeufigsten dran war")
   brauchen Namen und Melderfarben, und eine Gruppe ohne Privatseite haette sie
   sonst nicht.

   BLEIBT ABSICHTLICH WEIT ueber alle `users`: diese Zeilen werden nie
   ausgegeben, sondern nur nachgeschlagen. Wer ausgetreten ist, taucht ueber
   `buchung`, `strafe` oder `termine` trotzdem in einem Balken auf und braucht
   dort seinen Namen. Geschnitten werden die AGGREGATE, nicht das Woerterbuch -
   und keine einzige Kennzahl liest von hier.

   Die Melderfarbe kommt seit Schema 28 von hier und wird nicht mehr auf der
   Seite aus der Reihenfolge gezaehlt: sonst haette derselbe Mensch im
   Rueckblick eine andere Kreide als am Rad und in der Statistik. */
const wrappedNamenAbfragen = (env, { traeger }) => [
  env.DB.prepare(`SELECT u.id, coalesce(u.name,'Ehemaliger') AS name,
                         ${farbeSql('u', traeger)} AS farbe
                  FROM users u ORDER BY u.id`),
];

const wrappedPrivatAbfragen = (env, {
  gruppeId, traeger, jahrStart, letzterTag, jahrStartVoll, jahrEndeExkl, jahrPrefix,
  ichId, meinFenster,
}) => [
  /* 1 - Eiskoenig: Tage auf Platz 1, Tagesende-Stand mit Carry-Forward.
     `roh` schneidet die Historie auf das Jahr plus GENAU EINE Carry-in-
     Zeile je Melder (statt der ganzen Vergangenheit) - das war der
     Hebel, der die Laufzeit bei der Pruefung von 1,26s auf 0,03s brachte.
     `tages` haelt je Melder und Kalendertag nur die letzte Meldung,
     `intervall` spannt daraus Gueltigkeitsfenster, `stand` verbindet sie
     mit dem Tageskalender - mit Verfallsfrist, sonst gewinnt eine
     einzelne fruehe Meldung den Rest des Jahres. `rang` laesst Tage ohne
     jede kalte Flasche (biere = 0) ohne Sieger.

     DER GRUPPENSCHNITT SITZT ALS `EXISTS` IM `WHERE` VON `roh`, nicht als
     JOIN in seinem FROM - und das ist kein Stilfrage. Die 1,26 s -> 0,03 s
     dieser Abfrage kamen ALLEIN daraus, die Historie auf das Jahr plus
     GENAU EINE Carry-in-Zeile je Melder zu schneiden (der korrelierte
     `max()`-Subquery unten, ueber `reports_user_zeit`). Ein
     `JOIN gruppen_mitglied` im FROM haette SQLite eine andere
     Zugriffsreihenfolge angeboten und diesen Indextreffer kosten koennen.
     Nachgemessen, nicht angenommen (siehe ideas/PROJECT-MEMORY.md).

     Die Klausel `r.gemeldet_am >= m.beigetreten` ist Entscheidung W1: ohne
     sie schleppt ein Dezember-Beitritt eif fremde Monate in den Rueckblick
     einer Gruppe, in der er zehn Monate nicht war. Sie greift auch auf die
     Carry-in-Zeile - wer im Maerz beitrat, hat keine aus dem Vorjahr, und
     das ist richtig. Der AUSGETRETENE verschwindet weiterhin rueckwirkend:
     das ist 0032s ausdrueckliches "die Runde, wie sie heute ist" und bleibt
     so. Dass `buchung`, `strafe` und `termine` daneben eine echte
     `gruppe_id` fuehren und ihn deshalb BEHALTEN, ist ein Unterschied, der
     hierher in den Kommentar gehoert und nicht in eine Vereinheitlichung. */
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
        AND EXISTS (
          SELECT 1 FROM gruppen_mitglied m
           WHERE m.user_id = r.user_id AND m.gruppe_id = ?4
             AND r.gemeldet_am >= m.beigetreten)
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
  `).bind(jahrStart, letzterTag, WRAPPED_VERFALL_TAGE, gruppeId),

  /* 2 - wie oft im Jahr gemeldet wurde, je Monat. Kein geschaetzter
     Verbrauch (LAG-Differenzen unterschaetzen bei Trinken-und-Nachlegen
     zwischen zwei Meldungen systematisch) - eine ehrliche Zahl statt
     einer geschoenten, mit dem Nutzer so abgestimmt.

     `reports` traegt keine Gruppe und soll keine tragen (0033: "die MELDUNG
     GEHOERT DER PERSON") - der Schnitt laeuft ueber die Mitgliedschaft, wie
     in `statistikAbfragen`, plus die W1-Klausel. */
  env.DB.prepare(`
    SELECT CAST(strftime('%m', r.gemeldet_am) AS INTEGER) AS monat, count(*) AS n
    FROM reports r
    JOIN gruppen_mitglied m ON m.user_id = r.user_id AND m.gruppe_id = ?3
                           AND r.gemeldet_am >= m.beigetreten
    WHERE r.gemeldet_am >= ?1 AND r.gemeldet_am < ?2
    GROUP BY monat ORDER BY monat
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  /* 3 - der kaelteste Moment. Die Grenze ist dieselbe wie in
     POST /api/report (MIN_GRAD/MAX_GRAD) - dort haelt sie jeden neuen
     Wert schon ein, hier faengt sie nur Ausreisser aus Altbestand oder
     einem Handgriff direkt in D1 ab (siehe ideas/PROJECT-MEMORY.md). */
  env.DB.prepare(`
    SELECT r.temperatur AS grad, r.user_id, coalesce(u.name,'Ehemaliger') AS name,
           u.quelle, r.gemeldet_am AS am
    FROM reports r JOIN users u ON u.id = r.user_id
    JOIN gruppen_mitglied m ON m.user_id = r.user_id AND m.gruppe_id = ?5
                          AND r.gemeldet_am >= m.beigetreten
    WHERE r.gemeldet_am >= ?1 AND r.gemeldet_am < ?2
      AND r.temperatur BETWEEN ?3 AND ?4
    ORDER BY r.temperatur ASC LIMIT 1
  `).bind(jahrStartVoll, jahrEndeExkl, MIN_GRAD, MAX_GRAD, gruppeId),

  // 4 - der waermste Moment, spiegelbildlich.
  env.DB.prepare(`
    SELECT r.temperatur AS grad, r.user_id, coalesce(u.name,'Ehemaliger') AS name,
           u.quelle, r.gemeldet_am AS am
    FROM reports r JOIN users u ON u.id = r.user_id
    JOIN gruppen_mitglied m ON m.user_id = r.user_id AND m.gruppe_id = ?5
                          AND r.gemeldet_am >= m.beigetreten
    WHERE r.gemeldet_am >= ?1 AND r.gemeldet_am < ?2
      AND r.temperatur BETWEEN ?3 AND ?4
    ORDER BY r.temperatur DESC LIMIT 1
  `).bind(jahrStartVoll, jahrEndeExkl, MIN_GRAD, MAX_GRAD, gruppeId),

  // 5 - das Rad: Ausgang der Ziehungen des Jahres. `los` traegt seit
  // Schema 33 eine echte `gruppe_id`, und der Index `los_tag` fuehrt sie
  // als erste Spalte - der Filter ist hier auch der billigste Weg.
  env.DB.prepare(`
    SELECT status, count(*) AS n FROM los
    WHERE gruppe_id = ?2 AND tag LIKE ?1 GROUP BY status
  `).bind(jahrPrefix, gruppeId),

  // 6 - gewonnene (zugesagte) Lose je Melder.
  env.DB.prepare(`
    SELECT user_id, count(*) AS n FROM los
    WHERE gruppe_id = ?2 AND tag LIKE ?1 AND status = 'zugesagt'
    GROUP BY user_id ORDER BY n DESC
  `).bind(jahrPrefix, gruppeId),

  // 7 - Bewertungen der Termine des Jahres, ueber den JOIN statt einer
  // ID-Liste - so bleibt alles in diesem einen batch.
  /* Alle Ereignistabellen ab hier tragen ihre `gruppe_id` selbst (Schema
     33/34/38) - ein `AND x.gruppe_id = ?` genuegt. Wo zwei Tabellen im
     Spiel sind, wird BEIDES gefiltert: der Join allein liesse sonst eine
     Bewertung aus Gruppe B an einem Termin aus Gruppe A durch, falls die
     beiden Spalten je auseinanderlaufen. Zwei billige Praedikate gegen
     einen stillen Riss. */
  env.DB.prepare(`
    SELECT b.ziel_art, b.ziel_id, b.sterne
    FROM bewertungen b JOIN termine t ON t.id = b.ziel_id AND b.ziel_art = 'termin'
    WHERE b.gruppe_id = ?3 AND t.gruppe_id = ?3
      AND t.beginnt_am >= ?1 AND t.beginnt_am < ?2 AND t.abgesagt_am IS NULL
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  // 8 - Kommentar- und Fotozahl je Termin des Jahres. Die Zahl der Bilder
  // kommt aus `kommentare.bild_key`, nicht aus `bild_uploads` - ein Filter
  // genuegt also, ohne zweite Tabelle.
  env.DB.prepare(`
    SELECT k.ziel_id, count(*) AS kommentare, sum(k.bild_key IS NOT NULL) AS fotos
    FROM kommentare k JOIN termine t ON t.id = k.ziel_id AND k.ziel_art = 'termin'
    WHERE k.gruppe_id = ?3 AND t.gruppe_id = ?3 AND k.geloescht_am IS NULL
      AND t.beginnt_am >= ?1 AND t.beginnt_am < ?2 AND t.abgesagt_am IS NULL
    GROUP BY k.ziel_id
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  // 9 - die Termine des Jahres selbst: wann, bei wem. Ein Abend auswaerts
  // steht mit drin - er kann Abend des Jahres werden wie jeder andere,
  // er heisst dann nur nach seinem Ort statt nach einem Gastgeber.
  env.DB.prepare(`
    SELECT t.id, t.beginnt_am, t.gastgeber_id, t.ort,
           coalesce(u.name,'Ehemaliger') AS gastgeber_name
    FROM termine t JOIN users u ON u.id = t.gastgeber_id
    WHERE t.gruppe_id = ?3
      AND t.beginnt_am >= ?1 AND t.beginnt_am < ?2 AND t.abgesagt_am IS NULL
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  // 10 - Bewertungen fuer "Gastgeber des Jahres": die Dauer-Bewertung,
  // aber nur die Stimmen DIESES Jahres.
  env.DB.prepare(`
    SELECT ziel_id, sterne FROM bewertungen
    WHERE gruppe_id = ?3 AND ziel_art = 'user'
      AND erstellt >= ?1 AND erstellt < ?2
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  // 11 - wie viele Abende je Gastgeber im Jahr stattfanden. Ohne die
  // auswaerts: sie zaehlen fuer niemanden (migrations/0024).
  env.DB.prepare(`
    SELECT gastgeber_id, count(*) AS abende FROM termine
    WHERE gruppe_id = ?3
      AND beginnt_am >= ?1 AND beginnt_am < ?2 AND abgesagt_am IS NULL
      AND ort IS NULL
    GROUP BY gastgeber_id
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  // 12 - wie viele Kommentare insgesamt.
  env.DB.prepare(`
    SELECT count(*) AS n FROM kommentare
    WHERE gruppe_id = ?3 AND geloescht_am IS NULL
      AND erstellt >= ?1 AND erstellt < ?2
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  /* 13 - die Reaktion des Jahres. `art` als zweiter Sortierschluessel
     macht einen Gleichstand deterministisch statt zufaellig.

     `reaktionen` traegt BEWUSST keine eigene `gruppe_id` (0033: sie haengt
     als Kindtabelle am `kommentar_id`, das die Gruppe schon fuehrt, und
     eine zweite Auskunft kann falsch werden) - der Schnitt laeuft darum
     ueber den Join auf `kommentare`, genau wie in `statistikAbfragen`. */
  env.DB.prepare(`
    SELECT x.art, count(*) AS n FROM reaktionen x
    JOIN kommentare k ON k.id = x.kommentar_id AND k.gruppe_id = ?3
    WHERE x.erstellt >= ?1 AND x.erstellt < ?2
    GROUP BY x.art ORDER BY n DESC, x.art LIMIT 1
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  /* 14 - Bilder und GIFs, aus den tatsaechlich abgeschickten Kommentaren
     (nicht `bild_uploads`, die zaehlt auch Verwaistes mit). Fotos und
     Memes sind serverseitig nicht zu unterscheiden - beide laufen als
     image/jpeg ueber /api/bild, siehe ideas/gifs-und-memes.md. Deshalb
     zwei Kacheln statt der im Plan skizzierten drei: Bilder und GIFs. */
  env.DB.prepare(`
    SELECT sum(bild_key LIKE '%.gif') AS gifs,
           sum(bild_key NOT LIKE '%.gif') AS bilder
    FROM kommentare
    WHERE gruppe_id = ?3 AND geloescht_am IS NULL AND bild_key IS NOT NULL
      AND erstellt >= ?1 AND erstellt < ?2
  `).bind(jahrStartVoll, jahrEndeExkl, gruppeId),

  /* 15 - Ich: die Kalt-Serie. Dieselbe Tagesserie wie Eiskoenig, aber auf
     den Abrufenden zugeschnitten - die Historie ist schon in `roh` auf
     diesen einen Nutzer gefiltert statt erst danach, das haelt die
     Pipeline auf einem Bruchteil der Zeilen (Empfehlung aus der
     Pruefung).

     DIE W1-GRENZE GILT AUCH HIER, und das steht so in keinem Plan. Der
     Gedanke war: 15/16/17 sind schon auf den Abrufenden gefiltert, eine
     Mitgliedschaftspruefung im Vorfeld genuegt. Sie genuegt NICHT. Weil
     `reports` keine Gruppe traegt, waeren die eigene Kalt-Serie und das
     eigene kaelteste Bier in JEDER Gruppe, in der man ist, dieselbe Zahl -
     waehrend `platz1` direkt daneben aus Abfrage 1 kommt und dort sehr wohl
     bei `beigetreten` anfaengt. Auf einer Kachel stuenden dann zwei Zahlen,
     die ueber verschiedene Zeitraeume gerechnet sind: eine Serie aus
     Monaten, in denen man noch nicht dabei war, neben einer Platz-1-Zahl,
     die genau diese Monate auslaesst. `?6` ist darum mein Beitritt. */
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
        AND r.gemeldet_am >= ?6
        AND r.gemeldet_am < datetime(?2,'+1 day')
        AND r.gemeldet_am >= coalesce(
          (SELECT max(v.gemeldet_am) FROM reports v
            WHERE v.user_id = ?3 AND v.gemeldet_am < ?1
              AND v.gemeldet_am >= ?6), '')
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
  `).bind(jahrStart, letzterTag, ichId, WRAPPED_VERFALL_TAGE, WRAPPED_KALT_GRAD,
          meinFenster),

  // 16 - Ich: das eigene kaelteste Bier des Jahres. Dieselbe W1-Grenze wie
  // 15, aus demselben Grund.
  env.DB.prepare(`
    SELECT min(temperatur) AS grad FROM reports
    WHERE user_id = ?1 AND gemeldet_am >= ?2 AND gemeldet_am < ?3
      AND gemeldet_am >= ?4
  `).bind(ichId, jahrStartVoll, jahrEndeExkl, meinFenster),

  /* 17 - Ich: die Sterne, die ich in diesem Jahr vergeben habe. Hier keine
     W1-Klausel, sondern der direkte Filter: `bewertungen` traegt seit 0033
     eine echte `gruppe_id`, und sie sagt, in WELCHER Gruppe die Stimme
     abgegeben wurde. Das ist die genauere Auskunft - eine Sternvergabe ist
     ein Ereignis, keine Eigenschaft eines Menschen. */
  env.DB.prepare(`
    SELECT sterne FROM bewertungen
    WHERE autor_id = ?1 AND gruppe_id = ?4
      AND erstellt >= ?2 AND erstellt < ?3
  `).bind(ichId, jahrStartVoll, jahrEndeExkl, gruppeId),
];

const statistikRegeln = (ergebnis, monat) => {
  const [jeMensch, offen, seit] = ergebnis;
  return {
    monat,
    seit: (seit.results[0] || {}).seit || null,
    strafen_je_mensch: jeMensch.results,
    auflagen_offen: (offen.results[0] || { n: 0 }).n,
  };
};

/* Aus den fünf Ergebnissen die Form, die gezeichnet wird - derselbe Zweck
   wie `statistikRunde`, nur für den Kassen-Anhang. */
const statistikKasse = (ergebnis, monat, von, bis) => {
  const [getrunken, verbrauchJeTag, bestandsverlauf, offeneBetraege, stand, seit] = ergebnis;

  const kurven = new Map();
  for (const z of bestandsverlauf.results) {
    if (!kurven.has(z.getraenk_id)) {
      kurven.set(z.getraenk_id, { name: z.name, farbe: null, tage: [], werte: [] });
    }
    const k = kurven.get(z.getraenk_id);
    k.tage.push(z.tag);
    k.werte.push(z.stand);
  }

  const kassenstand = stand.results[0] || { eingenommen: 0, ausgegeben: 0, strafgeld: 0 };

  return {
    monat,
    // Die Kanten der Achse fuer "Verbrauch je Tag" - der Erste des Monats bis
    // zum Letzten, im laufenden Monat nur bis heute (siehe `statistikMonat`).
    von, bis,
    // Ab wann der Monatswaehler ueberhaupt etwas anzubieten hat, siehe
    // Abfrage 6. `null` heisst: diese Runde hat noch nie etwas gebucht.
    seit: (seit.results[0] || {}).seit || null,
    getrunken: getrunken.results,
    verbrauch_je_tag: verbrauchJeTag.results,
    bestandsverlauf: [...kurven.values()],
    offene_betraege: offeneBetraege.results,
    kassenstand: {
      eingenommen: kassenstand.eingenommen,
      // Eigener Posten seit Etappe 8 (Entscheidung 53), und er zaehlt in den
      // Saldo hinein - er ist echtes Geld, nur aus einer anderen Quelle.
      strafgeld: kassenstand.strafgeld || 0,
      ausgegeben: kassenstand.ausgegeben,
      saldo: kassenstand.eingenommen + (kassenstand.strafgeld || 0) - kassenstand.ausgegeben,
    },
  };
};

// ---------------------------------------------------------------------------
// Das Versandprotokoll
// ---------------------------------------------------------------------------

/* Eine Zeile ins Versandprotokoll (migrations/0025): wie viele, wozu, wann -
   und ausdruecklich nicht, an wen.

   WIRFT NIE. Das ist die ganze Vorsicht, die hier noetig ist: ein Protokoll,
   das den Versand scheitern laesst, waere schlimmer als eine fehlende Zeile.
   Der `.catch` steht deshalb hier drin und nicht bei den sieben Aufrufern -
   sonst haengt es am Gedaechtnis des naechsten, der eine achte Meldung baut.

   Kein `waitUntil`: die Aufrufer stehen alle schon in einem (`stosse`,
   `benachrichtige`, `warneAlteAdresse`, `meldeNeuenNutzer`) oder in einer
   Route, die ohnehin auf den Versand wartet. Ein zweites drumherum brachte
   nur eine zweite Stelle, an der die Zeile verloren gehen kann. */
function notiereVersand(env, weg, art, bezug, anzahl, kaputt = 0, wer = {}) {
  return env.DB.prepare(`
    INSERT INTO versand_ausgang
      (weg, art, bezug, anzahl, kaputt, ausloeser_id, empfaenger)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(weg, art, bezug, anzahl, kaputt,
          wer.ausloeser ?? null, empfaengerListe(wer.namen))
    .run()
    .catch(e => console.error('Versandprotokoll:', e && e.stack || e));
}

/* Die Empfaengerliste fuers Protokoll (migrations/0026). Namen, nie Adressen.

   DIE GRENZE STEHT HIER UND NICHT IM SCHEMA: sie ist eine Frage der
   Lesbarkeit einer Protokollzeile, keine der Datenhaltung. Bei fuenf Leuten
   steht die Runde da, bei dreissig stuende eine Namenswand in einer Zeile,
   die daneben "30 Mails" sagt - dieselbe Auskunft, nur unlesbar. Ab
   `EMPFAENGER_NAMEN` bricht es darum auf "Micha, Basti und 12 weitere" um.

   Die Reihenfolge ist die des Verteilers und wird NICHT sortiert: sie ist die
   Reihenfolge, in der die Mails tatsaechlich rausgingen, und wenn die dritte
   scheiterte, ist das eine Auskunft. Alphabetisch waere hier Kosmetik ueber
   einer Tatsache. */
const EMPFAENGER_NAMEN = 6;

function empfaengerListe(namen) {
  if (!namen || !namen.length) return null;
  return protokollNamen(namen.filter(Boolean).join(', '));
}

/* Dieselbe Regel auf der LESESEITE. `versand_ausgang` bringt die Liste fertig
   gekuerzt mit (sie wurde beim Schreiben durch `empfaengerListe` gedreht),
   `mail_ausgang` dagegen setzt sie bei jeder Abfrage frisch aus den Zeilen
   zusammen - dort kann sie beliebig lang werden, weil ein `group_concat` kein
   LIMIT kennt. Beide Wege enden darum hier.

   Zweimal gekuerzt schadet nicht: eine schon gekuerzte Liste endet auf "und 12
   weitere" und hat damit hoechstens `EMPFAENGER_NAMEN + 1` Glieder, die
   Funktion laesst sie durch. */
function protokollNamen(roh) {
  if (!roh) return null;
  const namen = String(roh).split(', ').filter(Boolean);
  if (!namen.length) return null;
  if (namen.length <= EMPFAENGER_NAMEN) return namen.join(', ');
  const rest = namen.length - EMPFAENGER_NAMEN;
  return namen.slice(0, EMPFAENGER_NAMEN).join(', ') + ' und ' + rest + ' weitere';
}

/* Dasselbe um einen Mailversand herumgelegt, fuer die fuenf Mails, die an
   `benachrichtige()` vorbeigehen (Anmeldelink, Adresswechsel in beiden
   Richtungen, Betreibermeldung, Testmail). Sie tragen keine `mail_ausgang`-
   Zeile, weil die eine `user_id` braucht und diese Mails teils an Adressen
   gehen, hinter denen kein Nutzer steht - siehe den Kopf von 0025.

   Der Fehler wird protokolliert UND weitergeworfen: was der Aufrufer bisher
   mit einem gescheiterten Versand tat (502 an der Anmeldung, stilles Log bei
   der Warnung), soll er weiter tun. */
async function mitProtokoll(env, art, senden, wer = {}) {
  try {
    await senden();
  } catch (e) {
    await notiereVersand(env, 'mail', art, null, 1, 1, wer);
    throw e;
  }
  await notiereVersand(env, 'mail', art, null, 1, 0, wer);
}

/* Die drei Quellen des Protokolls als SQL, hier statt in der Route: die
   Blaetterabfrage, die Zaehlung und die Uebersichtskarte brauchen dieselben
   Spalten, und drei Abschriften desselben SELECT sind drei Stellen, an denen
   sich eine davon still veraendert. Die Begruendung fuer den Zuschnitt steht
   bei `GET /api/admin/protokoll`. */
const PROTOKOLL_SEITE     = 20;
const PROTOKOLL_SEITE_MAX = 50;
const PROTOKOLL_QUELLEN   = new Set(['admin', 'mail', 'push']);

/* Das Zeitfenster, in dem eine Rundmail im Ausgang zu ihrer Log-Zeile gehoert.
   Gedeckt durch die Stundensperre - siehe den Kopf der Route.

   ACHTUNG, DAS BRUCHSTUECK IST NICHT FUER SICH ALLEIN LAUFFAEHIG: es setzt
   `l` als Alias auf `admin_log` und `m` als Alias des Unterausdrucks voraus.
   Beides steht in `PROTOKOLL_ADMIN_SELECT`, also in einer ANDEREN Zeichenkette
   - wer das hier woanders einsetzt, bekommt einen Fehler ueber eine unbekannte
   Spalte und sucht ihn an der falschen Stelle. */
const RUNDMAIL_FENSTER = `
  m.art = 'rundmail'
  AND m.gesendet_am BETWEEN datetime(l.erstellt, '-5 minutes')
                        AND datetime(l.erstellt, '+5 minutes')`;

const PROTOKOLL_ADMIN_SELECT = `
  SELECT l.erstellt AS wann, 'admin' AS quelle, l.aktion AS aktion,
         coalesce(a.name, 'Ehemaliger') AS wer,
         coalesce(z.name, l.detail, '—') AS wen,
         l.detail AS detail,
         CASE WHEN l.aktion = 'rundmail' THEN
           (SELECT count(*) FROM mail_ausgang m WHERE ${RUNDMAIL_FENSTER})
         END AS anzahl,
         CASE WHEN l.aktion = 'rundmail' THEN
           (SELECT sum(m.fehler IS NOT NULL) FROM mail_ausgang m
             WHERE ${RUNDMAIL_FENSTER})
         END AS kaputt,
         /* Der Ausloeser ist bei der Verwaltung derselbe wie die Spalte davor
            (wer): ihn ein zweites Mal danebenzustellen hiesse "Anna hat
            gesperrt, ausgeloest von Anna". NULL heisst hier also nicht
            "unbekannt", sondern "steht schon da".

            KEINE BACKTICKS IN DIESEN SQL-KOMMENTAREN. Der ganze Block ist ein
            JS-Template-Literal - ein Backtick beendet es mitten im SQL, und
            der Rest wird als JavaScript gelesen. "node --check" merkt davon
            nichts (die Datei bleibt gueltig), erst der Build bricht ab. */
         NULL AS ausloeser,
         CASE WHEN l.aktion = 'rundmail' THEN
           (SELECT group_concat(u3.name, ', ') FROM mail_ausgang m
             JOIN users u3 ON u3.id = m.user_id WHERE ${RUNDMAIL_FENSTER})
         END AS empfaenger
  FROM admin_log l
  LEFT JOIN users a ON a.id = l.admin_id
  LEFT JOIN users z ON z.id = l.ziel_id`;

const PROTOKOLL_UNION = `
  ${PROTOKOLL_ADMIN_SELECT}

  UNION ALL

  /* EIN JOIN, KEINE UNTERABFRAGE. Der erste Entwurf holte die Namen mit einer
     korrelierten Unterabfrage je Gruppe ("WHERE m2.art = mail_ausgang.art
     AND coalesce(m2.bezug, ...) = coalesce(...)") - und legte den lokalen
     Worker still lahm: auf "coalesce(bezug, strftime(...))" gibt es keinen
     Index, also scannte SQLite fuer JEDE Gruppe die ganze Tabelle. Bei 116
     Zeilen dauerte "/api/health" schon ueber zwei Minuten. Der JOIN laeuft
     einmal durch und gruppiert mit, wie es die Zaehlung daneben ohnehin tut.

     "min(...)" ueber "au.name": alle Zeilen einer Gruppe stammen aus einem
     Versandstoss und tragen denselben Ausloeser - die Aggregatfunktion sagt
     SQLite nur, dass hier keine Willkuer im Spiel ist. Alte Zeilen (vor 0026)
     haben NULL, dann bleibt die Stelle im Kontor leer.

     "group_concat(u.name, ', ')" ohne ORDER BY: SQLite haelt hier die
     Scanreihenfolge, und die ist die der "id" - also die des Verteilers. Ein
     "ORDER BY" im Aggregat ginge erst ab 3.44, und Workers D1 ist darunter. */
  SELECT min(m.gesendet_am), 'mail', m.art, NULL, NULL, m.bezug,
         count(*), sum(m.fehler IS NOT NULL),
         min(au.name), group_concat(u.name, ', ')
  FROM mail_ausgang m
  LEFT JOIN users u  ON u.id  = m.user_id
  LEFT JOIN users au ON au.id = m.ausloeser_id
  WHERE m.art <> 'rundmail'
  GROUP BY m.art, coalesce(m.bezug, strftime('%Y-%m-%d %H:%M', m.gesendet_am))

  UNION ALL

  SELECT v.erstellt, v.weg, v.art, NULL, NULL, v.bezug, v.anzahl, v.kaputt,
         coalesce(au.name, CASE WHEN v.ausloeser_id IS NOT NULL
                                THEN 'Ehemaliger' END),
         v.empfaenger
  FROM versand_ausgang v
  LEFT JOIN users au ON au.id = v.ausloeser_id`;

/* Die Marke, an der das Blaettern ansetzt. Warum nicht `wann`: siehe Route.
   Ausloeser und Empfaenger gehen NICHT hinein: der Schluessel muss nur zwei
   Zeilen derselben Sekunde trennen, und das leisten Quelle, Art, Anzahl und
   Betroffener bereits. Jede weitere Spalte macht ihn nur laenger - und laenger
   heisst hier: in jeder Antwort, an jeder Zeile. */
const PROTOKOLL_SK = `
  wann || '|' || quelle || '|' || aktion || '|' ||
  coalesce(cast(anzahl AS text), '') || '|' || coalesce(wen, '') || '|' ||
  coalesce(detail, '')`;

/* Der Heuhaufen, in dem `q` sucht: alles, was auf der Zeile als Sprache steht,
   in einer Zeichenkette. Nicht spaltenweise mit sieben `OR LIKE` - das waere
   dasselbe Ergebnis in siebenfacher Schreibweise, und beim naechsten Feld
   vergisst man eines davon.

   DIE ART STEHT ZWEIMAL DRIN, einmal roh und einmal mit Leerzeichen statt
   Unterstrichen. Das Kontor zeichnet `aktion.replace(/_/g, ' ')` - auf dem
   Blatt steht also "MAILWECHSEL WARNUNG", und wer das abtippt, suchte sonst
   nach etwas, das so in keiner Spalte steht. Gesucht wird, was man LIEST.

   WAS NICHT DRIN IST, IST NICHT VERGESSEN: "Push", "Mail" und "6 Geraete"
   erfindet die Seite beim Zeichnen (`logWer`, `versandStueck`), sie sind
   keine Spalten. Den Weg decken die Reiter darueber ab, und eine Zahl sucht
   niemand als Wort. Deshalb verspricht das Feld im Kontor auch nur "Name oder
   Art" und nicht "durchsuchen".

   `aktion` STEHT OHNE `coalesce` DA, wie schon in `PROTOKOLL_SK`: die Spalte
   ist in allen drei Quellen NOT NULL (`admin_log.aktion`, `mail_ausgang.art`,
   `versand_ausgang.art` - nachgesehen im Schema, nicht angenommen). Waere sie
   es nicht, faerbte ein einziges NULL die ganze Verkettung auf NULL und die
   Zeile fiele lautlos aus jedem Suchergebnis. Wer hier eine vierte Quelle
   anhaengt, prueft das zuerst. */
const PROTOKOLL_HEUHAUFEN = `
  coalesce(wer, '') || ' ' || coalesce(wen, '') || ' ' ||
  aktion || ' ' || replace(aktion, '_', ' ') || ' ' ||
  coalesce(detail, '') || ' ' || coalesce(ausloeser, '') || ' ' ||
  coalesce(empfaenger, '')`;

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

/* `neu` sagt, ob unter dieser Adresse noch KEIN Konto steht (Entscheidung 43).

   Warum die Auskunft ausgerechnet hier faellt und nirgends sonst: die Antwort
   von `POST /api/anmelden` ist fuer Neue und Wiederkehrende WORTGLEICH, und das
   muss sie bleiben - alles andere waere Kontenaufzaehlung, jeder koennte mit
   einer Adressliste durchprobieren, wer hier mitschreibt. Die Mail dagegen
   liest nur, wer das Postfach hat. Sie ist der frueheste Ort, an dem "das wird
   ein neues Konto" gesagt werden DARF.

   Und gesagt werden muss es: am 11.08.2026 legte sich ein Melder ueber
   `…@googlemail.com` unbemerkt ein zweites Konto an, lief beim eigenen Namen in
   den 409 und blieb namenlos stehen. Die Faltung in `normMail` (44) verhindert
   genau diesen Fall - dieser Satz hier faengt alle uebrigen. */
async function schickeLink(env, empfaenger, link, neu = false) {
  const kopf = neu
    ? 'Noch kein Konto unter dieser Adresse - der Link legt eins an:'
    : 'Hier entlang, dann bist du drin:';

  const text =
`${kopf}

${link}

Der Link oeffnet nur die Tafel; angemeldet wird erst mit dem Knopf, der
dort steht. Er gilt ${LINK_MINUTEN} Minuten. Hast du ihn nicht angefordert,
ist nichts passiert - dann wirf die Mail einfach weg.

Liegt die Tafel schon als App auf deinem iPhone-Bildschirm: den Link nicht
antippen, er oeffnet sonst Safari. Stattdessen gedrueckt halten, "Kopieren",
und in der App unten ins Feld "Link aus der Mail" einsetzen.`;

  /* Zwei Saetze, die beide teuer erkauft sind.

     "Der Link oeffnet nur die Tafel": seit dem 2026-08-07 loest er sich nicht
     mehr selbst ein, sondern schlaegt ein Blatt mit einem Knopf auf. Vorher
     genuegte die VORSCHAU von iOS Mail (langer Druck auf einen Link rendert
     die Seite samt Skript), um das Token zu verbrennen - der Nutzer hatte die
     Finger noch nicht bewegt. Dieselbe Ueberlegung stand seit jeher am
     Gewinner-Link ("Vorschaudienste laden Links vor"), nur nicht hier.

     Der Absatz zum Einsetzen ist ebenfalls kein Beiwerk. Auf iOS hat eine
     Seite auf dem Home-Bildschirm ihren EIGENEN Speicher, und ein angetippter
     Link oeffnet immer Safari - wer die Tafel dort installiert hat (und nur
     so gibt iOS Push heraus), kaeme ohne diesen Umweg nie hinein.

     Beides steht bewusst in beiden Fassungen der Mail, nicht nur im HTML. */
  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>${nurText(kopf)}</p>
  <p><a href="${link}" style="display:inline-block;background:#2f5d4a;color:#e3d8c1;
     padding:12px 22px;border-radius:3px;text-decoration:none;letter-spacing:.15em;
     text-transform:uppercase;font-size:13px">Anmelden</a></p>
  <p style="font-size:13px;color:#6f6653">Der Knopf &ouml;ffnet nur die Tafel;
     angemeldet wird erst mit dem Knopf, der dort steht. Er gilt ${LINK_MINUTEN}
     Minuten. Hast du ihn nicht angefordert, ist nichts passiert &ndash; dann wirf
     die Mail einfach weg.</p>
  <p style="font-size:13px;color:#6f6653">Liegt die Tafel schon als App auf deinem
     iPhone-Bildschirm: den Knopf <strong>nicht antippen</strong>, er &ouml;ffnet sonst
     Safari. Stattdessen gedr&uuml;ckt halten, &bdquo;Kopieren&ldquo;, und in der App
     unten ins Feld &bdquo;Link aus der Mail&ldquo; einsetzen.</p>
</div>`;

  await mitProtokoll(env, 'anmeldelink', () =>
    schickeMail(env, empfaenger,
      neu ? 'Dein neues Konto bei „Wer hat kalt“' : 'Dein Link zu „Wer hat kalt“',
      text, html));
}

/* Der Mailwechsel, beide Haelften. Der Link geht an die NEUE Adresse - erst
   der Klick dort schaltet um, bis dahin gilt die alte weiter. Und die alte
   erfaehrt davon, ohne etwas tun zu muessen: wer den Wechsel nicht war, weiss
   dann, dass jemand an seinem Konto sitzt. Das ist die einzige Warnung, die
   ihn ueberhaupt noch erreichen kann. */
async function schickeWechselLink(env, empfaenger, link, ich = null) {
  const text =
`Du willst kuenftig hierunter angeschrieben werden. Der Link oeffnet die
Tafel, dort steht ein Knopf, und der macht es gueltig:

${link}

Er gilt ${LINK_MINUTEN} Minuten. Bis der Knopf gedrueckt ist, bleibt deine
alte Adresse in Kraft. Warst du das nicht, wirf die Mail weg - dann passiert
nichts.`;

  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>Du willst k&uuml;nftig hierunter angeschrieben werden. Der Link &ouml;ffnet die
     Tafel, dort steht ein Knopf, und der macht es g&uuml;ltig:</p>
  <p><a href="${link}" style="display:inline-block;background:#2f5d4a;color:#e3d8c1;
     padding:12px 22px;border-radius:3px;text-decoration:none;letter-spacing:.15em;
     text-transform:uppercase;font-size:13px">Adresse best&auml;tigen</a></p>
  <p style="font-size:13px;color:#6f6653">Er gilt ${LINK_MINUTEN} Minuten. Bis der
     Knopf gedr&uuml;ckt ist, bleibt deine alte Adresse in Kraft. Warst du das nicht,
     wirf die Mail weg &ndash; dann passiert nichts.</p>
</div>`;

  /* Ausloeser und Empfaenger sind derselbe Mensch - wer seine Adresse
     wechselt, schreibt sich selbst an. Die neue Adresse steht NICHT im
     Protokoll, nur der Name: 0025 verbietet Adressen, und diese hier waere
     die heikelste von allen (sie gehoert zu einem Wechsel, der noch nicht
     bestaetigt ist). */
  await mitProtokoll(env, 'mailwechsel', () =>
    schickeMail(env, empfaenger, 'Bestätige deine neue Adresse', text, html),
    ich ? { ausloeser: ich.id, namen: [ich.name] } : {});
}

function warneAlteAdresse(env, ctx, alt, neu, ich = null) {
  if (!ctx || !alt) return;
  const text =
`Jemand hat gerade angefordert, dass "Wer hat kalt" dich kuenftig unter

    ${neu}

anschreibt. Bestaetigt ist es noch nicht - dazu muss der Link in der Mail an
die neue Adresse geklickt werden.

Warst du das nicht: melde dich in der Runde. Solange nichts bestaetigt wurde,
gilt diese Adresse hier weiter.`;

  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24">
  <p>Jemand hat gerade angefordert, dass &bdquo;Wer hat kalt&ldquo; dich k&uuml;nftig unter
     <strong>${nurText(neu)}</strong> anschreibt.</p>
  <p>Best&auml;tigt ist es noch nicht &ndash; dazu muss der Link in der Mail an die
     neue Adresse geklickt werden.</p>
  <p style="font-size:13px;color:#6f6653">Warst du das nicht: melde dich in der Runde.
     Solange nichts best&auml;tigt wurde, gilt diese Adresse hier weiter.</p>
</div>`;

  // Stumm und nebenher: der Wechsel darf nicht daran scheitern, dass die
  // Warnung an die alte Adresse nicht ankommt (sie kann tot sein - das ist
  // oft genau der Grund fuer den Wechsel).
  ctx.waitUntil(mitProtokoll(env, 'mailwechsel_warnung', () =>
    schickeMail(env, alt, 'Deine Adresse soll sich ändern', text, html),
    ich ? { ausloeser: ich.id, namen: [ich.name] } : {})
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

    /* Der Neue ist der Ausloeser, der Betreiber der Empfaenger - und der
       steht als "der Wirt" da und nicht mit Namen: `MELDE_AN` ist eine
       Adresse aus der Konfiguration, hinter der kein Konto stehen muss. */
    await mitProtokoll(env, 'neuer_melder', () =>
      schickeMail(env, env.MELDE_AN, `Neu dabei: ${neu.name}`, text, html),
      { ausloeser: neu.id ?? null, namen: ['der Wirt'] });
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

/* Wie der Abend heisst, wenn ihm niemand einen Namen gegeben hat: auswaerts
   nach seinem ORT, sonst nach seinem Gastgeber. Der Ort ist dort der Name und
   bekommt kein "Bierabend" davor - das gab "Bierabend Schlemmen am Turm". */
const terminName = termin =>
  termin.ort || `Bierabend${termin.gastgeber ? ` bei ${termin.gastgeber}` : ''}`;

/* Und der Ort IN einem Satz. Drei Fassungen, und das ist keine Willkuer,
   sondern Grammatik: " bei Maike" traegt seine Praeposition und haengt sich
   mitten in einen Satz, ohne ihn zu zerreissen. Ein Eigenname kann das nicht
   - "Sonntag um 20:00 Schlemmen am Turm wird getrunken" ist kein Satz.
   Auswaerts muss der Ort deshalb ans ENDE, und wo schon ein Gedankenstrich
   steht (Betreffzeilen), trennt ihn ein Komma statt eines zweiten Strichs.

   Wer eine vierte Stelle baut, an der ein Ort in Text kommt, nimmt eine
   dieser drei und erfindet keine weitere Form. */
const terminBei      = termin => (termin.ort ? '' : termin.gastgeber ? ` bei ${termin.gastgeber}` : '');
const terminOrtEnde  = termin => (termin.ort ? ` — ${termin.ort}` : '');
const terminOrtKomma = termin => (termin.ort ? `, ${termin.ort}` : '');

function icsBauen(env, termin, abgesagt) {
  const titel = termin.titel || terminName(termin);
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

/* WER GEHOERT ZU DIESEM TISCH - der Empfaengerkreis einer Gruppe (Schema 32).
   Ein VERSPRECHEN, kein fertiger Wert: `benachrichtige()` und `stosse()` sind
   ohne `await` aufzurufen (sie rufen selbst `ctx.waitUntil`, und das muss
   stehen, bevor die Antwort hinausgeht). Sie loesen es drinnen auf.

   WOFUER: bis hierher hiess `null` bei beiden "an die ganze Runde", und das
   war richtig, solange es genau eine gab. Ab jetzt waere es ein Leck - der
   Abend eines Bueros ginge an Leute, die von dem Buero nichts wissen sollen.
   Wo ein Ereignis eine Gruppe hat, tritt dieser Kreis an die Stelle des `null`.

   Was `null` weiterhin heisst und heissen soll: die Rundmail des Wirts. Sie
   gehoert ihm und nicht einem Tisch. */
function gruppenKreis(env, gruppeId) {
  if (!gruppeId) return null;
  return env.DB.prepare('SELECT user_id AS id FROM gruppen_mitglied WHERE gruppe_id = ?')
    .bind(gruppeId).all().then(({ results }) => results.map(z => z.id));
}

/* Nur, wer DIESEN Tisch fuehrt - fuer die Mindestbestandsmail (Entscheidung
   34): ein Mitglied kann nichts an der Lieferung aendern, es zu benachrichtigen
   waere ein Alarm ohne Knopf davor. */
function gruppenAdminKreis(env, gruppeId) {
  if (!gruppeId) return null;
  return env.DB.prepare(
    "SELECT user_id AS id FROM gruppen_mitglied WHERE gruppe_id = ? AND rolle = 'admin'")
    .bind(gruppeId).all().then(({ results }) => results.map(z => z.id));
}

/* Der Rumpf jeder Mail. Dieselbe Schrift und dieselben Farben wie beim Magic
   Link - das Kontorbuch des Wirts, nicht die Tafel: eine Mail wird in einem
   fremden Programm auf weissem Grund gelesen. */
/* Der Kopf über jeder Mail: ein Streifen Schiefer mit Glas und Namen in
   Kreide. Als BILD, weil die Kreideschrift eine Systemschrift ist - im
   Mailprogramm des Empfängers gibt es sie nicht, und eine Kopfzeile, die bei
   jedem anders aussieht, ist keine Marke. Gebaut aus
   `ideas/film/ursprung/mailkopf.html` mit
   `ideas/pruefungen/mailkopf-schuss.mjs`.

   DIE ADRESSE STEHT HIER FEST und kommt nicht aus `env.BILDER_URL`, obwohl
   sie dasselbe Bucket meint: `mailRumpf` wird an einem Dutzend Stellen ohne
   `env` gerufen, und die alle umzubauen wäre teurer als diese Zeile. Der
   Preis ist ehrlich zu benennen - wird `BILDER_URL` je getauscht, gehört
   diese Zeile mitgetauscht, und nichts erinnert daran ausser ihr selbst.

   `width` als ATTRIBUT und nicht nur im `style`: Outlook rechnet das `style`
   nicht mit und stellte das Bild sonst in voller Pixelbreite ein. */
const MAIL_KOPF =
`<p style="margin:0 0 20px"><img
   src="https://pub-bfc67ecfa1c8457e98f8775506d4ad16.r2.dev/marke/mailkopf.png"
   alt="wer hat kalt" width="520"
   style="max-width:100%;border-radius:4px;display:block"></p>`;

const mailRumpf = inhalt =>
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1d2a24;max-width:560px;margin:0 auto;padding:8px 20px 24px">
${MAIL_KOPF}
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
  if (Array.isArray(empfaenger) && !empfaenger.length) return;
  const { betreff, text, html, bezug = null, anhaenge = null, ausloeser = null } = opt;

  ctx.waitUntil((async () => {
    /* Seit Schema 32 darf `empfaenger` auch ein VERSPRECHEN auf eine Liste
       sein - die Mitglieder einer Gruppe stehen in der Datenbank und nicht in
       der Hand des Aufrufers. Aufgeloest wird es hier drinnen und nicht davor:
       `ctx.waitUntil` muss gerufen sein, BEVOR die Antwort hinausgeht, sonst
       schneidet die Laufzeit den Rest ab. Ein `await` in der aufrufenden
       Funktion haette genau das getan. */
    empfaenger = await empfaenger;
    if (empfaenger && !empfaenger.length) return;
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
        // `ausloeser_id` seit 0026 - wer den Vorgang angestossen hat, NULL wo
        // ihn niemand angestossen hat (Cron, Frist, Erinnerung).
        zeile = await env.DB.prepare(`
          INSERT INTO mail_ausgang (user_id, art, bezug, ausloeser_id)
          VALUES (?, ?, ?, ?) RETURNING id`)
          .bind(u.id, art, bezug, ausloeser).first();
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

/* Die Schwester des Verteilers: dasselbe an dieselben Leute, nur aufs Geraet
   statt ins Postfach. Sie steht DANEBEN und nicht darin, aus einem Grund:
   eine Mail ist ein Brief, ein Push ist ein Klopfen an der Tuer. Beides in
   einer Schleife haette bedeutet, dass jede kuenftige Aenderung an der einen
   Zustellart die andere anfasst - und die eine Stelle, an der ein Fehler alle
   Meldungen auf allen Wegen erwischt, ist genau die, die es hier nicht geben
   soll. Was BEIDE teilen, ist die Entscheidung, wer etwas bekommt; die steht
   deshalb hier noch einmal in denselben Worten.

   DREI DINGE ABSICHTLICH GLEICH:
   - dieselben Ausschluesse (gesperrt, entfernt, ganz stumm gestellt),
   - dieselben sechs Schalter aus dem Deckel (`mailWahl`). "Keine Termin-Post"
     heisst keine, egal ueber welche Leitung - zwei Schalterreihen fuer
     dieselbe Frage waeren die sicherste Art, dass der Nutzer eine davon nicht
     findet,
   - dieselbe Empfaengerliste, die der Aufrufer schon der Mail gibt.

   EINS ABSICHTLICH ANDERS: `email IS NOT NULL` gilt hier NICHT. Wer nie eine
   Adresse hinterlegt hat, ist bisher von jeder Meldung ausgeschlossen; auf
   dem Geraet erreicht ihn eine.

   UND EINS, DAS DIE MAIL AUFGEGEBEN HAT: `ausser`. Der Verteiler hat es
   verloren, seit die Termin-Mails einen Kalendereintrag TRAGEN (siehe dort) -
   ein Push traegt nichts, er meldet nur. Damit gilt fuer ihn wieder die alte
   Regel: wer selbst gerade den Abend eingetragen hat, braucht darueber kein
   Klopfen an der Tuer.

   Kein Gegenstueck zu `mail_ausgang`: ein Push wird nicht protokolliert und
   nicht gegen Doppelung gesperrt. Das Gatter dort ist ein UNIQUE-Index, und
   der braucht eine Zeile je Empfaenger - fuer ein Klopfen, das nach ein paar
   Stunden ohnehin verfaellt, waere das eine Buchhaltung ueber Rauch. Gegen
   das Doppelte steht stattdessen `tag`: dieselbe Marke ersetzt die liegende
   Meldung auf dem Geraet, statt sich danebenzustellen. */
function stosse(env, ctx, art, empfaenger, opt) {
  if (!ctx || !pushBereit(env)) return;
  if (Array.isArray(empfaenger) && !empfaenger.length) return;
  const { titel, text, url = '.', tag = null, ttl = 86400, dringend = false,
          ausser = null, ausloeser = null } = opt;

  ctx.waitUntil((async () => {
    // Auch hier darf ein Versprechen kommen - Begruendung bei `benachrichtige`.
    empfaenger = await empfaenger;
    if (empfaenger && !empfaenger.length) return;
    const wo = ['u.gesperrt_am IS NULL', 'u.entfernt_am IS NULL', 'u.mail_stumm_am IS NULL'];
    const werte = [];
    if (empfaenger) {
      wo.push(`u.id IN (${empfaenger.map(() => '?').join(',')})`);
      werte.push(...empfaenger);
    }
    if (ausser) { wo.push('u.id <> ?'); werte.push(ausser); }

    /* `u.name` und `u.id` kommen seit 0026 mit: die Namen fuers Protokoll,
       die Id, um sie je MENSCH zu zaehlen und nicht je Geraet. Wer zwei
       Geraete hat, steht sonst zweimal in der Liste. */
    const abos = await env.DB.prepare(`
      SELECT a.id, a.endpoint, a.p256dh, a.auth, u.id AS user_id, u.name, u.mail_prefs
      FROM push_abos a JOIN users u ON u.id = a.user_id
      WHERE ${wo.join(' AND ')}
    `).bind(...werte).all();

    /* Alle auf einmal statt nacheinander: bei einem Notruf an sechs Leute mit
       je zwei Geraeten waeren das sonst zwoelf Wartezeiten hintereinander -
       und die letzte Meldung ginge Sekunden nach der ersten raus. `pushSenden`
       wirft nie, ein einzelner Ausfall reisst also nichts mit. */
    const gewaehlt = abos.results.filter(a => mailWahl(a)[art]);
    const ergebnis = await Promise.all(gewaehlt
      .map(async a => ({ id: a.id, user_id: a.user_id, name: a.name,
                         ...await pushSenden(env, a, { titel, text, url, tag }, ttl, dringend) })));

    /* 404/410 heisst: dieses Geraet gibt es nicht mehr. Die Zeile faellt genau
       hier weg und nirgends sonst - deshalb braucht diese Tabelle keinen
       Aufraeumjob. Andere Fehler (503 vom Dienst, Netz weg) lassen sie
       ausdruecklich stehen: eine Stoerung ist keine Abmeldung. */
    const tot = ergebnis.filter(e => e.status === 404 || e.status === 410).map(e => e.id);
    if (tot.length) {
      await env.DB.prepare(
        `DELETE FROM push_abos WHERE id IN (${tot.map(() => '?').join(',')})`).bind(...tot).run();
    }

    /* Und die Zeile fuers Kontor (migrations/0025). EINE je Stoss, mit der
       Geraetezahl als Spalte - nicht eine je Geraet: das Gatter, das bei der
       Mail eine Zeile je Empfaenger braucht, gibt es hier nicht.

       NICHTS ZU MELDEN, WENN NICHTS RAUSGING. Hatte niemand im Kreis ein Abo
       (oder haben alle diese Art abgewaehlt), bleibt `ergebnis` leer und es
       entsteht keine Zeile. Das ist dieselbe Regel wie bei `mail_ausgang`:
       protokolliert wird ein VERSUCH, und ohne Empfaenger gab es keinen.
       Andernfalls stuende hinter jedem Abend, an dem gerade niemand Push
       eingeschaltet hat, eine Null im Protokoll - eine Zeile, die etwas
       gemeldet zu haben behauptet.

       `tag` ist der Bezug: er traegt beim Notruf schon die Id ('notruf-15')
       und beim Echo den Kommentarbezug - dieselbe Auskunft, die die Mail in
       ihrer `bezug`-Spalte fuehrt, nur in der Schreibweise des Geraets.

       DIE NAMEN JE MENSCH, DIE ZAHL JE GERAET (0026). `anzahl` bleibt die
       Geraetezahl - sie beantwortet "wie oft hat es geklopft" und steht als
       "3 Geraete" in der Zeile. Die Namensliste daneben zaehlt Koepfe: wer
       zwei Geraete hat, stuende sonst zweimal darin, und "Micha, Micha,
       Basti" liest sich wie ein Fehler. Beide Zahlen duerfen darum
       auseinandergehen, und das ist richtig so - "2 Geraete · an Micha" ist
       die genauere Auskunft, nicht die widerspruechliche. */
    if (ergebnis.length) {
      const namen = [...new Map(ergebnis.map(e => [e.user_id, e.name])).values()];
      await notiereVersand(env, 'push', art, tag, ergebnis.length, tot.length,
                           { ausloeser, namen });
    }
  })().catch(e => console.error('stosse:', e && e.stack || e)));
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

  /* Und dasselbe aufs Geraet. DAS IST DER ANLASS, aus dem es Push in diesem
     Projekt ueberhaupt gibt: die Antwortfrist sind drei Stunden, und eine
     Mail, die man am Abend liest, kommt fuer diesen Abend zu spaet.

     Ohne Signatur im Link, anders als in der Mail: wer diesen Push bekommt,
     ist auf dem Geraet angemeldet - das Abo haengt an seinem Konto. Eine
     Marke gehoert in eine Nachricht, die ein fremdes Postfach durchquert,
     nicht in eine, die schon am Ziel ist. In die Nutzlast kommt darum auch
     nie ein Token, egal wie bequem es waere.

     Die Haltbarkeit ist die Frist selbst: was danach ankaeme, beantwortet ein
     Los, das schon verfallen ist. */
  stosse(env, ctx, 'gewonnen', [gewinnerId], {
    titel: 'Die Flasche zeigt auf dich',
    text: `Heute Abend wärst du dran. Sag zu oder ab — sonst verfällt es in ${LOS_FRIST} Stunden.`,
    url: `${env.SEITE}#los=${losId}`,
    tag: `los-${losId}`,
    ttl: LOS_FRIST * 3600,
    dringend: true,
  });

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
  const bei = terminBei(termin), ende = terminOrtEnde(termin), komma = terminOrtKomma(termin);
  const was = termin.titel ? `\n\nEs geht um: ${termin.titel}` : '';
  const selbst = u => u.id === ausloeser;
  const eigen = wieEntstanden === 'zugesagt'
    ? 'Du hast zugesagt'
    : 'Du hast den Abend eingetragen';
  /* Doppelpunkt und nicht Gedankenstrich, obwohl hier lange einer stand: den
     Strich braucht auswaerts der Ort am Satzende, und zwei davon in einem Satz
     sind einer zu viel. */
  const eigenSatz = `${eigen}: ${wann}${bei}${ende}.`;

  /* Der Ausloeser bleibt beim Push AUSSEN VOR - und nur beim Push. Die Mail
     nimmt ihn ausdruecklich mit, weil sie den Kalendereintrag TRAEGT (siehe
     den Absatz darueber). Ein Push traegt nichts; wer den Abend gerade selbst
     eingetragen hat, braucht darueber kein Klopfen an der Tuer. Genau
     deshalb kennt `stosse` ein `ausser` und `benachrichtige` keines mehr. */
  /* DER KREIS IST DIE GRUPPE (Schema 32), nicht mehr die ganze Instanz. Ohne
     das ginge der Abend eines Bueros an jeden Angemeldeten - auch an die, die
     von dem Buero nichts wissen. `termin.gruppe_id` fehlt nur dort, wo ein
     Aufrufer den Termin von Hand zusammensetzt; dann bleibt es beim alten
     Verhalten, und das ist der richtige Rueckfall: lieber einer zu viel als
     ein Gastgeber, der von seinem eigenen Abend nichts erfaehrt. */
  const kreis = gruppenKreis(env, termin.gruppe_id);

  stosse(env, ctx, 'termin_neu', kreis, {
    ausser: ausloeser,
    ausloeser,
    titel: 'Ein Abend steht fest',
    text: `${wann}${bei} wird getrunken${ende}.${termin.titel ? ` Es geht um: ${termin.titel}` : ''}`,
    url: `${env.SEITE}#termin=${termin.id}`,
    tag: `termin-${termin.id}`,
  });

  benachrichtige(env, ctx, 'termin_neu', kreis, {
    bezug: `termin:${termin.id}`,
    ausloeser,
    anhaenge: icsAnhang(env, termin, false),
    betreff: u => selbst(u)
      ? `Für deinen Kalender: ${wann}${bei}${komma}`
      : `Ein Abend steht fest: ${wann}${bei}${komma}`,
    text: u => (selbst(u)
        ? `${eigenSatz}${was}\n\nIm Anhang liegt er für deinen Kalender.`
        : `${wann}${bei} wird getrunken${ende}.${was}\n\nIm Anhang liegt der Kalendereintrag.`)
      + `\n\nSteht auf der Tafel: ${env.SEITE}`,
    html: u => (selbst(u)
        ? `<p>${nurText(eigen)}: <strong>${nurText(wann)}</strong>${nurText(bei + ende)}.</p>`
        : `<p><strong>${nurText(wann)}</strong>${nurText(bei)} wird getrunken${nurText(ende)}.</p>`)
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
  const bei = terminBei(termin), ende = terminOrtEnde(termin), komma = terminOrtKomma(termin);
  const abgesagt = was === 'abgesagt';
  const selbst = u => u.id === ausloeser;

  /* Beim Umbenennen steht der Ort NICHT am Satzende - dort steht der neue
     Name, und "heißt jetzt: Tatort — Schlemmen am Turm" laese sich wie ein
     zweiteiliger Name. Auswaerts wird der Abend deshalb bei seinem alten
     Namen gerufen, und das ist ja gerade der Ort. */
  const neuerName = termin.titel || 'nichts Bestimmtes';
  const kopf = abgesagt ? `Der Abend am ${wann}${bei} fällt aus${ende}.`
    : was === 'umbenannt'
      ? (termin.ort
          ? `„${termin.ort}" am ${wann} heißt jetzt: ${neuerName}.`
          : `Der Abend am ${wann}${bei} heißt jetzt: ${neuerName}.`)
      : (termin.ort
          ? `Der Abend ist jetzt am ${wann}${ende}.`
          : `Der Abend${bei} ist jetzt am ${wann}.`);
  // Dem Ausloeser wird nichts mitgeteilt, was er selbst gerade getan hat.
  const eigen = abgesagt ? `Du hast den Abend am ${wann}${bei} abgesagt${ende}.`
    : was === 'umbenannt'
      ? (termin.ort
          ? `Du hast „${termin.ort}" am ${wann} umbenannt.`
          : `Du hast den Abend am ${wann}${bei} umbenannt.`)
      : (termin.ort
          ? `Du hast den Abend auf ${wann} gelegt${ende}.`
          : `Du hast den Abend${bei} auf ${wann} gelegt.`);

  const wort = abgesagt ? 'Fällt aus' : was === 'umbenannt' ? 'Neuer Anlass' : 'Verschoben';
  const nachsatz = abgesagt
    ? 'Der Anhang nimmt den Eintrag aus deinem Kalender.'
    : 'Der Anhang bringt deinen Kalendereintrag auf den neuen Stand.';

  /* Ausloeser wieder draussen, aus demselben Grund wie beim neuen Abend.
     Derselbe `tag` wie dort: die Meldung zum Abend ist EINE Meldung, die sich
     aendert - drei liegende Zettel zu drei Verschiebungen desselben Abends
     waeren drei Wahrheiten nebeneinander, von denen zwei falsch sind. Die
     Mail darf sich das nicht leisten (sie traegt jedes Mal einen neuen
     Kalendereintrag mit hoeherer SEQUENCE), das Klopfen schon. */
  // Der Kreis ist die Gruppe - Begruendung bei `mailTerminNeu`.
  const kreis = gruppenKreis(env, termin.gruppe_id);

  stosse(env, ctx, 'termin_aendert', kreis, {
    ausser: ausloeser,
    ausloeser,
    titel: wort,
    text: kopf,
    url: abgesagt ? env.SEITE : `${env.SEITE}#termin=${termin.id}`,
    tag: `termin-${termin.id}`,
  });

  benachrichtige(env, ctx, 'termin_aendert', kreis, {
    /* Kein fester Bezug auf den Termin allein: ein Abend darf mehrfach
       verschoben werden, und jede Verschiebung ist eine eigene Nachricht.
       Der Zeitstempel im Bezug trennt sie - der doppelte Ruf innerhalb
       derselben Sekunde bleibt gebremst, der ehrliche zweite Umzug nicht. */
    bezug: `termin:${termin.id}:${was}:${Date.now()}`,
    ausloeser,
    /* Dieselbe UID wie beim ersten Mal, aber eine hoehere SEQUENCE - damit
       ersetzt der Anhang den vorhandenen Eintrag. Bei der Absage traegt er
       METHOD:CANCEL und raeumt ihn weg. */
    anhaenge: icsAnhang(env, termin, abgesagt),
    betreff: u => selbst(u)
      ? `Für deinen Kalender: ${wort.toLowerCase()} — ${wann}${bei}${komma}`
      : `${wort}: ${wann}${bei}${komma}`,
    text: u => `${selbst(u) ? eigen : kopf}\n\n${nachsatz}\n\n`
        + `Steht auf der Tafel: ${env.SEITE}`,
    html: u => `<p>${nurText(selbst(u) ? eigen : kopf)}</p>`
        + `<p style="font-size:13px;color:#6f6653">${nachsatz}</p>`
        + mailKnopf(env.SEITE, 'Zur Tafel'),
  });
}

/* Die einzige Art, die von Haus aus AUS ist: an einem lebhaften Abend ist sie
   die, die eine Runde zumuellt. Wer sie will, schaltet sie ein. */
/* Die Sprungmarke zu einem Ziel. `termin:3` -> `#termin=3`, `user:5` ->
   `#nutzer=5`; die Tafel kennt beide (siehe `pushEinstieg`). Ohne Ziel bleibt
   es bei der nackten Adresse.

   Warum `#nutzer` und nicht `#user`: die Sprungmarken sind das Einzige an
   dieser Anwendung, was ein Mensch im Klartext zu sehen bekommt - in der
   Adresszeile, in einer kopierten Mail. Dort steht sonst auch nirgends
   Englisch. */
const zielMarke = ziel => !ziel ? ''
  : ziel.art === 'termin' ? `#termin=${ziel.id}`
  : ziel.art === 'user' ? `#nutzer=${ziel.id}`
  : '';

function mailEcho(env, ctx, anWen, vonWem, worum, bezug, ziel = null, vonWemId = null) {
  /* WOHIN das Echo zeigt. Hier stand lange nur `env.SEITE`, mit der
     Begruendung, der Verteiler wisse nicht, in welchem Blatt der Faden
     steckt. Das stimmte fuer DIESE Funktion - sie bekommt nur Text und
     Bezug - und war trotzdem falsch: die beiden Aufrufer haben `ziel`
     direkt daneben liegen, es wurde nur nie durchgereicht. Jetzt schon,
     und die Mail nimmt denselben Weg wie der Push. */
  const wohin = env.SEITE + zielMarke(ziel);
  /* Auch hier von Haus aus AUS - derselbe Schalter, dieselbe Vorgabe. Und
     dasselbe Ziel wie in der Mail: die Tafel, ohne Sprungmarke. Ein Echo
     zeigt auf einen Faden, und in welchem Blatt der gerade steckt, weiss der
     Verteiler nicht - die Mail loest das seit jeher mit "Nachlesen", und zwei
     verschiedene Genauigkeiten fuer dieselbe Meldung waeren schlechter als
     eine ehrliche.

     Der `tag` ist der Bezug: wer in einem Faden dreimal angesprochen wird,
     bekommt drei Meldungen (verschiedene Kommentar-Ids), wer eine Bewertung
     nachbessert, ersetzt seine eigene (dieselbe Bewertungs-Id) - genau die
     Trennung, die bei der Mail der UNIQUE-Index auf `bezug` zieht. */
  stosse(env, ctx, 'echo', [anWen], {
    titel: `${vonWem}: ${worum.kurz}`,
    text: worum.lang,
    url: wohin,
    tag: bezug,
    ausloeser: vonWemId,
  });

  benachrichtige(env, ctx, 'echo', [anWen], {
    bezug,
    ausloeser: vonWemId,
    betreff: `${vonWem}: ${worum.kurz}`,
    text: `${worum.lang}\n\nNachlesen: ${wohin}`,
    html: `<p>${nurText(worum.lang)}</p>` + mailKnopf(wohin, 'Nachlesen'),
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
  /* `margin:0 auto` und nicht `margin:0`: ein Bild ist selten so breit wie die
     Mail (das Standbild eines hochkanten Films ist es nie), und links geklebt
     sieht es aus wie ein Anhang, der verrutscht ist. Mittig sieht es aus wie
     eine Karte. */
  const bild = bildUrl
    ? `<p><img src="${nurText(bildUrl)}" alt="" style="max-width:100%;border-radius:4px;
         display:block;margin:0 auto 4px"></p>`
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
   'fehlgeschlagen'.

   `gruppeId` seit Etappe 6 (Entscheidung 35): `null` ist der Wirt an die
   ganze Instanz (unveraendertes Verhalten), ein Wert ist ein Gruppenadmin an
   seine Gruppe.

   DIE SPERRE IST ABSICHTLICH ASYMMETRISCH. `gruppe_id IS NULL OR gruppe_id
   IS ?2` heisst: die Rundmail des Wirts (immer `gruppe_id = NULL` im
   Protokoll) sperrt JEDE Gruppe mit, weil sie deren Mitglieder auch erreicht
   - aber die Rundmail EINER Gruppe sperrt nur sich selbst, nie den Wirt und
   nie eine andere Gruppe. Eine Gruppe kann damit weder den Wirt noch eine
   fremde Gruppe knebeln. */
async function rundmailAbschicken(env, ctx, adminId, geprueft, gruppeId = null) {
  const letzte = await env.DB.prepare(`
    SELECT erstellt FROM admin_log WHERE aktion = 'rundmail'
      AND (gruppe_id IS NULL OR gruppe_id IS ?2)
      AND erstellt > datetime('now', ?1) LIMIT 1
  `).bind(`-${RUNDMAIL_SPERRE} hours`, gruppeId).first();
  if (letzte) {
    const e = new Error('Die letzte Rundmail ist noch keine Stunde her');
    e.sperre = true;
    throw e;
  }

  /* Zaehlung UND Versand muessen denselben Kreis sehen - sonst meldet die
     Route "an 8 verschickt", waehrend `gruppenKreis()` unten nur 5 anschreibt.
     Zwei getrennte Wege ueber dieselbe Menge waeren zwei Wahrheiten. */
  const kreisWo = gruppeId
    ? 'AND id IN (SELECT user_id FROM gruppen_mitglied WHERE gruppe_id = ?)' : '';
  const kreis = await env.DB.prepare(`
    SELECT id, mail_prefs FROM users
    WHERE email IS NOT NULL AND gesperrt_am IS NULL
      AND entfernt_am IS NULL AND mail_stumm_am IS NULL ${kreisWo}
  `).bind(...(gruppeId ? [gruppeId] : [])).all();
  const wieViele = kreis.results.filter(u => mailWahl(u).rundmail).length;

  /* KEIN PUSH. Bewusst die einzige der sechs Arten ohne Gegenstueck auf dem
     Geraet: eine Rundmail ist Post vom Wirt, kein Alarm. Sie kommt
     unangekuendigt, sie hat keine Frist, und sie hat schon einen Weg. Ein
     Klopfen an der Tuer fuer "gelegentliche Nachricht" waere genau die Sorte
     Meldung, wegen der Leute Push abschalten - und mit ihr dann auch das Los
     und den Notruf. Der Schalter `rundmail` steht trotzdem weiter im Deckel;
     er gilt eben nur fuer die Mail. */
  benachrichtige(env, ctx, 'rundmail', gruppeId ? gruppenKreis(env, gruppeId) : null, {
    ausloeser: adminId,
    betreff: geprueft.betreff,
    text: rundmailText(geprueft),
    html: rundmailHtml(geprueft),
  });

  await env.DB.prepare(
    'INSERT INTO admin_log (admin_id, aktion, detail, gruppe_id) VALUES (?, ?, ?, ?)')
    .bind(adminId, 'rundmail', geprueft.betreff.slice(0, 120), gruppeId).run();

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

/* Das Recht, eine Rundmail zu schreiben (Entscheidung 35): der Wirt ohne
   `gruppe` im Rumpf (instanzweit, unveraendertes Verhalten), oder ein
   Gruppenadmin MIT `gruppe` (nur seine eigene). Eine gemeinsame Pruefung
   fuer alle vier Routen - vier eigene Kopien liefen sonst irgendwann
   auseinander, dieselbe Lehre wie bei den Statistik-Abfragen.

   `inGruppe()` uebernimmt die Existenz- und Mitgliedschaftspruefung von
   selbst; der Wirt bekommt darin `rolle: 'admin'` auch ohne Mitgliedschaft
   (Zeile 988), `istGruppenAdmin()` laesst ihn also auch hier durch - er darf
   sich selbst als Gruppenadmin ausgeben und gezielt an eine Gruppe schreiben,
   das ist kein Umweg um irgendeine Schranke. */
async function rundmailRecht(request, env, ich, daten) {
  // `inGruppe()` selbst unterscheidet GET (`?g=`) und POST (`daten.gruppe`) -
  // dieselbe Unterscheidung noetig, BEVOR feststeht, ob es ueberhaupt eine
  // Gruppe gibt, sonst wirft ein Gruppenadmin ohne `gruppe` im Rumpf einen
  // 400er statt der richtigen "Nicht dein Zimmer"-Antwort.
  const hatGruppe = request.method === 'GET'
    ? !!new URL(request.url).searchParams.get('g')
    : !!(daten && daten.gruppe);
  if (!hatGruppe) {
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);
    return { gruppeId: null };
  }
  const g = await inGruppe(request, env, ich, daten);
  if (g instanceof Response) return g;
  if (!istGruppenAdmin(g)) return fehler(request, 'Nicht dein Zimmer', 403);
  return { gruppeId: g.gruppe.id };
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
      }, m.gruppe_id);
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

/* Der Stand der SEITE, im Unterschied zum Stand des Workers.

   Der Worker stempelt sich beim Deploy selbst (GIT_SHA/DEPLOYED_AT als --var,
   siehe CLAUDE.md, Ausrollen). Von der Tafel weiss er nichts: sie liegt auf
   GitHub Pages und kommt hier nie vorbei. Ein Push der Seite laesst seinen
   eigenen Stempel darum unberuehrt - genau das sah im Kontor aus, als waere
   nichts angekommen, und ist der Grund fuer diese Funktion.

   Gefragt wird GitHub nach dem letzten Commit auf `main`. Das ist bewusst
   NICHT nach Pfad gefiltert: die Oberflaeche sind vier Dateien (index.html,
   statistik.html, admin.html, bilder.js), ein Filter auf eine davon uebersaehe
   die Aenderung an den anderen. Die ehrlichere Quelle waere der Pages-Build
   selbst (/pages/builds/latest - welcher Commit wurde wirklich veroeffentlicht),
   die verlangt aber Schreibrechte und antwortet ohne Anmeldung mit 404.
   Nachgeprueft, nicht vermutet.

   Drei Vorkehrungen, alle aus demselben Grund: `/api/health` las bisher nur
   env-Werte und antwortete sofort. Es haengt im `Promise.all` des Kontors, und
   ein haengender Fremdaufruf haelt dort die ganze Seite auf.

     - Zeitgrenze. Nach zweieinhalb Sekunden ist GitHub eben nicht da.
     - Gecacht. Ohne Anmeldung erlaubt GitHub 60 Aufrufe je Stunde und IP;
       aus dem Worker zaehlt das je Rechenzentrum, nicht je Kontor-Besucher.
       Eine Viertelstunde reicht - ein Deploy dauert laenger als der Blick,
       mit dem man danach nachsieht.
     - Nie werfen. Was schiefgeht, kommt als Text heraus und wird im Kontor
       rot. Eine unerreichbare GitHub-API ist kein kaputter Dienst, aber sie
       darf auch nicht stillschweigend verschwinden: ein Stand, der einfach
       fehlt, sieht sonst aus wie ein Stand, der eben nicht weitergezaehlt
       hat. */
async function seitenStand(env) {
  const leer = { version: null, deployed_at: null };
  if (!env.SEITE_REPO) return { ...leer, stand: 'aus (SEITE_REPO fehlt)' };
  try {
    const r = await fetch(
      'https://api.github.com/repos/' + env.SEITE_REPO + '/commits?per_page=1&sha=main',
      {
        // Ohne User-Agent weist GitHub jeden Aufruf mit 403 ab. Das ist keine
        // Hoeflichkeit, das ist Pflicht.
        headers: { 'user-agent': 'beerstock-worker', accept: 'application/vnd.github+json' },
        cf: { cacheTtl: 900, cacheEverything: true },
        signal: AbortSignal.timeout(2500),
      });
    if (!r.ok) return { ...leer, stand: 'fehler: GitHub antwortet ' + r.status };
    const d = await r.json();
    const c = Array.isArray(d) ? d[0] : null;
    if (!c || !c.sha) return { ...leer, stand: 'fehler: GitHub nennt keinen Commit' };
    return {
      stand: 'ok',
      version: String(c.sha).slice(0, 7),
      deployed_at: (c.commit && c.commit.committer && c.commit.committer.date) || null,
    };
  } catch (e) {
    const warum = e && e.name === 'TimeoutError' ? 'GitHub antwortet nicht' : String(e && e.message || e);
    return { ...leer, stand: 'fehler: ' + warum };
  }
}

// ---------------------------------------------------------------------------
// Gruppen (Schema 32)
// ---------------------------------------------------------------------------

/* Aus dem Anzeigenamen die Adressform. Umlaute werden ausgeschrieben und
   nicht weggeworfen - "Büro" wird `buero` und nicht `bro`. Alles andere faellt
   auf Bindestriche zusammen.

   Der Slug ist heute nur ein Merkmal, keine Adresse: der Router kennt keine
   Pfadparameter, die Gruppe reist als `?g=<id>` (siehe `inGruppe`). Er steht
   trotzdem im Schema, weil er die IDEMPOTENZ der Migration traegt ("gibt es
   `am-tresen` schon?") und weil eine sprechende Adresse spaeter ohne
   Datenwanderung nachrueckbar sein soll. */
function slugAus(name) {
  const grund = String(name).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  // Ein Name ganz ohne lateinische Buchstaben ("🍺") ergaebe sonst den leeren
  // Slug, und der ist als UNIQUE genau einmal zu haben.
  return grund || 'gruppe';
}

/* Denselben Slug gibt es nur einmal. Statt am UNIQUE zu scheitern und den
   Nutzer nach einem anderen Namen zu fragen (den er ja frei waehlen darf -
   zwei Runden duerfen gleich heissen), zaehlt der Worker hoch. */
async function slugFrei(env, name) {
  const grund = slugAus(name);
  for (let i = 0; i < 50; i++) {
    const kandidat = i ? `${grund}-${i + 1}` : grund;
    const schon = await env.DB.prepare('SELECT 1 AS da FROM gruppen WHERE slug = ?')
      .bind(kandidat).first();
    if (!schon) return kandidat;
  }
  // Fuenfzig gleichnamige Runden sind kein Anwendungsfall, sondern ein Skript.
  return `${grund}-${wuerfel().slice(0, 8)}`;
}

/* DAS NACHRUECKEN (Entscheidung 30). Verliert eine Gruppe ihren letzten
   Admin, wird das dienstaelteste verbliebene Mitglied ernannt - ohne Zutun
   des Wirts, denn sonst waere eine verwaiste Gruppe bis zu seiner naechsten
   Sitzung handlungsunfaehig.

   AUFGERUFEN NACH JEDER Aenderung, die den letzten Admin kosten kann: nach
   dem Austritt, nach dem Entfernen und nach dem Zurueckstufen. Eine Regel an
   einer Stelle statt drei Sonderfaellen - die drei Wege unterscheiden sich
   fuer die Gruppe in nichts, sie steht danach ohne Fuehrung da.

   Tut nichts, wenn es noch einen Admin gibt oder die Gruppe leer ist. Eine
   leere Gruppe wird ausdruecklich NICHT geloescht: an ihr haengen Lose,
   Notrufe, Termine und Kommentare, und `ON DELETE CASCADE` naehme sie alle
   mit. Sie bleibt stehen, unsichtbar fuer alle ausser dem Wirt. */
async function nachruecken(env, ctx, gruppeId, ausloeserId = null) {
  const nochWer = await env.DB.prepare(`
    SELECT 1 AS da FROM gruppen_mitglied m JOIN users u ON u.id = m.user_id
     WHERE m.gruppe_id = ? AND m.rolle = 'admin'
       AND u.entfernt_am IS NULL AND u.gesperrt_am IS NULL
     LIMIT 1
  `).bind(gruppeId).first();
  if (nochWer) return null;

  /* Dienstalter, und bei gleichem Zeitstempel die kleinere Id. Die Migration
     hat `beigetreten` aus `users.erstellt` gefuellt, damit hier nicht sieben
     gleiche Sekunden gegeneinander stehen - bei zwei Beitritten im selben
     Augenblick entscheidet trotzdem etwas Festes und nicht die Laune der
     Abfrage. */
  /* AUCH NICHT GESPERRT. Ein Gesperrter darf lesen, aber keinen einzigen
     Nicht-GET schreiben (siehe `nutzer`) - er waere eine Fuehrung, die nichts
     tun kann. Schlimmer: von da an gaebe es eine Zeile mit `rolle = 'admin'`,
     und die Vorpruefung oben liesse das Nachruecken nie wieder anlaufen. Die
     Migration traegt Gesperrte ausdruecklich in die Auffanggruppe ein, der
     Fall ist also vom ersten Tag an moeglich. */
  const naechster = await env.DB.prepare(`
    SELECT m.user_id AS id, u.name
      FROM gruppen_mitglied m JOIN users u ON u.id = m.user_id
     WHERE m.gruppe_id = ? AND u.entfernt_am IS NULL AND u.gesperrt_am IS NULL
     ORDER BY m.beigetreten ASC, m.user_id ASC LIMIT 1
  `).bind(gruppeId).first();
  if (!naechster) return null;

  const g = await env.DB.prepare('SELECT id, name FROM gruppen WHERE id = ?')
    .bind(gruppeId).first();

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE gruppen_mitglied SET rolle = 'admin' WHERE gruppe_id = ? AND user_id = ?")
      .bind(gruppeId, naechster.id),
    /* Ins Protokoll, mit der Gruppe daneben (Schema 32). `admin_id` ist hier
       der Ausloeser und nicht der Handelnde - gehandelt hat niemand, das ist
       ja der Punkt. Bei einem Austritt ist es der Ausgetretene, und genau so
       liest sich die Zeile spaeter richtig. */
    env.DB.prepare(`
      INSERT INTO admin_log (admin_id, aktion, ziel_id, detail, gruppe_id)
      VALUES (?, 'nachgerueckt', ?, ?, ?)
    `).bind(ausloeserId || naechster.id, naechster.id,
            g ? g.name : null, gruppeId),
  ]);

  benachrichtige(env, ctx, 'gruppe', [naechster.id], {
    bezug: `nachgerueckt:${gruppeId}`,
    betreff: `Du führst jetzt „${g ? g.name : 'die Gruppe'}"`,
    text:
`„${g ? g.name : 'Die Gruppe'}" hat keinen Verwalter mehr, und du bist am laengsten dabei.
Damit fuehrst du sie ab jetzt: Mitglieder, Antraege und Einladungen liegen bei dir.

${env.SEITE}`,
    html: `<p>„${g ? g.name : 'Die Gruppe'}" hat keinen Verwalter mehr, und du bist am
           l&auml;ngsten dabei. Damit f&uuml;hrst du sie ab jetzt: Mitglieder, Antr&auml;ge
           und Einladungen liegen bei dir.</p>` + mailKnopf(env.SEITE || '#', 'Zur Gruppe'),
  });

  return naechster;
}

/* Und wenn gar niemand mehr da ist, schliesst die Gruppe hinter dem Letzten
   zu. `nachruecken()` gibt in diesem Fall `null` zurueck wie in dem, in dem
   noch ein Verwalter sitzt - die beiden sind von aussen nicht zu
   unterscheiden, deshalb steht das hier und nicht dort.

   NICHT GELOESCHT: an einer leeren Gruppe haengen Buchungen, Salden,
   abgeschlossene Monate und Strafen. Ein `DELETE` risse sie alle mit, und
   der Ausgetretene wollte nur gehen, nicht die Geschichte tilgen. Was
   wirklich stoert, ist zweierlei, und genau das raeumt diese Funktion weg:
   eine leere Runde stand bis Etappe 9 weiter in der Suche (mit
   `mitglieder: 0`, und wer dort anklopfte, bekam nie eine Antwort), und die
   offenen Antraege lagen fuer immer bei niemandem. Der Rueckweg bleibt der
   Einladungslink - wer ihn einloest, fuehrt sie (siehe
   `POST /api/gruppe/beitritt`). */
async function verwaistSchliessen(env, gruppeId) {
  const wer = await env.DB.prepare(
    'SELECT 1 AS da FROM gruppen_mitglied WHERE gruppe_id = ? LIMIT 1').bind(gruppeId).first();
  if (wer) return false;
  await env.DB.batch([
    env.DB.prepare("UPDATE gruppen SET sichtbar = 'privat' WHERE id = ?").bind(gruppeId),
    env.DB.prepare(`
      UPDATE gruppen_anfrage
         SET status = 'abgelehnt', beschieden = datetime('now')
       WHERE gruppe_id = ? AND status = 'offen'
    `).bind(gruppeId),
  ]);
  return true;
}

/* Eine Gruppe, wie sie nach aussen aussieht. EINE Stelle, damit die
   Schalterleiste nicht an der einen Route vollstaendig und an der anderen um
   den siebten Schalter verkuerzt herauskommt. */
const gruppeAntwort = (g, extra = {}) => ({
  id: g.id, name: g.name, slug: g.slug, beschreibung: g.beschreibung || null,
  sichtbar: g.sichtbar,
  schalter: Object.fromEntries(SCHALTER.map(s => [s, !!g[s]])),
  ...extra,
});

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

    // Der einzige Fremdaufruf in dieser Route - siehe `seitenStand`, warum er
    // gedeckelt und gecacht ist und niemals wirft.
    const seite = await seitenStand(env);

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
      /* Push aufs Geraet (Schema 23). Beide Haelften des VAPID-Paars muessen
         da sein - und sie werden getrennt gesetzt (die eine als Secret, die
         andere in wrangler.jsonc), also wird auch getrennt gemeldet, welche
         fehlt. Ohne sie bleibt Push aus: die Schalter im Deckel erscheinen
         gar nicht erst, Mails gehen weiter. */
      push: pushBereit(env) ? 'ok'
        : `aus (${!env.VAPID_PUBLIK && !env.VAPID_PRIVAT ? 'VAPID_PUBLIK und VAPID_PRIVAT fehlen'
            : !env.VAPID_PUBLIK ? 'VAPID_PUBLIK fehlt' : 'VAPID_PRIVAT fehlt'})`,
      // Kommen als --var beim Deploy herein (siehe CLAUDE.md, Ausrollen),
      // nicht aus wrangler.jsonc - sie aendern sich ja bei jedem Deploy.
      // Lokal (wrangler dev) bleiben beide unbesetzt, das ist kein Fehler.
      // Sie gelten NUR fuer den Worker; die Seite hat ihren eigenen Stand
      // gleich darunter, und die beiden gehen auseinander, sobald nur eines
      // von beidem geworfen wurde.
      version: env.GIT_SHA || null,
      deployed_at: env.DEPLOYED_AT || null,
      // Der Stand der Tafel, bei GitHub erfragt (siehe `seitenStand`).
      // `seite_stand` traegt das Warum, wenn die beiden anderen leer sind -
      // das Kontor macht daraus eine rote Zeile statt gar keiner.
      seite_stand: seite.stand,
      seite_version: seite.version,
      seite_deployed_at: seite.deployed_at,
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

    /* EINE LEITUNG JE GRUPPE (Schema 32). Die Seite haengt sich an die Gruppe,
       die sie gerade zeigt; beim Wechsel wird die Verbindung geschlossen und
       neu geoeffnet - das ist ohnehin ein Seitenwechsel von `start.html` nach
       `index.html` und kostet nichts.

       Weiterhin OHNE Token, und weiterhin aus demselben Grund: es reisen nur
       Marken, keine Daten. Wer sich an eine fremde Gruppe haengt, erfaehrt,
       DASS dort etwas passiert ist - was, holt er ueber dieselben GET-Routen
       wie sonst, und die pruefen die Mitgliedschaft.

       DIE GRUPPE WIRD BEWUSST NICHT MEHR NACHGESCHLAGEN (Etappe 2). Bis
       hierher lieferte eine bestehende Id 101 und eine freie 404 - zwei
       Antworten, tokenlos erreichbar, aus denen ein Unangemeldeter Gruppen-
       Ids abzaehlen konnte. Jetzt bekommt jede ganzzahlige Id eine Leitung,
       ob es die Gruppe gibt oder nicht: eine erfundene Id haengt an einer
       Tafel, die nie etwas sagt, weil `melden()` sie nie ruft - das sieht
       von aussen genau wie eine kaputte Leitung aus, und das ist Absicht. */
    const id = Number(new URL(request.url).searchParams.get('g'));
    if (!Number.isInteger(id) || id <= 0) {
      return fehler(request, 'Welche Gruppe? (`g` fehlt)');
    }

    return env.TAFEL.get(env.TAFEL.idFromName('gruppe:' + id)).fetch(request);
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
      /* `bekannt` ist oben schon geholt (die Sperrpruefung braucht dieselbe
         Zeile) - `null` heisst: unter dieser Adresse steht noch kein Konto.
         Kein zweiter Treffer auf die Datenbank, und vor allem KEIN Unterschied
         in der Antwort weiter unten (Entscheidung 43). */
      await schickeLink(env, email, link, !bekannt);
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
    // Der Traeger laeuft neben dem Ausweis her - siehe `stolzTraeger`. Er
    // beantwortet genau eine Frage auf jeder Seite: ist MEIN Holzrahmen heute
    // bemalt. Die Geburtstagskinder (Schema 31) laufen aus demselben Grund
    // daneben und beantworten die zweite: bin ICH heute dran.
    const [ich, traeger, kinder] = await Promise.all([
      nutzer(request, env), stolzTraeger(env), geburtstagsKinder(env),
    ]);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    /* Nur die Zahl. Sie ist hoeher, als der Nutzer Geraete benutzt hat: JEDES
       Einloesen eines Magic Links legt ein neues Token an, auch im selben
       Browser, und entfernt wird keines. Hier stand kurzzeitig die ganze
       Liste mit Zeitstempeln, damit man einzelne wegraeumen kann - sieben
       Zeilen fuer zwei benutzte Browser, und damit das groesste Feld des
       Blattes fuer die unwichtigste Auskunft darauf. Wer aufraeumen will,
       meldet alle ab und kommt einmal neu.

       SEIT SCHEMA 27 zaehlt sie nur noch die GERAETE (`zweck IS NULL`). Der
       Hausanschluss steht daneben und hat seinen eigenen Weg hinaus - ihn in
       dieselbe Zahl zu werfen hiesse, dem Nutzer ein Geraet zu melden, das
       keines ist, und zwar genau dann, wenn er nachsieht, wie viele es sind.

       `sum(CASE WHEN ...)` und nicht `sum(zweck = 'ha')`: `NULL = 'ha'` ist in
       SQLite NULL, und eine Summe aus lauter NULL ist NULL, nicht 0. Die
       Fallunterscheidung gibt hier immer eine Zahl. `count(*)`-Zeilen gibt es
       mindestens eine - der Aufrufer haelt ja gerade ein Token in der Hand -,
       die Spalten koennen also nicht ganz ausbleiben.

       Und die zwei Zeitstempel dazu, weil die Seite sie beide braucht: `seit`
       beantwortet "steht da einer", `zuletzt` beantwortet "meldet er sich
       auch". Ein eingerichteter Hausanschluss, von dem seit Wochen nichts
       kommt, ist die eine Auskunft, die man wirklich sehen will - dass die
       Automation drueben stillsteht, sieht man von hier aus sonst nirgends. */
    const zaehlung = await env.DB.prepare(`
      SELECT sum(CASE WHEN zweck IS NULL THEN 1 ELSE 0 END) AS geraete,
             sum(CASE WHEN zweck = 'ha'  THEN 1 ELSE 0 END) AS ha,
             max(CASE WHEN zweck = 'ha'  THEN erstellt END) AS ha_seit,
             max(CASE WHEN zweck = 'ha'  THEN zuletzt  END) AS ha_zuletzt
      FROM tokens WHERE user_id = ?
    `).bind(ich.id).first();
    return antwort(request, {
      name: ich.name,
      braucht_namen: !ich.name,
      /* Trage ICH ihn heute? Kein Platz und kein Farbwert, sondern die eine
         Tatsache, die jede Seite hier braucht: ihr Holzrahmen ist dann bemalt.
         Wer den Regenbogen NUR gewaehlt hat, ihn heute aber nicht traegt,
         bekommt hier `false` - der Rahmen gehoert dem Tag, nicht der Wahl. */
      stolz_heute: traeger === ich.id,
      /* Habe ICH heute (Schema 31)? Daran haengt der Konfettiregen, und der
         gehoert dem, der davorsteht - nicht der Zeile. Ein Ja/Nein und keine
         Zahl: das Alter gibt diese Anwendung nirgends heraus. */
      geburtstag_heute: kinder.includes(ich.id),
      /* Und der eingetragene Tag selbst, roh ('MM-TT' oder 'JJJJ-MM-TT') oder
         `null` - der Deckel zeigt ihn zum Aendern. ZWEI Felder und nicht eines:
         `geburtstag_heute` ist eine Aussage ueber HEUTE und wird an zwanzig
         Stellen gelesen, `geburtstag` ist der gespeicherte Wert und wird an
         genau einer geaendert. Aus dem Datum liesse sich das Heute zwar
         ausrechnen - aber dann rechnete die Seite die Tagesgrenze nach, und
         die ist der Biertag und nicht Mitternacht. */
      geburtstag: ich.geburtstag || null,
      gemessen: ich.quelle === 'ha',
      email: ich.email,
      rolle: ich.rolle,
      // Wer gesperrt ist, soll den Grund lesen koennen - er sieht die Tafel
      // ja weiter, und ohne Grund waere jeder Schreibversuch ein Raetsel.
      gesperrt: ich.gesperrt_am ? { seit: utc(ich.gesperrt_am), grund: ich.gesperrt_grund } : null,
      mail: mailWahl(ich),
      mail_stumm: !!ich.mail_stumm_am,
      geraete: zaehlung ? (zaehlung.geraete || 0) : 1,
      /* Der Hausanschluss (Schema 27), oder `null`, wenn keiner eingerichtet
         ist. Ein Objekt und kein blosses `true`: die Seite zeigt beide Daten
         an, und ein zweiter Aufruf nur fuer zwei Zeitstempel waere eine Runde
         zur Datenbank fuer eine Zeile Text. Das Token selbst steht hier
         ausdruecklich NICHT - gespeichert ist nur sein Hash, es ist nach dem
         Erzeugen unwiederbringlich weg, und genau das ist die Zusage. */
      ha_zugang: zaehlung && zaehlung.ha
        ? { seit: utc(zaehlung.ha_seit), zuletzt: utc(zaehlung.ha_zuletzt) }
        : null,
      /* Der oeffentliche VAPID-Schluessel. Er ist kein Geheimnis - der Browser
         braucht ihn als `applicationServerKey`, um ueberhaupt ein Abo anlegen
         zu koennen. `null` heisst schlicht "dieser Worker kann kein Push", und
         die Seite laesst den Schalter dann weg, statt einen anzubieten, der
         nichts tut. */
      vapid: env.VAPID_PUBLIK || null,
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
        /* Entscheidung 43: fuer einen NAMENLOSEN faellt hier die haeufigste
           Erklaerung an - er hat sich unter einer zweiten Schreibweise seiner
           eigenen Adresse ein zweites Konto geholt und lauft jetzt gegen den
           eigenen Namen. Das Feld `ausweg` sagt der Seite, dass sie neben "nimm
           einen anderen" auch "das war schon mein Konto" anbieten darf; wer
           schon einen Namen hat, benennt sich nur um und braucht das nicht. */
        return antwort(request, {
          fehler: 'Den Namen gibt es schon - nimm einen anderen',
          ...(ich.name ? {} : { ausweg: 'verwerfen' }),
        }, 409);
      }
      throw e;
    }
    // Der Name steht in der Liste - ein Namenloser, der sich benennt, ist fuer
    // die anderen eine neue Zeile. Nur die Gruppen, die `tafel_an` fuehren,
    // zeigen diese Liste ueberhaupt (Schema 32, siehe `anstossSchalter`).
    anstossSchalter('tafel_an', request, env, ctx, 'tafel');
    // Und fuer den Gastgeber ein Neuer. Nur beim ERSTEN Namen: wer sich
    // spaeter umbenennt, hatte schon einen.
    if (!ich.name) meldeNeuenNutzer(env, ctx, { id: ich.id, name, email: ich.email });
    return antwort(request, { ok: true, name });
  },

  // -------------------------------------------------------------------------
  /* Die eigene, gerade entstandene Anmeldung wieder wegwerfen (Entscheidung 43,
     Etappe 7).

     WOZU. `POST /api/anmelden` sagt bewusst nicht, ob es die Adresse schon
     gibt - das waere Kontenaufzaehlung. Wer sich also unter einer zweiten
     Schreibweise seiner eigenen Adresse anmeldet, merkt es erst beim Namen:
     dort steht dann "den gibt es schon", und zwar von seinem EIGENEN Konto.
     Bis Etappe 7 stand er an dieser Stelle namenlos und ohne Ausweg (am
     11.08.2026 genau so passiert, PROJECT-MEMORY/Doppelkonto). Diese Route ist
     der Ausweg - und die Faltung in `normMail` (44) sorgt dafuer, dass er im
     Googlemail-Fall gar nicht erst gebraucht wird.

     WARUM HART GELOESCHT, anders als das weiche `entfernen` des Kontors: hier
     gibt es nichts, was als "Ehemaliger" stehenbleiben muesste. Ein Konto ohne
     Namen und ohne eine einzige Zeile irgendwo hat keine Vergangenheit, an der
     jemand haengt - eine Grabsteinzeile in `users` waere schlicht Muell.

     Die Bedingungen sind eng und werden EINZELN geprueft, nicht summarisch:
     kein Name, keine Meldung, kein Kommentar, keine Bewertung, kein Los, kein
     Termin, keine Buchung, keine Mitgliedschaft. Trifft irgendetwas davon zu,
     ist es kein frisches Versehen mehr, sondern ein Konto - dann 409, und der
     Weg dorthin ist das Kontor. */
  'POST /api/konto/verwerfen': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (ich.name) {
      return fehler(request, 'Dieses Konto hat schon einen Namen - es lässt sich nicht mehr verwerfen.', 409);
    }

    /* EIN Ruf statt acht. Jede Zeile ist ein `EXISTS`, und die Summe sagt
       zugleich, ob und woran es haengt - das kostet nichts extra und macht die
       Fehlermeldung ehrlich, statt "irgendwas" zu sagen. */
    const hat = await env.DB.prepare(`
      SELECT
        EXISTS (SELECT 1 FROM reports            WHERE user_id      = ?1) AS meldung,
        EXISTS (SELECT 1 FROM kommentare         WHERE autor_id     = ?1) AS kommentar,
        EXISTS (SELECT 1 FROM bewertungen        WHERE autor_id     = ?1) AS bewertung,
        EXISTS (SELECT 1 FROM los                WHERE user_id      = ?1) AS los,
        EXISTS (SELECT 1 FROM termine            WHERE gastgeber_id = ?1
                                                    OR erstellt_von = ?1) AS termin,
        EXISTS (SELECT 1 FROM notrufe            WHERE user_id      = ?1) AS notruf,
        EXISTS (SELECT 1 FROM buchung            WHERE user_id       = ?1
                                                    OR gebucht_von   = ?1
                                                    OR storniert_von = ?1) AS buchung,
        -- verhaengt_von kann hier wirklich zuschlagen, user_id nicht:
        -- beitreten geht nur mit Namen (POST /api/gruppe/beitritt und
        -- .../anfrage weisen einen Namenlosen mit 409 ab), ein Namenloser ist
        -- also nie Ziel einer Strafe - aber der WIRT greift ohne
        -- Mitgliedschaft durch (inGruppe laesst ihn als Admin herein), und
        -- users.rolle steht schon beim Einloesen des Magic Links, also vor
        -- dem Namensschritt. Ein namenloser Wirt, der eine Strafe verhaengt
        -- hat, hat etwas hinterlassen.
        EXISTS (SELECT 1 FROM strafe             WHERE user_id       = ?1
                                                    OR verhaengt_von = ?1
                                                    OR erledigt_von  = ?1) AS strafe,
        EXISTS (SELECT 1 FROM gruppen_mitglied   WHERE user_id      = ?1) AS mitglied,
        -- DIESELBE BEGRUENDUNG WIE OBEN, fuer alles, was der WIRT ohne
        -- Mitgliedschaft in einer Gruppe tun kann: Preise setzen, Wareneingang
        -- buchen, eine Hausregel schreiben, einen Monat abschliessen, einen
        -- Antrag bescheiden, einen Einladungslink ausstellen. Jedes davon
        -- hinterlaesst eine Zeile mit einem Fremdschluessel OHNE ON DELETE
        -- CASCADE - vor Etappe 7 gab es diese Tabellen noch nicht, seither
        -- liefe das DELETE unten sonst in einen FK-Fehler und der Nutzer saehe
        -- einen 500er statt eines Satzes.
        --
        -- Nicht in der Liste, weil ein Namenloser dort nicht hinkommt:
        -- gruppen.erstellt_von (Gruenden verlangt einen Namen), saldo.user_id
        -- und saldo.bestaetigt_von sowie strafe.user_id (alle drei setzen
        -- Mitgliedschaft voraus, und die gibt es nur mit Namen).
        EXISTS (SELECT 1 FROM preis              WHERE gesetzt_von       = ?1) AS preis,
        EXISTS (SELECT 1 FROM bestand            WHERE erfasst_von       = ?1) AS bestand,
        EXISTS (SELECT 1 FROM hausregel          WHERE erstellt_von      = ?1) AS regel,
        EXISTS (SELECT 1 FROM abrechnung         WHERE abgeschlossen_von = ?1) AS abrechnung,
        EXISTS (SELECT 1 FROM saldo_log          WHERE von               = ?1) AS saldo_log,
        EXISTS (SELECT 1 FROM strafe_log         WHERE von               = ?1) AS strafe_log,
        EXISTS (SELECT 1 FROM gruppen_anfrage    WHERE beschieden_von    = ?1) AS anfrage,
        EXISTS (SELECT 1 FROM gruppen_einladung  WHERE erstellt_von      = ?1) AS einladung,
        EXISTS (SELECT 1 FROM admin_log          WHERE admin_id          = ?1) AS protokoll
    `).bind(ich.id).first();

    const HAENGT = 'Dieses Konto hat schon etwas hinterlassen und lässt sich nicht mehr verwerfen.';
    const besitz = Object.entries(hat).filter(([, v]) => v).map(([k]) => k);
    if (besitz.length) return fehler(request, HAENGT, 409);

    /* Die Tokens zuerst, dann die Zeile. Andersherum bliebe bei einem Abbruch
       zwischen den beiden Anweisungen ein Token stehen, das auf niemanden mehr
       zeigt - `nutzer()` liefert dann `null`, und der Nutzer haengt in einer
       Anmeldung, die es nicht gibt. `batch` faehrt beides in einer
       Transaktion, aber die Reihenfolge kostet nichts und ist die richtige.

       `magic` wird NICHT geraeumt: die Zeilen haengen an der Adresse, nicht am
       Konto, laufen nach fuenfzehn Minuten ohnehin ab, und wer sich gleich
       danach richtig anmeldet, soll seinen frischen Link behalten. */
    /* Das Netz unter der Liste darueber. Die Aufzaehlung ist die ehrliche
       Auskunft, aber sie ist von Hand gepflegt - kommt eine Tabelle mit einem
       Fremdschluessel auf `users(id)` dazu und niemand denkt an diese Stelle,
       faellt der Nutzer sonst in einen 500er. Der Fehler ist derselbe Sachverhalt
       wie oben, also bekommt er denselben Satz: von aussen sind die beiden Wege
       nicht zu unterscheiden, und das sollen sie auch nicht sein. */
    try {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(ich.id),
        env.DB.prepare('DELETE FROM users WHERE id = ? AND name IS NULL').bind(ich.id),
      ]);
    } catch (e) {
      /* Nachgemessen, damit das Muster keine Vermutung ist: D1 meldet hier
         `D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended:
         SQLITE_CONSTRAINT_FOREIGNKEY)`, und dieselbe Zeile noch einmal in
         `cause`. Beide werden angesehen und beide Schreibweisen gesucht - die
         Verpackung von D1 ist nichts, worauf man sich auf drei Jahre festlegen
         sollte, und ein Muster, das eine Fassung spaeter danebengreift, faellt
         genau in den 500er zurueck, den dieser Zweig abfangen soll. Alles
         andere fliegt weiter: ein verschluckter Fehler waere schlimmer als
         einer, den man sieht. */
      const text = String(e && e.message) + ' ' + String(e && e.cause && e.cause.message);
      if (/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(text)) {
        return fehler(request, HAENGT, 409);
      }
      throw e;
    }

    /* Kein `anstoss`: ein namenloses Konto stand auf keiner Tafel, also
       aendert sein Verschwinden an keiner etwas. Und keine Mail - es gibt
       niemanden mehr, an den sie gehen koennte. */
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Den eigenen Geburtstag setzen oder loeschen (Schema 31). Nur den eigenen -
     die Route kennt gar kein Ziel, sie schreibt auf `ich.id`.

     WARUM NICHT UEBER DAS KONTOR. Der Wirt kann es dort auch (`POST
     /api/admin/nutzer` mit `aktion: 'geburtstag'`), aber jeder andere kaeme
     dann nur an seinen eigenen Geburtstag, indem er jemanden bittet. Es ist
     die eine Angabe im ganzen Datenbestand, die der Betreffende sicher weiss
     und alle anderen raten - sie gehoert an den Deckel.

     KEIN `anstoss` an die anderen Tafeln, anders als beim Namen darueber. Ein
     Geburtstag wirkt frueestens am naechsten passenden Morgen; ihn heute
     einzutragen aendert an keiner fremden Tafel etwas, das jemand sehen
     wuerde. Am Tag selbst holt der halbminuetige Abgleich es ohnehin nach.

     Und keine Mail, kein Protokolleintrag: der Wirt braucht nicht zu wissen,
     wer wann seinen Geburtstag nachgetragen hat. Im Kontor steht er ja. */
  'POST /api/geburtstag': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const geprueft = geburtstagPruefen(daten.geburtstag);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);
    await env.DB.prepare('UPDATE users SET geburtstag = ? WHERE id = ?')
      .bind(geprueft.wert, ich.id).run();
    /* Der Wert kommt zurueck, wie er gespeichert wurde - die Seite schreibt
       ihn damit in ihrer eigenen Schreibweise ins Feld zurueck, statt zu
       raten, was aus dem Getippten geworden ist. */
    return antwort(request, { ok: true, geburtstag: geprueft.wert });
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
     Knopf drueckt, will nicht aussuchen, welches gemeint war.

     Die Push-Abos gehen mit. Das ist keine Zugabe, sondern der Kern der
     Sache: ein Token nehmen und den Meldeweg auf demselben Geraet stehen
     lassen hiesse, dass das verlorene Handy weiter mitliest, wer heute
     gezogen wurde und wo jemand einen Notruf abgesetzt hat. Der Browser dort
     hat dann noch ein Abo, das ins Leere zeigt - beim naechsten Aufruf raeumt
     es die Seite selbst weg, und bis dahin kommt darueber nichts mehr.

     DER HAUSANSCHLUSS GEHT MIT (Schema 27), und auch das ist kein Versehen:
     `DELETE FROM tokens WHERE user_id = ?` kennt keinen `zweck`, und es soll
     ihn hier auch nicht kennen. Wer diesen Knopf drueckt, hat sein Handy
     verloren - dass die Wohnung danach weiter im selben Namen schreiben darf,
     waere genau die Luecke, die der Knopf schliessen soll. Seit es einen
     eigenen, feineren Weg gibt (`/api/ha/zugang/weg`), muss die Seite das
     allerdings SAGEN: ein grober Knopf, der still mehr wegnimmt als der feine
     danebenliegende, ist sonst die Falle, die man erst bemerkt, wenn die
     Wohnung schweigt. Der Deckel schreibt es dazu, das README auch. */
  'POST /api/geraete/alle-abmelden': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const [weg] = await env.DB.batch([
      env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(ich.id),
      env.DB.prepare('DELETE FROM push_abos WHERE user_id = ?').bind(ich.id),
    ]);
    return antwort(request, { ok: true, abgemeldet: weg.meta.changes });
  },

  // -------------------------------------------------------------------------
  /* Der Hausanschluss: ein Token, das nicht zu einem Browser gehoert, sondern
     zu der Automation, die von aussen meldet (Home Assistant und alles, was
     sich so verhaelt). Schema 27, `tokens.zweck = 'ha'`.

     WARUM ES DIESE ROUTE GIBT, obwohl jedes Token seit jeher gemeldet hat:
     bisher trug der Nutzer das Token SEINES BROWSERS in die `secrets.yaml`,
     herausgeholt per Entwicklerwerkzeug. Das ist an drei Enden falsch - der
     Weg fuehrt durch die Konsole, das Geheimnis liegt danach an zwei Orten,
     und widerrufen kann man es nur, indem man sich selbst abmeldet. Ein
     eigenes Token loest alle drei auf einmal.

     ES GIBT GENAU EINEN. Erzeugen widerruft den vorherigen im selben `batch`,
     statt einen zweiten danebenzustellen. Zwei Gruende: eine Liste von
     Anschluessen waere dasselbe Feld, das im Deckel schon einmal als
     Token-Liste gescheitert ist (siehe `GET /api/me`) - und wichtiger, der
     haeufigste Grund fuer ein neues Token ist "das alte ist mir abhanden
     gekommen". Genau dann darf das alte nicht weitergelten. Wer wirklich zwei
     Wohnungen meldet, meldet sie mit zwei Konten; das ist ohnehin die
     ehrlichere Abbildung.

     DAS KLARTEXT-TOKEN GIBT ES HIER EIN EINZIGES MAL. Gespeichert wird nur
     `hash(token)` - der Worker kann es spaeter nicht noch einmal zeigen, und
     das ist die Eigenschaft, die den ganzen Rest traegt. Die Seite muss es
     also im selben Atemzug zum Kopieren anbieten und dazuschreiben, dass es
     nicht wiederkommt.

     Ein Gesperrter kommt hier nicht durch: `nutzer()` wirft bei jeder
     Nicht-GET-Route, die nicht in `SPERRE_FREI` steht. Diese steht dort mit
     Absicht nicht - wer gesperrt ist, soll sich abmelden duerfen, aber sich
     keinen frischen Schluessel ziehen. */
  'POST /api/ha/zugang': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const token = wuerfel();
    const [weg] = await env.DB.batch([
      env.DB.prepare("DELETE FROM tokens WHERE user_id = ? AND zweck = 'ha'").bind(ich.id),
      env.DB.prepare("INSERT INTO tokens (token_hash, user_id, zweck) VALUES (?, ?, 'ha')")
        .bind(await hash(token), ich.id),
    ]);
    /* `ersetzt` sagt der Seite, ob sie "eingerichtet" oder "ersetzt - die alte
       Verdrahtung meldet ab sofort ins Leere" schreiben soll. Der Unterschied
       ist fuer den Nutzer betraechtlich und aus dem Token nicht zu sehen. */
    return antwort(request, { token, ersetzt: weg.meta.changes > 0 });
  },

  // -------------------------------------------------------------------------
  /* Und wieder weg. Nur der Hausanschluss, kein Geraet: das ist der ganze
     Zweck der Unterscheidung aus Schema 27.

     KEIN 404, wenn keiner da war. Die Route sagt "danach gibt es keinen
     Hausanschluss mehr", und das stimmt in beiden Faellen; ein Fehler waere
     hier nur die Auskunft, dass der Nutzer zweimal geklickt hat. `weg` steht
     trotzdem in der Antwort, damit die Seite den Satz danach richtig waehlen
     kann. */
  'POST /api/ha/zugang/weg': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const r = await env.DB
      .prepare("DELETE FROM tokens WHERE user_id = ? AND zweck = 'ha'").bind(ich.id).run();
    return antwort(request, { ok: true, weg: r.meta.changes });
  },

  // -------------------------------------------------------------------------
  /* Ein Geraet meldet sich zum Klopfen an (Schema 23). Was der Browser beim
     `subscribe()` herausgibt, kommt hier unveraendert an: die Zustelladresse
     und die zwei Schluessel, gegen die verschluesselt wird.

     UPSERT AUF DEN ENDPOINT, nicht Einfuegen: die Seite ruft diese Route bei
     JEDEM Start auf, wenn ein Abo im Browser liegt. Das ist Absicht - die
     Push-Dienste tauschen Endpoints im Stillen aus, und ein Abo, das nur
     einmal beim Einschalten geschrieben wuerde, waere irgendwann eine
     Karteileiche, ohne dass es jemand merkt. Wandert dabei ein Geraet zu
     einem anderen Konto (dasselbe Tablet, neue Anmeldung), wandert die Zeile
     mit: dessen Meldungen sollen nicht beim Vorbesitzer klopfen.

     Gesperrte duerfen nicht - `nutzer()` laesst sie an Schreibrouten ohnehin
     nicht durch (siehe SPERRE_FREI). */
  'POST /api/push/abo': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const endpoint = String(daten.endpoint ?? '').trim();
    /* Gedeckelt und auf https festgenagelt. Die Laenge ist kein Geiz: dieser
       Wert geht spaeter in ein `fetch` dieses Workers hinein, und was der
       Nutzer schickt, entscheidet damit, wen der Worker anruft. Ein Endpoint
       ist eine Dienstadresse mit einer langen Kennung - 1024 Zeichen sind
       reichlich. */
    if (!/^https:\/\/[^\s]+$/i.test(endpoint) || endpoint.length > 1024) {
      return fehler(request, 'endpoint: eine https-Adresse');
    }
    const s = daten.schluessel;
    if (!s || typeof s !== 'object') return fehler(request, 'schluessel: p256dh und auth');
    const p256dh = String(s.p256dh ?? '');
    const auth = String(s.auth ?? '');
    /* Die Laengen sind vorgeschrieben, nicht geraten: der oeffentliche
       Schluessel des Geraets sind 65 rohe Byte (87 Zeichen base64url), das
       Auth-Geheimnis 16 (22 Zeichen). Was hier daneben liegt, laesst
       `verschluesseln` spaeter beim Senden auflaufen - dort waere es ein
       stiller Fehler ohne Absender, hier ist es eine Antwort. */
    if (!/^[A-Za-z0-9_-]{80,90}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,26}$/.test(auth)) {
      return fehler(request, 'schluessel: p256dh und auth als base64url');
    }

    await env.DB.prepare(`
      INSERT INTO push_abos (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
                                          p256dh  = excluded.p256dh,
                                          auth    = excluded.auth
    `).bind(ich.id, endpoint, p256dh, auth).run();
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Wieder ab. Nur die eigene Zeile - mit `user_id` in der Bedingung, obwohl
     der Endpoint schon eindeutig ist: sonst koennte, wer fremde Endpoints
     erraet, andere Leute stillstellen. Kein 404, wenn nichts wegging: das
     Ergebnis ist dasselbe, und die Seite raeumt hier auch dann auf, wenn der
     Browser sein Abo schon vergessen hat. */
  'POST /api/push/weg': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const endpoint = String(daten.endpoint ?? '').trim();
    if (!endpoint) return fehler(request, 'endpoint fehlt');
    await env.DB.prepare('DELETE FROM push_abos WHERE endpoint = ? AND user_id = ?')
      .bind(endpoint, ich.id).run();
    return antwort(request, { ok: true });
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
      await schickeWechselLink(env, email, `${env.SEITE}#anmelden=${token}`, ich);
    } catch (e) {
      console.error('Mailversand:', e.message);
      return fehler(request, 'Die Mail ging nicht raus. Das liegt an uns, nicht an dir.', 502);
    }
    warneAlteAdresse(env, ctx, ich.email, email, ich);

    return antwort(request, { ok: true, wartet_auf: email });
  },

  // -------------------------------------------------------------------------
  // ===========================================================================
  // Gruppen und Mitgliedschaft (§5.1). Die Gruppe reist als `?g=` bei GET und
  // als Feld `gruppe` im Rumpf sonst - aufgeloest wird sie an genau einer
  // Stelle, in `inGruppe()`.
  // ===========================================================================

  /* Meine Gruppen samt Kurzstand - das ist `start.html`. Vier Abfragen in
     einem `batch` statt einer je Kachel: wer in fuenf Gruppen ist, soll nicht
     fuenfzehn Runden zur Datenbank kosten.

     WAS AUF DER KACHEL STEHT, haengt an der Schalterleiste: eine Gruppe ohne
     Tafel hat keinen Kaltbestand, eine ohne Rad kein laufendes Los. Beides
     kommt dann als `null` heraus und nicht als 0 - "null Bier" und "fuehren
     wir nicht" sind zwei verschiedene Auskuenfte, und die Kachel zeichnet sie
     verschieden. */
  'GET /api/gruppen': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const tag = bierTag();
    const meine = 'SELECT gruppe_id FROM gruppen_mitglied WHERE user_id = ?';
    const [gruppen, kalt, raeder, antraege, salden] = await env.DB.batch([
      env.DB.prepare(`
        SELECT g.*, m.rolle AS meine_rolle, m.beigetreten,
               (SELECT count(*) FROM gruppen_mitglied x JOIN users y ON y.id = x.user_id
                 WHERE x.gruppe_id = g.id AND y.entfernt_am IS NULL) AS mitglieder
          FROM gruppen_mitglied m JOIN gruppen g ON g.id = m.gruppe_id
         WHERE m.user_id = ?
         ORDER BY m.beigetreten ASC, g.id ASC
      `).bind(ich.id),
      /* Der Kaltbestand der Runde: die JUENGSTE Meldung je Mitglied, summiert.
         Dieselbe Bauweise wie `losFeldStmt` - `reports` wird nie
         ueberschrieben, der Stand ist die letzte Zeile. Und derselbe Filter:
         wer keinen Namen hat, steht auf keiner Tafel. */
      env.DB.prepare(`
        SELECT m.gruppe_id AS id, sum(r.biere) AS kalt
          FROM gruppen_mitglied m
          JOIN users u ON u.id = m.user_id
          JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j
            ON j.user_id = m.user_id
          JOIN reports r ON r.id = j.id
         WHERE m.gruppe_id IN (${meine})
           AND u.name IS NOT NULL AND u.entfernt_am IS NULL
         GROUP BY m.gruppe_id
      `).bind(ich.id),
      /* Laeuft dort gerade ein Rad? Dieselbe Bedingung wie `tagesLage`: was
         zugesagt ist gilt, was offen ist gilt, solange die Frist laeuft. */
      env.DB.prepare(`
        SELECT gruppe_id AS id, count(*) AS n FROM los
         WHERE tag = ? AND gruppe_id IN (${meine})
           AND (status = 'zugesagt'
                OR (status = 'offen' AND gedreht_am >= datetime('now', ?)))
         GROUP BY gruppe_id
      `).bind(tag, ich.id, `-${LOS_FRIST} hours`),
      // Wartende Antraege - die sieht nur, wer die Gruppe fuehrt.
      env.DB.prepare(`
        SELECT gruppe_id AS id, count(*) AS n FROM gruppen_anfrage
         WHERE status = 'offen' AND gruppe_id IN (
           SELECT gruppe_id FROM gruppen_mitglied WHERE user_id = ? AND rolle = 'admin')
         GROUP BY gruppe_id
      `).bind(ich.id),
      /* Was ICH in dieser Gruppe noch schulde - ueber ALLE Monate, nicht nur
         den laufenden. Zeigt nur, wer aktuell Mitglied ist; ein Ausgetretener
         hat hier keine Kachel mehr, dafuer gibt es `GET /api/salden`
         (Entscheidung 29). */
      env.DB.prepare(`
        SELECT a.gruppe_id AS id, coalesce(sum(s.betrag_cent - s.gezahlt_cent), 0) AS offen
          FROM saldo s JOIN abrechnung a ON a.id = s.abrechnung_id
         WHERE s.user_id = ? AND a.gruppe_id IN (${meine}) AND s.betrag_cent - s.gezahlt_cent > 0
         GROUP BY a.gruppe_id
      `).bind(ich.id, ich.id),
    ]);

    const proGruppe = (zeilen, feld) =>
      Object.fromEntries(zeilen.results.map(z => [z.id, z[feld]]));
    const kaltJe = proGruppe(kalt, 'kalt');
    const radJe = proGruppe(raeder, 'n');
    const antragJe = proGruppe(antraege, 'n');
    const offenJe = proGruppe(salden, 'offen');

    return antwort(request, {
      gruppen: gruppen.results.map(g => gruppeAntwort(g, {
        rolle: g.meine_rolle,
        mitglieder: g.mitglieder,
        kalt: g.tafel_an ? (kaltJe[g.id] || 0) : null,
        rad: g.rad_an ? !!radJe[g.id] : null,
        /* ANDERS als `kalt`/`rad`: NICHT auf `kasse_an` gated (Abnahmefund).
           Ein abgeschalteter Schalter heisst "es wird gerade nichts
           gebucht", nicht "eine bestehende Schuld ist unsichtbar" - dieselbe
           Begründung wie bei `POST /api/saldo/bestaetigung`, die den
           Schalter aus genau diesem Grund ebenfalls nicht prüft. */
        offen_cent: offenJe[g.id] || 0,
        antraege: g.meine_rolle === 'admin' ? (antragJe[g.id] || 0) : null,
      })),
    });
  },

  // -------------------------------------------------------------------------
  /* Eine Gruppe gruenden. Wer gruendet, fuehrt sie - jede andere Regelung
     braeuchte einen zweiten Menschen, den es beim Gruenden noch nicht gibt. */
  'POST /api/gruppen': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const name = String(daten.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > GRUPPE_NAME_MAX) {
      return fehler(request, `Name: 2 bis ${GRUPPE_NAME_MAX} Zeichen`);
    }
    const text = String(daten.beschreibung ?? '').trim().replace(/\s+/g, ' ');
    if (text.length > GRUPPE_TEXT_MAX) {
      return fehler(request, `Die Beschreibung darf höchstens ${GRUPPE_TEXT_MAX} Zeichen haben`);
    }
    const sichtbar = daten.sichtbar === 'oeffentlich' ? 'oeffentlich' : 'privat';

    const schon = await env.DB.prepare(`
      SELECT count(*) AS n FROM gruppen
       WHERE erstellt_von = ? AND erstellt > datetime('now','-1 day')
    `).bind(ich.id).first();
    if (schon.n >= GRUPPEN_PRO_TAG) {
      return fehler(request, `Höchstens ${GRUPPEN_PRO_TAG} Gruppen am Tag`, 429);
    }

    const slug = await slugFrei(env, name);
    const g = await env.DB.prepare(`
      INSERT INTO gruppen (name, slug, beschreibung, sichtbar, erstellt_von)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `).bind(name, slug, text || null, sichtbar, ich.id).first();

    await env.DB.prepare(`
      INSERT INTO gruppen_mitglied (gruppe_id, user_id, rolle) VALUES (?, ?, 'admin')
    `).bind(g.id, ich.id).run();

    /* KEIN `anstoss`: die neue Gruppe hat genau ein Mitglied, und das haelt
       gerade die Antwort in der Hand. Es gibt keine zweite Leitung, der man
       etwas melden koennte. */
    /* `kalt`, `rad` und `offen_cent` fahren mit, obwohl sie bei einer frisch
       gegruendeten Runde nichts zu sagen haben. Der Grund steht auf der
       anderen Seite: `start.html` schiebt genau dieses Objekt in seine Reihe,
       und ein FEHLENDES Feld liest sich dort als "fuehrt keine Tafel" bzw.
       "dreht nicht" - also als das Gegenteil der eigenen Schalterstellung, bis
       jemand neu laedt. Eine Antwort, die in die Reihe soll, hat auszusehen
       wie eine Zeile der Reihe. */
    return antwort(request, {
      ok: true, gruppe: gruppeAntwort(g, {
        rolle: 'admin', mitglieder: 1,
        kalt: g.tafel_an ? 0 : null,
        rad: g.rad_an ? false : null,
        offen_cent: 0, // nicht `kasse_an`-gated, siehe GET /api/gruppen
        antraege: 0,
      }),
    }, 201);
  },

  // -------------------------------------------------------------------------
  // Stammdaten, Schalterstellung, meine Rolle. Die eine Route, die jede Seite
  // beim Aufbau ruft, sobald sie weiss, welche Gruppe sie zeigt.
  'GET /api/gruppe': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;

    /* Entfernte zaehlen nicht mit - dieselbe Bedingung wie in
       `GET /api/gruppe/mitglieder`. Zwei Zahlen fuer dieselbe Sache auf zwei
       Seiten nebeneinander waeren die Sorte Widerspruch, die niemand meldet
       und jeder bemerkt. */
    const zahl = await env.DB.prepare(`
      SELECT count(*) AS n FROM gruppen_mitglied m JOIN users u ON u.id = m.user_id
       WHERE m.gruppe_id = ? AND u.entfernt_am IS NULL
    `).bind(g.gruppe.id).first();

    return antwort(request, gruppeAntwort(g.gruppe, {
      rolle: g.rolle, mitglied: g.mitglied, mitglieder: zahl.n,
    }));
  },

  // -------------------------------------------------------------------------
  /* Aendern - Name, Beschreibung, Sichtbarkeit, Schalterleiste. Nur der
     Gruppenadmin.

     Die Schalter WIRKEN seit Etappe 2: die Leserouten fragen sie ab
     (`inGruppe(…, schalter)`), und `gruppe.html` zeigt die Funktionen-Leiste
     dem Gruppenadmin. Diese eine Route stand schon in Etappe 1 fertig - sie
     schreiben und sie auswerten waren zwei verschiedene Schritte. */
  'PATCH /api/gruppe': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const setzt = [], werte = [];
    if (daten.name !== undefined) {
      const name = String(daten.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > GRUPPE_NAME_MAX) {
        return fehler(request, `Name: 2 bis ${GRUPPE_NAME_MAX} Zeichen`);
      }
      /* Der Slug wandert NICHT mit. Er ist beim Gruenden entstanden und
         bleibt; wer ihn nachzoege, braeche jede Adresse, die jemand
         weitergegeben hat - und eine Umbenennung ist genau der Moment, in dem
         das passiert. */
      setzt.push('name = ?'); werte.push(name);
    }
    if (daten.beschreibung !== undefined) {
      const text = String(daten.beschreibung ?? '').trim().replace(/\s+/g, ' ');
      if (text.length > GRUPPE_TEXT_MAX) {
        return fehler(request, `Die Beschreibung darf höchstens ${GRUPPE_TEXT_MAX} Zeichen haben`);
      }
      setzt.push('beschreibung = ?'); werte.push(text || null);
    }
    if (daten.sichtbar !== undefined) {
      if (daten.sichtbar !== 'privat' && daten.sichtbar !== 'oeffentlich') {
        return fehler(request, "sichtbar: 'privat' oder 'oeffentlich'");
      }
      setzt.push('sichtbar = ?'); werte.push(daten.sichtbar);
    }
    for (const s of SCHALTER) {
      if (daten[s] === undefined) continue;
      if (typeof daten[s] !== 'boolean') return fehler(request, `${s}: true oder false`);
      setzt.push(`${s} = ?`); werte.push(daten[s] ? 1 : 0);
    }
    if (!setzt.length) return fehler(request, 'Nichts zu ändern');

    const neu = await env.DB.prepare(
      `UPDATE gruppen SET ${setzt.join(', ')} WHERE id = ? RETURNING *`)
      .bind(...werte, g.gruppe.id).first();

    /* Der Wirt greift durch, ohne Mitglied zu sein - das gehoert ins
       Protokoll. Ein Gruppenadmin, der seine eigene Gruppe aendert, tut
       nichts Protokollwuerdiges: es ist seine. */
    if (!g.mitglied) {
      await env.DB.prepare(`
        INSERT INTO admin_log (admin_id, aktion, ziel_id, detail, gruppe_id)
        VALUES (?, 'gruppe_geaendert', NULL, ?, ?)
      `).bind(ich.id, neu.name, neu.id).run();
    }

    // An die offenen Seiten DIESER Gruppe: der Name steht in ihrer Kopfzeile.
    anstossGruppe(neu.id, request, env, ctx, 'tafel');
    return antwort(request, { ok: true, gruppe: gruppeAntwort(neu, { rolle: g.rolle }) });
  },

  // -------------------------------------------------------------------------
  /* Die Gruppensuche. Zeigt NUR Name, Beschreibung und Mitgliederzahl - keine
     Namen, keine Bestaende, kein Rad. Wer drin ist und was dort passiert, ist
     Sache der Mitglieder; hier steht nur, dass es die Runde gibt.

     Private Gruppen kommen gar nicht vor. Sie sind nicht "versteckt, aber
     findbar", sie sind nicht da - der einzige Weg hinein ist ein Link, den
     jemand geschickt hat. */
  'GET /api/gruppen/suche': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 60);
    const wie = `%${q.replace(/[%_]/g, ' ')}%`;

    const { results } = await env.DB.prepare(`
      SELECT g.id, g.name, g.beschreibung,
             (SELECT count(*) FROM gruppen_mitglied m JOIN users x ON x.id = m.user_id
               WHERE m.gruppe_id = g.id AND x.entfernt_am IS NULL) AS mitglieder,
             EXISTS (SELECT 1 FROM gruppen_mitglied m
                      WHERE m.gruppe_id = g.id AND m.user_id = ?) AS drin,
             EXISTS (SELECT 1 FROM gruppen_anfrage a
                      WHERE a.gruppe_id = g.id AND a.user_id = ? AND a.status = 'offen') AS beantragt
        FROM gruppen g
       WHERE g.sichtbar = 'oeffentlich'
         AND (? = '' OR g.name LIKE ? OR coalesce(g.beschreibung,'') LIKE ?)
       ORDER BY g.name
       LIMIT ${SUCHE_MAX}
    `).bind(ich.id, ich.id, q, wie, wie).all();

    return antwort(request, {
      treffer: results.map(g => ({
        id: g.id, name: g.name, beschreibung: g.beschreibung || null,
        mitglieder: g.mitglieder, drin: !!g.drin, beantragt: !!g.beantragt,
      })),
    });
  },

  // -------------------------------------------------------------------------
  /* Beitritt beantragen. AUSDRUECKLICH OHNE `inGruppe()` - wer beantragt, ist
     ja gerade nicht drin, und die Funktion wuerde ihn mit 403 abweisen. Die
     Gruppe wird hier von Hand aufgeloest, und zwar strenger: nur oeffentliche.
     In eine private kommt man nur ueber einen Link. */
  'POST /api/gruppe/anfrage': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const id = Number(daten.gruppe);
    if (!Number.isInteger(id) || id <= 0) return fehler(request, 'Welche Gruppe?');

    const g = await env.DB.prepare('SELECT id, name, sichtbar FROM gruppen WHERE id = ?')
      .bind(id).first();
    /* Eine private Gruppe antwortet hier wie eine, die es nicht gibt. Sonst
       waere diese Route eine Auskunft darueber, welche Ids belegt sind. */
    if (!g || g.sichtbar !== 'oeffentlich') {
      return fehler(request, 'Diese Gruppe gibt es nicht', 404);
    }

    const drin = await env.DB.prepare(
      'SELECT 1 AS da FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
      .bind(id, ich.id).first();
    if (drin) return fehler(request, 'Du bist schon dabei', 409);

    try {
      await env.DB.prepare(
        'INSERT INTO gruppen_anfrage (gruppe_id, user_id) VALUES (?, ?)')
        .bind(id, ich.id).run();
    } catch (e) {
      /* Der partielle UNIQUE-Index laesst genau einen OFFENEN Antrag zu (siehe
         migrations/0032). Ein zweiter ist kein Fehler des Nutzers, sondern
         Ungeduld - und die Antwort sagt ihm, dass sein Antrag noch liegt. */
      if (String(e.message || '').includes('UNIQUE')) {
        return fehler(request, 'Dein Antrag liegt schon vor', 409);
      }
      throw e;
    }
    return antwort(request, { ok: true }, 201);
  },

  // -------------------------------------------------------------------------
  // Die offenen Antraege. Nur fuer den, der die Gruppe fuehrt.
  'GET /api/gruppe/anfragen': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const { results } = await env.DB.prepare(`
      SELECT a.id, a.gestellt, u.id AS user_id, coalesce(u.name, 'Ohne Namen') AS name
        FROM gruppen_anfrage a JOIN users u ON u.id = a.user_id
       WHERE a.gruppe_id = ? AND a.status = 'offen' AND u.entfernt_am IS NULL
       ORDER BY a.gestellt
    `).bind(g.gruppe.id).all();

    return antwort(request, {
      anfragen: results.map(a => ({
        id: a.id, user_id: a.user_id, name: a.name, gestellt: utc(a.gestellt),
      })),
    });
  },

  // -------------------------------------------------------------------------
  // Annehmen oder ablehnen. Beides landet in derselben Zeile - ein Antrag ist
  // danach beschieden und nicht weg, sonst stellt derselbe Mensch ihn morgen
  // wieder und niemand weiss, dass er schon einmal abgelehnt wurde.
  'POST /api/gruppe/anfrage/bescheid': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const annehmen = daten.annehmen === true;
    if (!annehmen && daten.annehmen !== false) {
      return fehler(request, 'annehmen: true oder false');
    }

    /* Die Gruppe steht in der WHERE-Klausel, nicht nur die Antrags-Id: sonst
       beschiede der Admin von Gruppe A mit einer erratenen Nummer den Antrag
       an Gruppe B. */
    const a = await env.DB.prepare(`
      SELECT id, user_id FROM gruppen_anfrage
       WHERE id = ? AND gruppe_id = ? AND status = 'offen'
    `).bind(Number(daten.anfrage), g.gruppe.id).first();
    if (!a) return fehler(request, 'Diesen Antrag gibt es nicht mehr', 404);

    const schritte = [env.DB.prepare(`
      UPDATE gruppen_anfrage
         SET status = ?, beschieden = datetime('now'), beschieden_von = ?
       WHERE id = ? AND status = 'offen'
    `).bind(annehmen ? 'angenommen' : 'abgelehnt', ich.id, a.id)];
    if (annehmen) {
      // `OR IGNORE`: wer zwischendurch ueber einen Einladungslink hereinkam,
      // ist schon Mitglied - dann ist der Antrag trotzdem beschieden.
      schritte.push(env.DB.prepare(
        'INSERT OR IGNORE INTO gruppen_mitglied (gruppe_id, user_id) VALUES (?, ?)')
        .bind(g.gruppe.id, a.user_id));
    }
    await env.DB.batch(schritte);

    benachrichtige(env, ctx, 'gruppe', [a.user_id], {
      bezug: `anfrage:${a.id}`,
      betreff: annehmen
        ? `Du bist dabei: „${g.gruppe.name}"`
        : `Dein Antrag an „${g.gruppe.name}"`,
      text: annehmen
        ? `Dein Antrag an „${g.gruppe.name}" ist angenommen — du bist dabei.\n\n${env.SEITE}`
        : `Dein Antrag an „${g.gruppe.name}" wurde abgelehnt.`,
      html: annehmen
        ? `<p>Dein Antrag an „${g.gruppe.name}" ist angenommen &ndash; du bist dabei.</p>`
          + mailKnopf(env.SEITE || '#', 'Zur Gruppe')
        : `<p>Dein Antrag an „${g.gruppe.name}" wurde abgelehnt.</p>`,
    });

    // Ein neues Mitglied steht in der Liste - das sehen die offenen Seiten
    // DIESER Gruppe, nicht die des Admins (er kann in mehreren sein).
    if (annehmen) anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel');
    return antwort(request, { ok: true, angenommen: annehmen });
  },

  // -------------------------------------------------------------------------
  /* Einen Einladungslink erzeugen. Wer ihn einloest, ist ohne Bescheid drin -
     das ist der Unterschied zum Antrag: hier hat der Admin die Entscheidung
     schon getroffen, als er den Link verschickt hat.

     DER KLARTEXT STEHT GENAU EINMAL IN DIESER ANTWORT und danach nirgends
     mehr - gespeichert ist nur sein Hash, wie beim Geraete-Token (0002) und
     beim Hausanschluss (0027). Wer ihn verliert, macht einen neuen. */
  'POST /api/gruppe/einladung': async (request, env) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    let tage = null;
    if (daten.tage != null) {
      tage = Number(daten.tage);
      if (!Number.isInteger(tage) || tage < 1 || tage > EINLADUNG_TAGE_MAX) {
        return fehler(request, `tage: 1 bis ${EINLADUNG_TAGE_MAX}, oder weglassen`);
      }
    }
    let max = null;
    if (daten.max_nutzung != null) {
      max = Number(daten.max_nutzung);
      if (!Number.isInteger(max) || max < 1 || max > 999) {
        return fehler(request, 'max_nutzung: 1 bis 999, oder weglassen');
      }
    }

    const token = wuerfel();
    await env.DB.prepare(`
      INSERT INTO gruppen_einladung (token_hash, gruppe_id, erstellt_von, laeuft_ab, max_nutzung)
      VALUES (?, ?, ?, ${tage ? "datetime('now', ?)" : '?'}, ?)
    `).bind(await hash(token), g.gruppe.id, ich.id,
            tage ? `+${tage} days` : null, max).run();

    return antwort(request, {
      ok: true,
      /* Fertig zusammengesetzt, damit die Verwaltung ihn nur noch kopieren
         muss. Die Seite kennt ihre eigene Adresse zwar auch - aber der Link
         wird verschickt, nicht geklickt, und ein `#` an der falschen Stelle
         faellt beim Empfaenger auf, nicht beim Absender. */
      link: `${env.SEITE || ''}#einladung=${token}`,
      token,
    }, 201);
  },

  // -------------------------------------------------------------------------
  /* Die bestehenden Links. OHNE Klartext - der ist weg. `kennung` ist der
     Hash selbst: er laesst sich nicht zurueckrechnen, taugt also nicht zum
     Beitreten, wohl aber zum Widerrufen. */
  'GET /api/gruppe/einladungen': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const { results } = await env.DB.prepare(`
      SELECT e.token_hash, e.erstellt, e.laeuft_ab, e.max_nutzung, e.genutzt,
             e.widerrufen_am, coalesce(u.name, 'Ehemaliger') AS von
        FROM gruppen_einladung e LEFT JOIN users u ON u.id = e.erstellt_von
       WHERE e.gruppe_id = ?
       ORDER BY e.erstellt DESC
    `).bind(g.gruppe.id).all();

    return antwort(request, {
      einladungen: results.map(e => ({
        kennung: e.token_hash,
        von: e.von,
        erstellt: utc(e.erstellt),
        laeuft_ab: e.laeuft_ab ? utc(e.laeuft_ab) : null,
        max_nutzung: e.max_nutzung,
        genutzt: e.genutzt,
        widerrufen: !!e.widerrufen_am,
        // Gerechnet und nicht gespeichert, wie der offene Restbetrag spaeter:
        // ein Link ist gueltig, solange nichts dagegen spricht.
        gueltig: !e.widerrufen_am
          && (!e.laeuft_ab || e.laeuft_ab > new Date().toISOString().slice(0, 19).replace('T', ' '))
          && (e.max_nutzung == null || e.genutzt < e.max_nutzung),
      })),
    });
  },

  // -------------------------------------------------------------------------
  /* Einen Link widerrufen. Eigene Route und kein Feld an der Anlege-Route -
     dasselbe Muster wie `POST /api/ha/zugang/weg` (Schema 27): was etwas
     zurueckzieht, soll nicht in derselben Route stehen wie das, was es
     anlegt. Widerrufen statt geloescht, damit der Admin sieht, dass es den
     Link gab. */
  'POST /api/gruppe/einladung/weg': async (request, env) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const weg = await env.DB.prepare(`
      UPDATE gruppen_einladung SET widerrufen_am = datetime('now')
       WHERE token_hash = ? AND gruppe_id = ? AND widerrufen_am IS NULL
    `).bind(String(daten.kennung || ''), g.gruppe.id).run();
    if (!weg.meta.changes) return fehler(request, 'Diesen Link gibt es nicht mehr', 404);
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Einen Einladungslink einloesen. Ohne Bescheid, ohne Antrag - der Link IST
     die Zusage.

     Der zweite Ruf mit demselben Link ist kein Fehler: wer zweimal klickt,
     ist einmal drin. `genutzt` zaehlt dabei nur, wenn wirklich jemand
     dazugekommen ist, sonst braeuchte ein Doppelklick zwei von zehn
     Nutzungen auf. */
  'POST /api/gruppe/beitritt': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const token = String(daten.token || '').trim();
    if (!token) return fehler(request, 'Kein Einladungslink dabei');

    const e = await env.DB.prepare(`
      SELECT e.*, g.name, g.slug FROM gruppen_einladung e
        JOIN gruppen g ON g.id = e.gruppe_id
       WHERE e.token_hash = ?
    `).bind(await hash(token)).first();
    /* Ein Link, den es nicht gibt, und ein widerrufener antworten gleich.
       Alles andere waere eine Auskunft an den, der Links durchprobiert. */
    if (!e || e.widerrufen_am) return fehler(request, 'Dieser Link gilt nicht mehr', 403);
    if (e.laeuft_ab) {
      const abgelaufen = await env.DB.prepare(
        "SELECT (? <= datetime('now')) AS weg").bind(e.laeuft_ab).first();
      if (abgelaufen.weg) return fehler(request, 'Dieser Link ist abgelaufen', 403);
    }

    const drin = await env.DB.prepare(
      'SELECT 1 AS da FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
      .bind(e.gruppe_id, ich.id).first();
    if (drin) {
      return antwort(request, { ok: true, schon: true, gruppe: { id: e.gruppe_id, name: e.name } });
    }
    if (e.max_nutzung != null && e.genutzt >= e.max_nutzung) {
      return fehler(request, 'Dieser Link ist aufgebraucht', 403);
    }

    /* DER ZAEHLER IST DIE TUER, nicht nur die Strichliste. Er laeuft darum
       ALLEIN und VOR dem Beitritt, und sein `RETURNING id` entscheidet, ob es
       ueberhaupt weitergeht.

       Vorher stand er als erstes Statement in demselben `batch` wie der
       INSERT - bedingt zwar, aber der INSERT hing nicht an ihm (Abnahmefund
       Etappe 9). Das `OR IGNORE` faengt nur den Primaerschluessel, also den
       Doppeltipp DESSELBEN Menschen; zwei VERSCHIEDENE, die einen Link mit
       `max_nutzung = 1` gleichzeitig einloesen, haben verschiedene
       `user_id`, kollidieren also nirgends: beide kamen an der
       `drin`-Pruefung vorbei, beim zweiten traf der UPDATE null Zeilen
       (1 < 1 ist falsch), der INSERT lief trotzdem. Ergebnis: eine Nutzung
       gezaehlt, zwei Leute drin. Die Hoechstzahl war gedeckelt, die
       Mitgliedschaft nicht.

       Die aeusseren Pruefungen auf `widerrufen_am` und `laeuft_ab` stehen hier
       ein zweites Mal in der WHERE-Klausel, und das ist kein Doppel: dort oben
       lasen sie den Stand VOR diesem Statement: wird der Link in der Zwischen-
       zeit widerrufen, hielte ihn sonst nichts mehr auf.

       Was der Zaehler NICHT mehr abfaengt: stirbt der Isolate zwischen diesem
       UPDATE und dem `batch` darunter, ist eine Nutzung verbraucht, ohne dass
       jemand hereinkam. Der Tausch ist bewusst - eine verlorene Nutzung ist
       ein Link zu wenig, ein ungedeckelter Beitritt ist ein Mitglied zu viel,
       und nur eines von beiden bricht ein Versprechen an den Admin.

       `RETURNING token_hash`, nicht `RETURNING id`: `gruppen_einladung` hat
       keine `id`, ihr Primaerschluessel IST der Hash. Der Griff daneben
       kostete beim Bauen einen 500er auf jedem Beitritt.

       `NOT EXISTS` steht weiterhin dabei, damit der Doppeltipp DESSELBEN
       Menschen keine zweite Nutzung frisst: SQLite serialisiert die
       Schreiber, der zweite Lauf sieht die Zeile des ersten also bereits.
       Er faellt dann durch, und der Ausgang unten schickt ihn dahin, wo die
       `drin`-Pruefung ihn hingeschickt haette. */
    const platz = await env.DB.prepare(`
      UPDATE gruppen_einladung SET genutzt = genutzt + 1
       WHERE token_hash = ? AND widerrufen_am IS NULL
         AND (laeuft_ab IS NULL OR laeuft_ab > datetime('now'))
         AND (max_nutzung IS NULL OR genutzt < max_nutzung)
         AND NOT EXISTS (SELECT 1 FROM gruppen_mitglied
                          WHERE gruppe_id = ? AND user_id = ?)
      RETURNING token_hash
    `).bind(e.token_hash, e.gruppe_id, ich.id).first();

    /* Kein Platz - vier Gruende, und sie antworten verschieden, weil sie
       verschiedene Dinge bedeuten. Der erste ist gar kein Fehler: wer zweimal
       getippt hat, ist einmal drin und bekommt dieselbe Antwort wie oben. */
    if (!platz) {
      const jetztDrin = await env.DB.prepare(
        'SELECT 1 AS da FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
        .bind(e.gruppe_id, ich.id).first();
      if (jetztDrin) {
        return antwort(request, { ok: true, schon: true, gruppe: { id: e.gruppe_id, name: e.name } });
      }
      const jetzt = await env.DB.prepare(`
        SELECT widerrufen_am,
               (laeuft_ab IS NOT NULL AND laeuft_ab <= datetime('now')) AS weg
          FROM gruppen_einladung WHERE token_hash = ?
      `).bind(e.token_hash).first();
      if (!jetzt || jetzt.widerrufen_am) return fehler(request, 'Dieser Link gilt nicht mehr', 403);
      if (jetzt.weg) return fehler(request, 'Dieser Link ist abgelaufen', 403);
      return fehler(request, 'Dieser Link ist aufgebraucht', 403);
    }

    await env.DB.batch([
      /* Wer eine Runde OHNE Fuehrung betritt, fuehrt sie (Entscheidung 30:
         "eine Gruppe ohne Fuehrung soll es keine Sekunde geben"). Der Fall
         entsteht, wenn der Letzte gegangen ist und die Gruppe leer
         zurueckgeblieben war - der Einladungslink ist dann ihr einziger
         Rueckweg, und ein Mitglied ohne Rechte koennte dort nichts richten.

         `OR IGNORE` bleibt stehen, obwohl der Zaehler oben den Doppeltipp
         schon abfaengt: kommt hier doch einmal ein Primaerschluessel-Konflikt
         an, rollt sonst der ganze `batch` zurueck und der Aufrufer sieht einen
         500er, obwohl er drin ist. Das ist der teurere Ausgang. */
      env.DB.prepare(`
        INSERT OR IGNORE INTO gruppen_mitglied (gruppe_id, user_id, rolle)
        VALUES (?1, ?2, (SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM gruppen_mitglied WHERE gruppe_id = ?1 AND rolle = 'admin'
               ) THEN 'member' ELSE 'admin' END))
      `).bind(e.gruppe_id, ich.id),
      /* Ein offener Antrag desselben Menschen an dieselbe Gruppe ist damit
         erledigt - sonst liegt er dem Admin noch im Kontor, obwohl der
         Antragsteller laengst am Tisch sitzt. */
      env.DB.prepare(`
        UPDATE gruppen_anfrage SET status = 'angenommen', beschieden = datetime('now')
         WHERE gruppe_id = ? AND user_id = ? AND status = 'offen'
      `).bind(e.gruppe_id, ich.id),
    ]);

    anstossGruppe(e.gruppe_id, request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true, schon: false, gruppe: { id: e.gruppe_id, name: e.name },
    }, 201);
  },

  // -------------------------------------------------------------------------
  // Die Mitglieder samt Rollen. Jedes Mitglied darf das sehen - wer am Tisch
  // sitzt, weiss ohnehin, wer am Tisch sitzt.
  'GET /api/gruppe/mitglieder': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;

    const { results } = await env.DB.prepare(`
      SELECT m.user_id AS id, m.rolle, m.beigetreten,
             coalesce(u.name, 'Ohne Namen') AS name,
             ${farbeSql('u')} AS farbe,
             (u.gesperrt_am IS NOT NULL) AS gesperrt
        FROM gruppen_mitglied m JOIN users u ON u.id = m.user_id
       WHERE m.gruppe_id = ? AND u.entfernt_am IS NULL
       -- Wer fuehrt, steht oben. NICHT nach rolle DESC: alphabetisch stuende
       -- 'member' vor 'admin', und die Liste saehe zufaellig sortiert aus.
       ORDER BY (m.rolle = 'admin') DESC, m.beigetreten ASC
    `).bind(g.gruppe.id).all();

    return antwort(request, {
      mitglieder: results.map(m => ({
        id: m.id, name: m.name, rolle: m.rolle, farbe: m.farbe,
        gesperrt: !!m.gesperrt, beigetreten: utc(m.beigetreten),
        ich: m.id === ich.id,
      })),
    });
  },

  // -------------------------------------------------------------------------
  /* Rolle aendern oder jemanden entfernen. Nur der Gruppenadmin.
     BUCHUNGEN UND SALDEN BLEIBEN (Entscheidung 29) - hier faellt die
     Mitgliedschaft, nichts sonst. Wer geht, nimmt seine Schulden nicht mit;
     die Abrechnung fuehrt ihn danach als Ehemaligen. */
  'PATCH /api/gruppe/mitglied': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const wen = Number(daten.user);
    if (!Number.isInteger(wen) || wen <= 0) return fehler(request, 'Wen denn?');
    const m = await env.DB.prepare(
      'SELECT rolle FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
      .bind(g.gruppe.id, wen).first();
    if (!m) return fehler(request, 'Der ist nicht in dieser Gruppe', 404);

    const entfernen = daten.entfernen === true;
    const rolle = daten.rolle;
    if (!entfernen && rolle !== 'member' && rolle !== 'admin') {
      return fehler(request, "rolle: 'member' oder 'admin' — oder entfernen: true");
    }

    if (entfernen) {
      await env.DB.prepare('DELETE FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
        .bind(g.gruppe.id, wen).run();
    } else {
      await env.DB.prepare(
        'UPDATE gruppen_mitglied SET rolle = ? WHERE gruppe_id = ? AND user_id = ?')
        .bind(rolle, g.gruppe.id, wen).run();
    }

    if (!g.mitglied) {
      await env.DB.prepare(`
        INSERT INTO admin_log (admin_id, aktion, ziel_id, detail, gruppe_id)
        VALUES (?, ?, ?, ?, ?)
      `).bind(ich.id, entfernen ? 'gruppe_entfernt' : 'gruppe_rolle', wen,
              entfernen ? g.gruppe.name : `${g.gruppe.name}: ${rolle}`, g.gruppe.id).run();
    }

    /* Und wenn das gerade den letzten Admin gekostet hat, rueckt jemand nach -
       auch dann, wenn der Admin sich selbst zurueckgestuft hat. Eine Gruppe
       ohne Fuehrung soll es keine Sekunde geben. */
    const nach = await nachruecken(env, ctx, g.gruppe.id, ich.id);
    // Der Wirt kann auch den Letzten hinausstellen - dann gilt dasselbe wie
    // beim Austritt des Letzten.
    const verwaist = entfernen ? await verwaistSchliessen(env, g.gruppe.id) : false;

    /* Gemeldet wird der Stand DANACH, nicht der beabsichtigte. Sonst steht in
       der Antwort "rolle: member" und daneben "nachgerueckt: derselbe Mensch" -
       und der Einzige, der sich selbst zurueckgestuft hat, ist ja gerade als
       dienstaeltestes Mitglied wieder aufgerueckt. Die Seite schriebe daraus
       zwei Saetze, von denen der erste falsch ist. */
    const jetzt = entfernen ? null : (await env.DB.prepare(
      'SELECT rolle FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
      .bind(g.gruppe.id, wen).first())?.rolle ?? null;

    anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true, entfernt: entfernen, rolle: jetzt, verwaist,
      nachgerueckt: nach ? { id: nach.id, name: nach.name } : null,
    });
  },

  // -------------------------------------------------------------------------
  /* Selbst gehen. Braucht keine Rolle - jeder darf jederzeit aufstehen.
     War es der letzte Admin, rueckt das dienstaelteste Mitglied nach
     (Entscheidung 30), und das erfaehrt es per Mail. */
  'POST /api/gruppe/austritt': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;
    /* Der Wirt kommt ueber `inGruppe()` auch in Gruppen hinein, in denen er
       nicht sitzt - austreten kann er dort nicht, es gibt nichts zu loeschen.
       Ohne diese Zeile bekaeme er ein `ok: true` fuer nichts. */
    if (!g.mitglied) return fehler(request, 'Du bist gar nicht in dieser Gruppe', 409);

    await env.DB.prepare('DELETE FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
      .bind(g.gruppe.id, ich.id).run();

    const nach = await nachruecken(env, ctx, g.gruppe.id, ich.id);
    const verwaist = await verwaistSchliessen(env, g.gruppe.id);

    anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true, verwaist,
      nachgerueckt: nach ? { id: nach.id, name: nach.name } : null,
    });
  },

  // ===========================================================================
  // Kasse (§5.2) - ab hier braucht jede Route zusaetzlich zur Mitgliedschaft
  // den Schalter `kasse_an`.
  // ===========================================================================

  // -------------------------------------------------------------------------
  /* Die Mitgliedersicht: aktive Getraenke mit geltendem und angekuendigtem
     Preis (Entscheidung 38), Bestand, mein Monatsstand. Der Gruppenadmin
     bekommt zusaetzlich die deaktivierten Getraenke und ihre Preishistorie -
     EINE Antwortform statt einer eigenen Adminroute, dasselbe Prinzip wie
     bei `GET /api/gruppe`. */
  'GET /api/kasse': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null, 'kasse_an');
    if (g instanceof Response) return g;
    const admin = istGruppenAdmin(g);
    const jetzt = alsDbZeit(new Date());

    const { results: getraenke } = await env.DB.prepare(`
      SELECT gk.id, gk.name, gk.aktiv, gk.mindest,
        (SELECT coalesce(sum(menge),0) FROM bestand
          WHERE gruppe_id = ?2 AND getraenk_id = gk.id) AS bestand,
        (SELECT cent FROM preis WHERE getraenk_id = gk.id AND gueltig_ab <= ?1
           ORDER BY gueltig_ab DESC, id DESC LIMIT 1) AS preis_cent,
        -- ', id DESC' ist hier PFLICHT, nicht Zierrat - dieselbe Falle wie bei
        -- preis_lauf (siehe migrations/0034): zwei vorgemerkte Zeilen auf
        -- dieselbe Sekunde sind sonst uneindeutig, und naechster_id unten
        -- entfernte dann die falsche Zeile.
        (SELECT cent FROM preis WHERE getraenk_id = gk.id AND gueltig_ab > ?1
           ORDER BY gueltig_ab ASC, id DESC LIMIT 1) AS naechster_cent,
        (SELECT gueltig_ab FROM preis WHERE getraenk_id = gk.id AND gueltig_ab > ?1
           ORDER BY gueltig_ab ASC, id DESC LIMIT 1) AS naechster_ab,
        (SELECT id FROM preis WHERE getraenk_id = gk.id AND gueltig_ab > ?1
           ORDER BY gueltig_ab ASC, id DESC LIMIT 1) AS naechster_id
        FROM getraenk gk
       WHERE gk.gruppe_id = ?2${admin ? '' : ' AND gk.aktiv = 1'}
       ORDER BY gk.aktiv DESC, gk.name
    `).bind(jetzt, g.gruppe.id).all();

    let historieJe = {};
    if (admin && getraenke.length) {
      const { results: h } = await env.DB.prepare(`
        SELECT getraenk_id, cent, gueltig_ab FROM preis
         WHERE getraenk_id IN (${getraenke.map(() => '?').join(',')})
         ORDER BY getraenk_id, gueltig_ab DESC, id DESC
      `).bind(...getraenke.map(d => d.id)).all();
      for (const z of h) {
        (historieJe[z.getraenk_id] ??= []).push({ cent: z.cent, gueltig_ab: utc(z.gueltig_ab) });
      }
    }

    const monat = await env.DB.prepare(`
      SELECT coalesce(sum(menge),0) AS biere, coalesce(sum(menge*cent),0) AS cent
        FROM buchung
       WHERE gruppe_id = ? AND user_id = ? AND storniert_am IS NULL
         AND strftime('%Y-%m', gebucht_am) = strftime('%Y-%m', 'now')
    `).bind(g.gruppe.id, ich.id).first();

    return antwort(request, {
      getraenke: getraenke.map(d => ({
        id: d.id, name: d.name, aktiv: !!d.aktiv, mindest: d.mindest, bestand: d.bestand,
        preis_cent: d.preis_cent ?? null,
        naechster_preis: d.naechster_cent != null
          ? { id: d.naechster_id, cent: d.naechster_cent, gueltig_ab: utc(d.naechster_ab) } : null,
        ...(admin ? { historie: historieJe[d.id] || [] } : {}),
      })),
      mein_monat: { biere: monat.biere, cent: monat.cent },
    });
  },

  // -------------------------------------------------------------------------
  /* Buchen. Admin darf `fuer_user` mitgeben (§2.2) - fuer den, der kein
     Handy dabei hat. */
  'POST /api/kasse/buchung': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    /* Gegenbuchung (Entscheidung 31, Etappe 4): eine sichtbare Buchung im
       laufenden Monat, die eine Buchung aus einem BEREITS ABGESCHLOSSENEN
       Monat aufhebt - kein Storno, das aendert die alte Zeile nicht. Eigener,
       fruehzeitig verlassener Zweig: die Gruppe kommt vom ORIGINAL, nie aus
       dem Rumpf, nur der Gruppenadmin darf, und der Bestand bleibt
       unangetastet - das Bier ist getrunken, nur der Betrag war falsch. */
    if (daten.gegen !== undefined && daten.gegen !== null) {
      const alteId = Number(daten.gegen);
      if (!Number.isInteger(alteId) || alteId <= 0) return fehler(request, 'Welche Buchung wird gegengebucht?');

      const b = await env.DB.prepare('SELECT * FROM buchung WHERE id = ?').bind(alteId).first();
      if (!b) return fehler(request, 'Diese Buchung gibt es nicht', 404);

      const g = await inGruppe(request, env, ich, { gruppe: b.gruppe_id }, 'kasse_an');
      if (g instanceof Response) return g;
      if (!istGruppenAdmin(g)) return fehler(request, 'Eine Gegenbuchung darf nur, wer die Gruppe führt', 403);
      if (b.storniert_am) return fehler(request, 'Diese Buchung ist storniert, keine Gegenbuchung nötig', 409);

      const abrechnung = await abrechnungFuer(env, b.gruppe_id, ...jahrMonatAus(b.gebucht_am));
      if (!abrechnung) {
        return fehler(request, 'Dieser Monat ist noch offen — hier gilt das Storno, nicht die Gegenbuchung', 409);
      }

      /* KEIN Mitgliedschaftscheck auf `b.user_id` - anders als beim normalen
         Buchen fuer andere (unten): wer die Buchung trug, darf laengst
         ausgetreten sein (Entscheidung 29), die Korrektur muss trotzdem
         moeglich bleiben. `cent` kommt vom ORIGINAL, nicht aus
         `geltenderPreis()` - eine spaetere Preisaenderung darf die
         Gegenbuchung nicht verschieben, genau wie bei der Buchung selbst. */
      let neu;
      try {
        neu = await env.DB.prepare(`
          INSERT INTO buchung (gruppe_id, getraenk_id, user_id, menge, cent, gebucht_von, grund)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, gebucht_am
        `).bind(b.gruppe_id, b.getraenk_id, b.user_id, -b.menge, b.cent, ich.id, `gegenbuchung:${b.id}`).first();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Für diese Buchung gibt es schon eine Gegenbuchung', 409);
        }
        throw e;
      }

      await kasseAdminLog(env, ich, g, 'gegenbuchung', `${b.id}:${-b.menge}`);
      anstossGruppe(b.gruppe_id, request, env, ctx, 'kasse');
      return antwort(request, {
        ok: true, id: neu.id, gegen: b.id, cent: b.cent, menge: -b.menge,
      }, 201);
    }

    const g = await inGruppe(request, env, ich, daten, 'kasse_an');
    if (g instanceof Response) return g;

    const getraenkId = Number(daten.getraenk);
    if (!Number.isInteger(getraenkId) || getraenkId <= 0) return fehler(request, 'Welches Getränk?');

    const menge = daten.menge === undefined ? 1 : Number(daten.menge);
    if (!Number.isInteger(menge) || menge < 1 || menge > BUCHUNG_MENGE_MAX) {
      return fehler(request, `Menge: 1 bis ${BUCHUNG_MENGE_MAX}`);
    }

    let fuerId = ich.id;
    if (daten.fuer_user !== undefined && daten.fuer_user !== null) {
      if (!istGruppenAdmin(g)) return fehler(request, 'Für andere buchen darf nur, wer die Gruppe führt', 403);
      fuerId = Number(daten.fuer_user);
      if (!Number.isInteger(fuerId) || fuerId <= 0) return fehler(request, 'Für wen?');
      const mitglied = await env.DB.prepare(
        'SELECT 1 AS da FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
        .bind(g.gruppe.id, fuerId).first();
      if (!mitglied) return fehler(request, 'Diese Person ist nicht in der Gruppe', 404);
    }

    const d = await env.DB.prepare('SELECT id, name, aktiv FROM getraenk WHERE id = ? AND gruppe_id = ?')
      .bind(getraenkId, g.gruppe.id).first();
    if (!d) return fehler(request, 'Dieses Getränk gibt es hier nicht', 404);
    if (!d.aktiv) return fehler(request, 'Dieses Getränk ist abgeschaltet', 409);

    const jetzt = alsDbZeit(new Date());
    const p = await geltenderPreis(env, getraenkId, jetzt);
    // KEIN Durchbuchen mit `cent = 0` - eine 0-Cent-Buchung ist gratis Bier
    // und nur noch per Gegenbuchung heilbar (Etappe 4).
    if (!p) return fehler(request, 'Für dieses Getränk ist noch kein Preis gesetzt', 409);

    const buchung = await env.DB.prepare(`
      INSERT INTO buchung (gruppe_id, getraenk_id, user_id, menge, cent, gebucht_von)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id, gebucht_am
    `).bind(g.gruppe.id, getraenkId, fuerId, menge, p.cent, ich.id).first();

    /* Zwei Zeilen, nicht ein Batch - `buchung` traegt `RETURNING id`, und
       genau diese Id braucht die zweite Zeile. Das Fenster zwischen beiden
       ist eine SQLite-Einzelanweisung breit; eine `bestand`-Zeile faellt nur
       aus, wenn D1 selbst dazwischen ausfaellt, und dann ist die Buchung
       ohnehin das kleinere Problem. */
    await env.DB.prepare(`
      INSERT INTO bestand (gruppe_id, getraenk_id, menge, art, buchung_id, erfasst_von)
      VALUES (?, ?, ?, 'verbrauch', ?, ?)
    `).bind(g.gruppe.id, getraenkId, -menge, buchung.id, ich.id).run();

    const stand = await bestandStand(env, g.gruppe.id, getraenkId);
    await pruefeMindestbestand(env, ctx, g.gruppe.id, getraenkId, stand);

    anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
    return antwort(request, {
      ok: true, id: buchung.id, cent: p.cent, menge, bestand_danach: stand,
    }, 201);
  },

  // -------------------------------------------------------------------------
  /* Stornieren. Fuenf Minuten fuer den Buchenden selbst, unbegrenzt fuer den
     Gruppenadmin (Entscheidung 15) - aber nur, solange der Monat der Buchung
     noch offen ist. Ist er abgeschlossen, gilt die Gegenbuchung
     (`POST /api/kasse/buchung` mit `gegen`, Entscheidung 31) statt des
     Stornos - ein Storno aendert die alte Zeile, eine abgeschlossene
     Abrechnung darf sich aber nicht mehr aendern. */
  'POST /api/kasse/storno': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const buchungId = Number(daten.buchung);
    if (!Number.isInteger(buchungId) || buchungId <= 0) return fehler(request, 'Welche Buchung?');

    const b = await env.DB.prepare('SELECT * FROM buchung WHERE id = ?').bind(buchungId).first();
    if (!b) return fehler(request, 'Diese Buchung gibt es nicht', 404);

    /* Die Gruppe kommt von der BUCHUNG, nicht vom Rumpf - wie bei Terminen
       und Kommentaren seit Etappe 2 (Nachgereicht #1). Ein erratener Rumpf
       darf keine fremde Buchung stornieren. */
    const g = await inGruppe(request, env, ich, { gruppe: b.gruppe_id }, 'kasse_an');
    if (g instanceof Response) return g;

    const abrechnung = await abrechnungFuer(env, b.gruppe_id, ...jahrMonatAus(b.gebucht_am));
    if (abrechnung) {
      return fehler(request, 'Dieser Monat ist abgerechnet — eine Korrektur läuft als Gegenbuchung im laufenden Monat', 403);
    }

    const admin = istGruppenAdmin(g);
    /* EIN Statement, serverseitige Uhr durchweg - kein `new Date(gebucht_am)`
       in JS, das V8 als Ortszeit laese und das Fenster verschoebe. */
    const r = await env.DB.prepare(`
      UPDATE buchung SET storniert_am = datetime('now'), storniert_von = ?
       WHERE id = ? AND storniert_am IS NULL
         AND (? = 1 OR (user_id = ? AND gebucht_am >= datetime('now', ?)))
       RETURNING getraenk_id, menge
    `).bind(ich.id, buchungId, admin ? 1 : 0, ich.id, `-${STORNO_MINUTEN} minutes`).first();

    if (!r) {
      if (b.storniert_am) return fehler(request, 'Diese Buchung ist schon storniert', 409);
      return fehler(request, 'Das Zeitfenster zum Stornieren ist vorbei', 403);
    }

    /* Der Bestand bekommt sein Bier zurueck - eine AUSGLEICHENDE Zeile, nie
       die alte geloescht, sonst luegt der Bestandsverlauf aus Etappe 6
       rueckwirkend. NICHT bei einer Gegenbuchung (`grund` beginnt mit
       'gegenbuchung:', Entscheidung 31, Etappe 4): die hat nie eine
       `verbrauch`-Zeile erzeugt (sie ruehrt den Bestand bewusst nicht an,
       das Getraenk ist ja bereits getrunken), ein Ausgleich hier erfaende
       ohne Grund Bier - Abnahmefund, live nachgestellt (Bestand fiel um die
       gegengebuchte Menge, ohne dass etwas getrunken wurde). */
    const istGegenbuchung = b.grund && b.grund.startsWith('gegenbuchung:');
    if (!istGegenbuchung) {
      await env.DB.prepare(`
        INSERT INTO bestand (gruppe_id, getraenk_id, menge, art, grund, buchung_id, erfasst_von)
        VALUES (?, ?, ?, 'korrektur', ?, ?, ?)
      `).bind(b.gruppe_id, r.getraenk_id, r.menge, `storno:${buchungId}`, buchungId, ich.id).run();
    }

    const stand = await bestandStand(env, b.gruppe_id, r.getraenk_id);
    await pruefeMindestbestand(env, ctx, b.gruppe_id, r.getraenk_id, stand);

    anstossGruppe(b.gruppe_id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true, bestand_danach: stand });
  },

  // -------------------------------------------------------------------------
  // Eigene Buchungen; der Gruppenadmin sieht alle.
  'GET /api/kasse/historie': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null, 'kasse_an');
    if (g instanceof Response) return g;
    const admin = istGruppenAdmin(g);

    const { results } = await env.DB.prepare(`
      SELECT b.id, b.getraenk_id, d.name AS getraenk, b.user_id, u.name AS wer,
             b.menge, b.cent, b.gebucht_am, b.storniert_am
        FROM buchung b JOIN getraenk d ON d.id = b.getraenk_id JOIN users u ON u.id = b.user_id
       WHERE b.gruppe_id = ?${admin ? '' : ' AND b.user_id = ?'}
       ORDER BY b.gebucht_am DESC LIMIT 200
    `).bind(...(admin ? [g.gruppe.id] : [g.gruppe.id, ich.id])).all();

    return antwort(request, {
      buchungen: results.map(b => ({
        id: b.id, getraenk_id: b.getraenk_id, getraenk: b.getraenk,
        user_id: b.user_id, wer: b.wer, menge: b.menge, cent: b.cent,
        gebucht_am: utc(b.gebucht_am),
        storniert_am: b.storniert_am ? utc(b.storniert_am) : null,
        stornierbar: !b.storniert_am && (admin || (b.user_id === ich.id
          && Date.now() - new Date(utc(b.gebucht_am)).getTime() <= STORNO_MINUTEN * 60000)),
      })),
    });
  },

  // -------------------------------------------------------------------------
  /* Vier Handlungen, eine Route - wie `POST /api/admin/nutzer`: die
     Adminpruefung existiert damit genau einmal. */
  'POST /api/getraenk': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'kasse_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const aktion = String(daten.aktion || '');
    if (!['anlegen', 'umbenennen', 'aktivieren', 'deaktivieren', 'mindest'].includes(aktion)) {
      return fehler(request, "aktion: 'anlegen', 'umbenennen', 'aktivieren', 'deaktivieren' oder 'mindest'");
    }

    if (aktion === 'anlegen') {
      const name = String(daten.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > GETRAENK_NAME_MAX) {
        return fehler(request, `Name: 1 bis ${GETRAENK_NAME_MAX} Zeichen`);
      }
      let zeile;
      try {
        zeile = await env.DB.prepare(
          'INSERT INTO getraenk (gruppe_id, name) VALUES (?, ?) RETURNING id')
          .bind(g.gruppe.id, name).first();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Ein aktives Getränk mit diesem Namen gibt es hier schon', 409);
        }
        throw e;
      }
      await kasseAdminLog(env, ich, g, 'getraenk_angelegt', name);
      anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
      return antwort(request, { ok: true, id: zeile.id }, 201);
    }

    const d = await env.DB.prepare('SELECT id FROM getraenk WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.id), g.gruppe.id).first();
    if (!d) return fehler(request, 'Dieses Getränk gibt es hier nicht', 404);

    if (aktion === 'umbenennen') {
      const name = String(daten.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > GETRAENK_NAME_MAX) {
        return fehler(request, `Name: 1 bis ${GETRAENK_NAME_MAX} Zeichen`);
      }
      try {
        await env.DB.prepare('UPDATE getraenk SET name = ? WHERE id = ?').bind(name, d.id).run();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Ein aktives Getränk mit diesem Namen gibt es hier schon', 409);
        }
        throw e;
      }
    } else if (aktion === 'aktivieren' || aktion === 'deaktivieren') {
      try {
        await env.DB.prepare('UPDATE getraenk SET aktiv = ? WHERE id = ?')
          .bind(aktion === 'aktivieren' ? 1 : 0, d.id).run();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Ein aktives Getränk mit diesem Namen gibt es hier schon', 409);
        }
        throw e;
      }
    } else if (aktion === 'mindest') {
      let mindest = null;
      if (daten.mindest !== null && daten.mindest !== undefined && daten.mindest !== '') {
        mindest = Number(daten.mindest);
        if (!Number.isInteger(mindest) || mindest < 0) {
          return fehler(request, 'mindest: ganze Zahl ab 0, oder leer für keine Warnung');
        }
      }
      await env.DB.prepare('UPDATE getraenk SET mindest = ? WHERE id = ?').bind(mindest, d.id).run();
      // Eine neu gesetzte Schwelle bekommt ihre eigene Pruefung - wer sie
      // gerade erst eingetragen hat, soll nicht bis zur naechsten Buchung
      // auf die erste Warnung warten.
      const stand = await bestandStand(env, g.gruppe.id, d.id);
      await pruefeMindestbestand(env, ctx, g.gruppe.id, d.id, stand);
    }

    await kasseAdminLog(env, ich, g, 'getraenk_' + aktion, String(daten.id));
    anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Preis setzen oder einen noch nicht wirksamen vorgemerkten Preis wieder
     entfernen (Entscheidung 38) - ein bereits eingefrorener Preis in einer
     Buchung wird nie geloescht. */
  'POST /api/preis': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'kasse_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const aktion = String(daten.aktion || 'setzen');
    if (!['setzen', 'entfernen'].includes(aktion)) {
      return fehler(request, "aktion: 'setzen' oder 'entfernen'");
    }

    const d = await env.DB.prepare('SELECT id FROM getraenk WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.getraenk), g.gruppe.id).first();
    if (!d) return fehler(request, 'Dieses Getränk gibt es hier nicht', 404);

    if (aktion === 'entfernen') {
      const p = Number(daten.id);
      if (!Number.isInteger(p) || p <= 0) return fehler(request, 'Welcher Preis?');
      const r = await env.DB.prepare(`
        DELETE FROM preis WHERE id = ? AND getraenk_id = ? AND gueltig_ab > datetime('now')
      `).bind(p, d.id).run();
      if (!r.meta.changes) return fehler(request, 'Diesen vorgemerkten Preis gibt es nicht mehr', 404);
      await kasseAdminLog(env, ich, g, 'preis_entfernt', String(p));
      anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
      return antwort(request, { ok: true });
    }

    const cent = Number(daten.cent);
    if (!Number.isInteger(cent) || cent < 0 || cent > PREIS_CENT_MAX) {
      return fehler(request, `Preis: 0 bis ${PREIS_CENT_MAX} Cent`);
    }
    const p = pruefeGueltigAb(daten.gueltig_ab);
    if (p.fehler) return fehler(request, p.fehler);

    const zeile = await env.DB.prepare(`
      INSERT INTO preis (getraenk_id, cent, gueltig_ab, gesetzt_von) VALUES (?, ?, ?, ?)
      RETURNING id, gueltig_ab
    `).bind(d.id, cent, alsDbZeit(p.d), ich.id).first();

    await kasseAdminLog(env, ich, g, 'preis_gesetzt', d.id + ':' + cent);
    anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true, id: zeile.id, gueltig_ab: utc(zeile.gueltig_ab) }, 201);
  },

  // -------------------------------------------------------------------------
  // Lieferung oder Korrektur (Schwund, Bruch, Spende).
  'POST /api/bestand': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'kasse_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const art = String(daten.art || '');
    if (!['lieferung', 'korrektur'].includes(art)) {
      return fehler(request, "art: 'lieferung' oder 'korrektur'");
    }

    const d = await env.DB.prepare('SELECT id FROM getraenk WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.getraenk), g.gruppe.id).first();
    if (!d) return fehler(request, 'Dieses Getränk gibt es hier nicht', 404);

    const menge = Number(daten.menge);
    if (!Number.isInteger(menge) || menge === 0) {
      return fehler(request, 'menge: eine ganze Zahl ungleich 0');
    }

    let einkauf = null, grund = null;
    if (art === 'lieferung') {
      if (menge < 0) {
        return fehler(request, 'Eine Lieferung senkt den Bestand nicht — dafür gibt es die Korrektur');
      }
      /* Pflicht, nicht freiwillig (Entscheidung 32): "jeder Einkauf muss
         eingetragen werden, sonst luegt der Stand" - der Kassenstand aus
         Etappe 6 kann eine hier fehlende Zahl nicht nachtraeglich
         rekonstruieren, die Quittung ist dann weg. 0 ist ein gueltiger Wert
         (eine geschenkte Lieferung), nur das Weglassen nicht. */
      if (daten.einkauf_cent === undefined || daten.einkauf_cent === null || daten.einkauf_cent === '') {
        return fehler(request, 'einkauf_cent: Pflichtfeld bei einer Lieferung, notfalls 0');
      }
      einkauf = Number(daten.einkauf_cent);
      if (!Number.isInteger(einkauf) || einkauf < 0) return fehler(request, 'einkauf_cent: ganze Zahl ab 0');
    } else {
      grund = String(daten.grund ?? '').trim();
      if (!grund) return fehler(request, 'Eine Korrektur braucht einen Grund');
      if (grund.length > BESTAND_GRUND_MAX) return fehler(request, `Grund: höchstens ${BESTAND_GRUND_MAX} Zeichen`);
    }

    await env.DB.prepare(`
      INSERT INTO bestand (gruppe_id, getraenk_id, menge, art, einkauf_cent, grund, erfasst_von)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(g.gruppe.id, d.id, menge, art, einkauf, grund, ich.id).run();

    const stand = await bestandStand(env, g.gruppe.id, d.id);
    await pruefeMindestbestand(env, ctx, g.gruppe.id, d.id, stand);

    await kasseAdminLog(env, ich, g, 'bestand_' + art, d.id + ':' + menge);
    anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true, bestand_danach: stand }, 201);
  },

  // -------------------------------------------------------------------------
  /* Ein Monat: wer, wieviel, welcher Status (Entscheidung 27: alles offen,
     wie die Tafel). Noch nicht abgeschlossen -> eine live gerechnete
     Vorschau (`vorschau: true`) ueber denselben `SALDO_SUMMEN_SQL` wie der
     Abschluss selbst; abgeschlossen -> die eingefrorenen `saldo`-Zeilen. Die
     Bierzahl kommt in BEIDEN Faellen aus `buchung`, nicht aus `saldo` (das
     Schema fuehrt sie dort nicht) - fuer einen abgeschlossenen Monat ist das
     sicher, weil Buchung UND Storno einen abgerechneten Monat ablehnen. */
  'GET /api/abrechnung': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null, 'kasse_an');
    if (g instanceof Response) return g;

    const url = new URL(request.url);
    const jetzt = await env.DB.prepare("SELECT strftime('%Y','now') AS j, strftime('%m','now') AS m").first();
    const jahr = url.searchParams.has('jahr') ? Number(url.searchParams.get('jahr')) : Number(jetzt.j);
    const monat = url.searchParams.has('monat') ? Number(url.searchParams.get('monat')) : Number(jetzt.m);
    if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100
      || !Number.isInteger(monat) || monat < 1 || monat > 12) {
      return fehler(request, 'jahr/monat: ungültig');
    }
    const key = monatSchluessel(jahr, monat);

    // Ob die Gruppe ueberhaupt einen Zahlweg hinterlegt hat - EIN Blick pro
    // Aufruf, damit weder hier noch bei `GET /api/salden` ein Melden-/QR-Knopf
    // fuer eine Gruppe erscheint, die gar keinen anbietet (die Etappe-4-Falle:
    // ein Knopf, der ins Leere fuehrt, faellt beim eigenen curl-Testen nicht
    // auf, weil dort die Id von Hand mitgegeben wird - hier ist es die
    // Existenz eines Zahlwegs).
    const zahlwegeDa = !!(await env.DB.prepare(
      'SELECT 1 FROM zahlweg WHERE gruppe_id = ? LIMIT 1').bind(g.gruppe.id).first());

    const seit = await abrechnungSeit(env, g.gruppe.id);
    /* UND DIE GRENZE GILT HIER, NICHT NUR IN DER OBERFLAECHE. `seit` allein
       waere ein Hinweis an eine wohlwollende Seite; wer eine zehn Minuten alte
       Fassung im Tab hat (GitHub Pages liefert `max-age=600`), ein Lesezeichen
       benutzt oder curl nimmt, bekaeme fuer Dezember 2025 weiterhin eine
       vollstaendige, leere Abrechnung ausgeliefert - als haette es die Runde
       damals gegeben. Genau so ist der Fehler nach dem Ausrollen zurueckgemeldet
       worden.

       409 und nicht 400: die Anfrage ist wohlgeformt, sie passt nur nicht zum
       Zustand dieser Gruppe - dieselbe Lesart wie beim Abschluss eines noch
       laufenden Monats ein paar Zeilen weiter unten. */
    if (seit && key < seit) {
      return fehler(request,
        `Diesen Monat gab es die Runde noch nicht — sie besteht seit ${seit}`, 409);
    }

    /* Die Strafen des Monats, Zeile fuer Zeile (Etappe 8). Sie stehen in
       BEIDEN Zweigen - Vorschau wie Abschluss -, weil sie zum Monat gehoeren
       und nicht zum Saldo: eine Tatstrafe kostet nichts und taucht in keiner
       Saldozeile auf, gehoert aber sichtbar dazu. Nur wenn die Gruppe
       ueberhaupt Regeln fuehrt: bei `regeln_an = 0` gibt es keinen leeren
       Block, sondern gar keinen (Entscheidung 18). */
    const strafen = g.gruppe.regeln_an
      ? (await env.DB.prepare(STRAFEN_MONAT_SQL).bind(g.gruppe.id, key).all()).results
      : [];
    const strafenRaus = strafen.map(s => ({
      id: s.id, user_id: s.user_id, name: s.name, titel: s.titel, art: s.art,
      cent: s.cent, tat: s.tat, grund: s.grund, status: s.status,
      verhaengt_am: utc(s.verhaengt_am), von: s.von_name,
      gutschrift_zu: s.bezug_strafe_id,
    }));

    const a = await abrechnungFuer(env, g.gruppe.id, jahr, monat);
    const { results: summen } = await env.DB.prepare(SALDO_SUMMEN_SQL)
      .bind(...saldoSummenWerte(g.gruppe.id, key)).all();

    if (!a) {
      return antwort(request, {
        jahr, monat, vorschau: true, status: 'offen', zahlwege_da: zahlwegeDa,
        // Der Boden des Blaetterers - siehe oben bei `seit`.
        seit,
        strafen: strafenRaus,
        eintraege: summen.map(r => ({
          user_id: r.user_id, name: r.name, biere: r.biere, cent: r.cent,
          strafe_cent: r.strafe_cent, ehemalig: !!r.ehemalig,
        })),
      });
    }

    // Die Bierzahl kommt aus `buchung`, nicht aus `saldo` (das Schema
    // fuehrt sie dort nicht) - fuer einen abgeschlossenen Monat ist das
    // sicher, weil Buchung UND Storno einen abgerechneten Monat ablehnen.
    // Dasselbe gilt seit Etappe 8 fuer den Strafenanteil.
    const biereJe = new Map(summen.map(r => [r.user_id, r.biere]));
    const strafeJe = new Map(summen.map(r => [r.user_id, r.strafe_cent]));

    const { results } = await env.DB.prepare(SALDO_ZEILEN_SQL).bind(g.gruppe.id, a.id).all();

    return antwort(request, {
      jahr, monat, vorschau: false, status: 'abgeschlossen', zahlwege_da: zahlwegeDa,
      // Auch hier - der Blaetterer braucht seinen Boden in JEDER Antwort, sonst
      // verloere er ihn, sobald man auf einem abgeschlossenen Monat landet.
      seit,
      strafen: strafenRaus,
      eintraege: results.map(r => ({
        id: r.id, user_id: r.user_id, name: r.name, biere: biereJe.get(r.user_id) ?? 0,
        cent: r.betrag_cent, strafe_cent: strafeJe.get(r.user_id) ?? 0,
        gezahlt_cent: r.gezahlt_cent, offen_cent: r.betrag_cent - r.gezahlt_cent,
        status: r.status, gemeldet_am: r.gemeldet_am ? utc(r.gemeldet_am) : null,
        bestaetigt_am: r.bestaetigt_am ? utc(r.bestaetigt_am) : null, ehemalig: !r.drin,
      })),
    });
  },

  // -------------------------------------------------------------------------
  /* Monat festschreiben. Nur ein in UTC VOLLSTAENDIG abgelaufener Monat darf
     abgeschlossen werden - schloesse man den laufenden, faellt jede Buchung
     danach (`gebucht_am` ist stets Server-Jetzt) sofort in einen bereits
     abgeschlossenen Monat. Diese Regel haelt die Aggregation rennfrei: in
     einen abgelaufenen Monat kann keine neue Buchung mehr fallen (siehe die
     Guards in Buchung/Storno/Gegenbuchung oben). */
  'POST /api/abrechnung/abschluss': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'kasse_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const jahr = Number(daten.jahr);
    const monat = Number(daten.monat);
    if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100
      || !Number.isInteger(monat) || monat < 1 || monat > 12) {
      return fehler(request, 'jahr/monat: ungültig');
    }
    const key = monatSchluessel(jahr, monat);

    /* Die Untergrenze, dieselbe wie beim Abruf. Sie steht HIER und nicht nur
       dort, weil erst dieser Ruf Folgen hat: ohne sie liesse sich ein Dezember
       2025 abschliessen, den es fuer diese Runde nie gab - eine `abrechnung`-
       Zeile ohne Salden, die danach fuer immer in der Buchhaltung steht und
       (ueber den vierten Zweig von `abrechnungSeit`) den Boden selbst nach
       hinten zieht. Ein Fehler, der sich beim Begehen festschreibt. */
    const seit = await abrechnungSeit(env, g.gruppe.id);
    if (seit && key < seit) {
      return fehler(request,
        `Diesen Monat gab es die Runde noch nicht — sie besteht seit ${seit}`, 409);
    }

    const jetzt = await env.DB.prepare("SELECT strftime('%Y-%m','now') AS m").first();
    if (key >= jetzt.m) {
      return fehler(request, 'Dieser Monat ist noch nicht vorbei (UTC) — Abschluss ab dem 1.', 409);
    }

    /* Die Zeile entsteht SOFORT als 'abgeschlossen', nie als 'offen' - der
       UNIQUE-Index `abrechnung_monat` ist die ganze Sperre gegen einen
       doppelten Abschluss (siehe migrations/0035). */
    let a;
    try {
      a = await env.DB.prepare(`
        INSERT INTO abrechnung (gruppe_id, jahr, monat, status, abgeschlossen_am, abgeschlossen_von)
        VALUES (?, ?, ?, 'abgeschlossen', datetime('now'), ?) RETURNING id
      `).bind(g.gruppe.id, jahr, monat, ich.id).first();
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return fehler(request, 'Dieser Monat ist schon abgerechnet', 409);
      }
      throw e;
    }

    await env.DB.prepare(SALDO_INSERT_SQL).bind(a.id, ...saldoSummenWerte(g.gruppe.id, key)).run();

    /* Die Geldstrafen des Monats sind gerade in die Salden geflossen (Ent-
       scheidung 50) - jetzt tragen sie es auch selbst. Damit ist "schon
       abgerechnet" eine Tatsache und keine Rechnung ueber Daten: der Guard
       gegen ein nachtraegliches Erlassen (52) fragt `abrechnung_id`, nicht
       das Datum.

       NACH dem Saldo-INSERT, nicht davor - `SALDO_SUMMEN_SQL` zaehlt zwar
       'offen' UND 'abgerechnet' und waere gegen die Reihenfolge unempfindlich,
       aber die zeitliche Ordnung soll die fachliche sein: erst fliesst das
       Geld in den Saldo, dann ist die Strafe abgerechnet.

       TATSTRAFEN BLEIBEN UNBERUEHRT. Sie kosten kein Geld, gehoeren in keinen
       Saldo und laufen ueber den Monatswechsel hinweg weiter, bis sie erledigt
       oder erlassen sind - `art = 'geld'` ist deshalb kein Beiwerk. */
    await env.DB.prepare(`
      UPDATE strafe SET status = 'abgerechnet', abrechnung_id = ?
       WHERE gruppe_id = ? AND art = 'geld' AND status = 'offen'
         AND strftime('%Y-%m', verhaengt_am) = ?
    `).bind(a.id, g.gruppe.id, key).run();

    await kasseAdminLog(env, ich, g, 'monat_abgeschlossen', key);
    anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true, id: a.id }, 201);
  },

  // -------------------------------------------------------------------------
  // CSV eines ABGESCHLOSSENEN Monats - eine Vorschau exportiert man nicht,
  // ein Dokument, dem ein spaeterer Abschluss widersprechen kann, ist
  // schlechter als keins.
  'GET /api/abrechnung/csv': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null, 'kasse_an');
    if (g instanceof Response) return g;

    const url = new URL(request.url);
    const jahr = Number(url.searchParams.get('jahr'));
    const monat = Number(url.searchParams.get('monat'));
    if (!Number.isInteger(jahr) || !Number.isInteger(monat) || monat < 1 || monat > 12) {
      return fehler(request, 'jahr/monat: ungültig');
    }
    const key = monatSchluessel(jahr, monat);
    const a = await abrechnungFuer(env, g.gruppe.id, jahr, monat);
    if (!a) return fehler(request, 'Dieser Monat ist noch nicht abgerechnet', 404);

    const { results: summen } = await env.DB.prepare(SALDO_SUMMEN_SQL).bind(...saldoSummenWerte(g.gruppe.id, key)).all();
    const biereJe = new Map(summen.map(r => [r.user_id, r.biere]));
    const strafeJe = new Map(summen.map(r => [r.user_id, r.strafe_cent]));

    const { results } = await env.DB.prepare(SALDO_ZEILEN_SQL).bind(g.gruppe.id, a.id).all();
    const { results: strafen } = await env.DB.prepare(STRAFEN_MONAT_SQL)
      .bind(g.gruppe.id, key).all();

    // BOM: sonst zerlegt Excel die Umlaute. `;` als Trennzeichen: die
    // Betraege tragen ein Dezimalkomma, das erzwingt das Semikolon.
    let text = '\uFEFF';
    text += csvZeile(['Name', 'Rolle', 'Biere', 'Betrag', 'davon Strafen', 'Gezahlt', 'Offen',
                      'Status', 'Gemeldet am', 'Bestätigt am']);
    let sBiere = 0, sBetrag = 0, sStrafe = 0, sGezahlt = 0, sOffen = 0;
    for (const r of results) {
      const biere = biereJe.get(r.user_id) ?? 0;
      const strafeCent = strafeJe.get(r.user_id) ?? 0;
      const offen = r.betrag_cent - r.gezahlt_cent;
      sBiere += biere; sBetrag += r.betrag_cent; sStrafe += strafeCent;
      sGezahlt += r.gezahlt_cent; sOffen += offen;
      text += csvZeile([
        r.name, r.drin ? 'Mitglied' : 'Ehemaliger', biere,
        centStr(r.betrag_cent), centStr(strafeCent), centStr(r.gezahlt_cent), centStr(offen),
        r.status, r.gemeldet_am ? utc(r.gemeldet_am) : '', r.bestaetigt_am ? utc(r.bestaetigt_am) : '',
      ]);
    }
    text += csvZeile(['Summe', '', sBiere, centStr(sBetrag), centStr(sStrafe),
                      centStr(sGezahlt), centStr(sOffen), '', '', '']);

    /* Ein ZWEITER Block unter dem ersten, durch eine Leerzeile getrennt: die
       einzelnen Strafen des Monats (Etappe 8). Nicht als weitere Spalten oben -
       eine Strafe gehoert zu EINER Person, aber eine Person kann mehrere haben,
       und Tatstrafen tragen ueberhaupt keinen Betrag. Zwei Bloecke mit je
       eigener Kopfzeile lesen sich in jedem Tabellenprogramm; eine Spalte, die
       je nach Zeile etwas anderes bedeutet, liest sich nirgends.

       `titel` und `grund` sind Freitext und tragen regelmaessig Kommas und
       Semikolons - `csvFeld()` quotet, das ist genau sein Zweck. */
    if (strafen.length) {
      text += '\r\n';
      text += csvZeile(['Strafen']);
      text += csvZeile(['Name', 'Regel', 'Art', 'Betrag', 'Auflage', 'Grund', 'Status',
                        'Verhängt am', 'Verhängt von']);
      for (const s of strafen) {
        text += csvZeile([
          s.name, s.titel, s.art === 'geld' ? 'Geld' : 'Tat',
          s.art === 'geld' ? centStr(s.cent ?? 0) : '', s.tat || '', s.grund || '',
          s.status, utc(s.verhaengt_am), s.von_name || '',
        ]);
      }
    }

    // `slugAus()` liefert garantiert `[a-z0-9-]{1,40}` - kein
    // `filename*=UTF-8''`-Tanz noetig.
    const dateiname = `beerstock-${g.gruppe.slug}-${jahr}-${String(monat).padStart(2, '0')}.csv`;
    return new Response(text, {
      headers: {
        ...koepfe(request),
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${dateiname}"`,
        'Cache-Control': 'no-store',
      },
    });
  },

  // -------------------------------------------------------------------------
  /* Meine offenen Salden ueber ALLE Gruppen, auch verlassene (Entscheidung
     29) - bewusst OHNE `inGruppe()`. Gefiltert wird ueber GELD
     (`betrag_cent - gezahlt_cent > 0`), nicht ueber eine Statusliste: Status
     und Betrag sind zwei Achsen (22, 23), eine aufgezaehlte Liste vergisst
     irgendwann einen Zustand. Ein Guthaben (Rest negativ oder 0) faellt so
     von selbst heraus, ohne dass irgendwo gekappt wird. */
  'GET /api/salden': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const { results } = await env.DB.prepare(`
      SELECT s.id, s.betrag_cent, s.gezahlt_cent, s.status, s.gemeldet_am,
             a.jahr, a.monat, a.gruppe_id, gr.name AS gruppe,
             EXISTS(SELECT 1 FROM gruppen_mitglied m
                     WHERE m.gruppe_id = a.gruppe_id AND m.user_id = s.user_id) AS drin,
             -- ob DIESE Gruppe ueberhaupt einen Zahlweg hinterlegt hat - ohne
             -- diesen Blick wuerde die Seite einen Melden-/QR-Knopf fuer eine
             -- Gruppe zeichnen, die gar keinen anbietet (Etappe-4-Falle).
             EXISTS(SELECT 1 FROM zahlweg z WHERE z.gruppe_id = a.gruppe_id) AS zahlwege_da
        FROM saldo s
        JOIN abrechnung a ON a.id = s.abrechnung_id
        JOIN gruppen gr   ON gr.id = a.gruppe_id
       WHERE s.user_id = ? AND s.betrag_cent - s.gezahlt_cent > 0
       ORDER BY a.jahr DESC, a.monat DESC
    `).bind(ich.id).all();

    return antwort(request, {
      salden: results.map(r => ({
        id: r.id, gruppe_id: r.gruppe_id, gruppe: r.gruppe, jahr: r.jahr, monat: r.monat,
        cent: r.betrag_cent, gezahlt_cent: r.gezahlt_cent, offen_cent: r.betrag_cent - r.gezahlt_cent,
        status: r.status, gemeldet_am: r.gemeldet_am ? utc(r.gemeldet_am) : null, ehemalig: !r.drin,
        zahlwege_da: !!r.zahlwege_da,
      })),
    });
  },

  // -------------------------------------------------------------------------
  // "Habe bezahlt" - fuer ein Mitglied UND einen Ausgetretenen (dessen
  // `gruppen_mitglied`-Zeile ist schon weg). Der Besitzcheck IST
  // `id = ? AND user_id = ?`, dieselbe Antwort fuer "gibt es nicht" und
  // "nicht deiner", wie bei `inGruppe()`.
  'POST /api/saldo/meldung': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const saldoId = Number(daten.saldo);
    if (!Number.isInteger(saldoId) || saldoId <= 0) return fehler(request, 'Welcher Saldo?');

    let notiz = null;
    if (daten.notiz !== undefined && daten.notiz !== null) {
      notiz = String(daten.notiz).trim() || null;
      if (notiz && notiz.length > SALDO_NOTIZ_MAX) return fehler(request, `Notiz: höchstens ${SALDO_NOTIZ_MAX} Zeichen`);
    }

    const alt = await env.DB.prepare(
      'SELECT id, abrechnung_id, status FROM saldo WHERE id = ? AND user_id = ?')
      .bind(saldoId, ich.id).first();
    if (!alt) return fehler(request, 'Diesen Saldo gibt es nicht', 404);

    const r = await env.DB.prepare(`
      UPDATE saldo SET status = 'gemeldet', gemeldet_am = datetime('now')
       WHERE id = ? AND status IN ('offen','abgelehnt','teilbezahlt') AND betrag_cent - gezahlt_cent > 0
       RETURNING id
    `).bind(saldoId).first();
    if (!r) return fehler(request, 'Dieser Saldo lässt sich gerade nicht melden', 409);

    await env.DB.prepare(
      'INSERT INTO saldo_log (saldo_id, alt, neu, von, notiz) VALUES (?, ?, ?, ?, ?)')
      .bind(saldoId, alt.status, 'gemeldet', ich.id, notiz).run();

    const a = await env.DB.prepare('SELECT gruppe_id FROM abrechnung WHERE id = ?').bind(alt.abrechnung_id).first();
    anstossGruppe(a.gruppe_id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Betrag bestaetigen oder eine Meldung zurueckweisen. Die Gruppe kommt vom
     SALDO, nicht vom Rumpf (Nachgereicht #1) - und bewusst OHNE
     `kasse_an`-Schalter: ein abgeschaltetes `kasse_an` heisst "wir fuehren
     gerade keine Kasse", nicht "niemand kann begleichen, was er schon
     schuldet". */
  'POST /api/saldo/bestaetigung': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    const saldoId = Number(daten.saldo);
    if (!Number.isInteger(saldoId) || saldoId <= 0) return fehler(request, 'Welcher Saldo?');

    const s = await env.DB.prepare(
      'SELECT id, abrechnung_id, betrag_cent, gezahlt_cent, status FROM saldo WHERE id = ?')
      .bind(saldoId).first();
    if (!s) return fehler(request, 'Diesen Saldo gibt es nicht', 404);
    const a = await env.DB.prepare('SELECT gruppe_id FROM abrechnung WHERE id = ?').bind(s.abrechnung_id).first();

    const g = await inGruppe(request, env, ich, { gruppe: a.gruppe_id });
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const aktion = String(daten.aktion || 'bestaetigen');
    if (!['bestaetigen', 'ablehnen'].includes(aktion)) {
      return fehler(request, "aktion: 'bestaetigen' oder 'ablehnen'");
    }

    if (aktion === 'ablehnen') {
      if (s.status !== 'gemeldet') return fehler(request, 'Nur eine gemeldete Zahlung lässt sich zurückweisen', 409);
      const notiz = String(daten.notiz ?? '').trim();
      if (!notiz) return fehler(request, 'Eine Ablehnung braucht einen Grund');
      if (notiz.length > SALDO_NOTIZ_MAX) return fehler(request, `Notiz: höchstens ${SALDO_NOTIZ_MAX} Zeichen`);

      // Optimistische Sperre: nur, wenn die Zeile noch im gelesenen Zustand
      // ist - sonst haetten zwei gleichzeitige Klicks dieselbe Meldung
      // zweimal verbucht.
      const r = await env.DB.prepare(`
        UPDATE saldo SET status = 'abgelehnt' WHERE id = ? AND status = ? AND gezahlt_cent = ? RETURNING id
      `).bind(saldoId, s.status, s.gezahlt_cent).first();
      if (!r) return fehler(request, 'Der Stand hat sich gerade geändert', 409);

      await env.DB.prepare(
        'INSERT INTO saldo_log (saldo_id, alt, neu, von, notiz) VALUES (?, ?, ?, ?, ?)')
        .bind(saldoId, s.status, 'abgelehnt', ich.id, notiz).run();

      await kasseAdminLog(env, ich, g, 'saldo_abgelehnt', String(saldoId));
      anstossGruppe(a.gruppe_id, request, env, ctx, 'kasse');
      return antwort(request, { ok: true });
    }

    // Barzahlung ohne vorherige Meldung ist ausdruecklich erlaubt (§2.6) -
    // keine Statusvorbedingung ausser einem tatsaechlich offenen Rest.
    const rest = s.betrag_cent - s.gezahlt_cent;
    if (rest <= 0) return fehler(request, 'Dieser Saldo ist bereits ausgeglichen', 409);
    const cent = Number(daten.cent);
    if (!Number.isInteger(cent) || cent <= 0) return fehler(request, 'cent: ganze Zahl größer 0');
    if (cent > rest) return fehler(request, `Höchstens ${rest} Cent sind noch offen`);

    const gezahltDanach = s.gezahlt_cent + cent;
    const statusDanach = gezahltDanach >= s.betrag_cent ? 'bezahlt' : 'teilbezahlt';
    let notiz = null;
    if (daten.notiz !== undefined && daten.notiz !== null) {
      notiz = String(daten.notiz).trim() || null;
      if (notiz && notiz.length > SALDO_NOTIZ_MAX) return fehler(request, `Notiz: höchstens ${SALDO_NOTIZ_MAX} Zeichen`);
    }

    const r = await env.DB.prepare(`
      UPDATE saldo SET gezahlt_cent = ?, status = ?, bestaetigt_am = datetime('now'), bestaetigt_von = ?
       WHERE id = ? AND status = ? AND gezahlt_cent = ? RETURNING id
    `).bind(gezahltDanach, statusDanach, ich.id, saldoId, s.status, s.gezahlt_cent).first();
    if (!r) return fehler(request, 'Der Stand hat sich gerade geändert', 409);

    await env.DB.prepare(
      'INSERT INTO saldo_log (saldo_id, alt, neu, cent, von, notiz) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(saldoId, s.status, statusDanach, cent, ich.id, notiz).run();

    await kasseAdminLog(env, ich, g, 'saldo_bestaetigt', `${saldoId}:${cent}`);
    anstossGruppe(a.gruppe_id, request, env, ctx, 'kasse');
    return antwort(request, {
      ok: true, gezahlt_cent: gezahltDanach, offen_cent: s.betrag_cent - gezahltDanach, status: statusDanach,
    });
  },

  // -------------------------------------------------------------------------
  // Hausordnung und Strafen (Schema 38, Etappe 8) — Entscheidungen 45-56
  // -------------------------------------------------------------------------

  /* Die Hausordnung UND das Suendenregister in einem Ruf. Fuer jedes Mitglied,
     namentlich (Entscheidung 54) - wie die offenen Betraege seit Entscheidung
     27: die Strichliste am Tresen haengt auch fuer alle sichtbar da.

     `?monat=YYYY-MM` waehlt den Monat der Liste, Vorgabe ist der laufende -
     dieselbe Bauweise wie die Kassenbilder aus Etappe 6.

     ZWEI LISTEN, und die zweite ist keine Doppelung: `strafen` ist der
     gewaehlte Monat, `offen_alt` sind die noch nicht erledigten aus ANDEREN
     Monaten. Eine Tatstrafe laeuft ueber den Monatswechsel hinweg weiter
     (sie kostet kein Geld, also holt sie kein Abschluss ab) - ohne die zweite
     Liste verschwaende sie am Monatsersten aus dem Blick, ohne erledigt zu
     sein. */
  'GET /api/hausordnung': async (request, env) => {
    const ich = await nutzer(request, env);
    const g = await inGruppe(request, env, ich, null, 'regeln_an');
    if (g instanceof Response) return g;

    const url = new URL(request.url);
    const jetzt = await env.DB.prepare("SELECT strftime('%Y-%m','now') AS m").first();
    const monat = url.searchParams.get('monat') || jetzt.m;
    if (!/^\d{4}-\d{2}$/.test(monat)) return fehler(request, 'monat: YYYY-MM');

    /* Der Admin sieht auch die abgeschalteten Regeln - er muss sie wieder
       einschalten koennen, und eine Regel, unter der schon jemand belangt
       wurde, bleibt ohnehin fuer immer stehen (Entscheidung 47). Ein Mitglied
       sieht nur, was gilt: eine Hausordnung mit durchgestrichenen Zeilen ist
       keine. */
    const nurAktiv = istGruppenAdmin(g) ? '' : ' AND aktiv = 1';
    const { results: regeln } = await env.DB.prepare(`
      SELECT id, titel, text, art, cent, tat, aktiv, reihenfolge
        FROM hausregel WHERE gruppe_id = ?${nurAktiv}
       ORDER BY aktiv DESC, reihenfolge, titel
    `).bind(g.gruppe.id).all();

    const { results: strafen } = await env.DB.prepare(STRAFEN_MONAT_SQL)
      .bind(g.gruppe.id, monat).all();

    const { results: altOffen } = await env.DB.prepare(`
      SELECT s.id, s.user_id, u.name, s.titel, s.art, s.cent, s.tat, s.grund, s.status,
             s.verhaengt_am, s.bezug_strafe_id, v.name AS von_name
        FROM strafe s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN users v ON v.id = s.verhaengt_von
       WHERE s.gruppe_id = ? AND s.status IN ('offen','gemeldet','vorgeschlagen','bestritten')
         AND strftime('%Y-%m', s.verhaengt_am) <> ?
       ORDER BY s.verhaengt_am DESC, s.id DESC
    `).bind(g.gruppe.id, monat).all();

    /* Wer überhaupt in Frage kommt. Steht HIER und nicht in einer zweiten
       Route: `index.html` kennt die Mitglieder sonst nur über `/api/stand`,
       und das gibt es bei `tafel_an = 0` gar nicht - eine Kassen- und
       Regelgruppe ohne Tafel könnte dann niemanden benennen. Namen sind in
       dieser Gruppe ohnehin für alle sichtbar (Entscheidungen 27 und 54). */
    const { results: leute } = await env.DB.prepare(`
      SELECT u.id, u.name FROM gruppen_mitglied m JOIN users u ON u.id = m.user_id
       WHERE m.gruppe_id = ? AND u.name IS NOT NULL AND u.entfernt_am IS NULL
       ORDER BY u.name
    `).bind(g.gruppe.id).all();

    return antwort(request, {
      monat,
      mitglieder: leute,
      /* Was DIESER Betrachter darf, damit die Seite keine zweite Rechtelogik
         fuehrt (die zwei Fassungen liefen sonst auseinander wie beinahe
         `naechster_preis`). `kasse_an` steht dabei, weil eine Geldstrafe ohne
         Kasse nirgends landen koennte - die Seite blendet die Wahl dann aus,
         statt in ein 400 zu laufen. */
      darf_verhaengen: istGruppenAdmin(g),
      /* Vorschlagen darf JEDES Mitglied (Etappe 9) - der Unterschied zum
         Verhaengen ist nicht das Recht, sondern der Anfangszustand. Beide
         Auskuenfte kommen von hier, damit die Seite keine zweite Rechtelogik
         fuehrt: zwei Fassungen derselben Regel laufen auseinander. */
      darf_vorschlagen: true,
      geld_moeglich: !!g.gruppe.kasse_an,
      regeln: regeln.map(r => ({
        id: r.id, titel: r.titel, text: r.text, art: r.art,
        cent: r.cent, tat: r.tat, aktiv: !!r.aktiv, reihenfolge: r.reihenfolge,
      })),
      strafen: strafen.map(strafeRaus),
      offen_alt: altOffen.map(strafeRaus),
    });
  },

  // -------------------------------------------------------------------------
  /* Eine Regel anlegen, aendern, ab- und wieder anschalten - EINE Route mit
     Aktionsfeld, wie `POST /api/getraenk`.

     KEIN DELETE, und das ist kein Versehen (Entscheidung 47): unter einer
     Regel kann schon jemand belangt worden sein, und die Strafe zeigt auf sie.
     Sie wird `aktiv = 0` und verschwindet aus der Hausordnung, bleibt aber als
     Herkunft stehen. Der partielle Unique-Index (`WHERE aktiv = 1`) sorgt
     dafuer, dass der Titel danach wieder frei ist. */
  'POST /api/hausregel': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'regeln_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const aktion = String(daten.aktion || 'anlegen');
    if (!['anlegen', 'aendern', 'aus', 'an'].includes(aktion)) {
      return fehler(request, "aktion: 'anlegen', 'aendern', 'aus' oder 'an'");
    }

    /* Titel, Art und Betrag/Auflage in einem Zug pruefen - dieselbe Pruefung
       fuer Anlegen und Aendern, sonst laesst das eine durch, was das andere
       ablehnt. Bei 'aendern' sind alle Felder freiwillig; was fehlt, bleibt. */
    const felder = (basis) => {
      const setzt = {};
      if (daten.titel !== undefined || !basis) {
        const titel = String(daten.titel ?? '').trim().replace(/\s+/g, ' ');
        if (titel.length < 2 || titel.length > REGEL_TITEL_MAX) {
          return { fehler: `Titel: 2 bis ${REGEL_TITEL_MAX} Zeichen` };
        }
        setzt.titel = titel;
      }
      if (daten.text !== undefined) {
        const text = String(daten.text ?? '').trim();
        if (text.length > REGEL_TEXT_MAX) return { fehler: `Text: höchstens ${REGEL_TEXT_MAX} Zeichen` };
        setzt.text = text || null;
      }
      const art = daten.art !== undefined ? String(daten.art) : (basis ? basis.art : null);
      if (!['geld', 'tat'].includes(art)) return { fehler: "art: 'geld' oder 'tat'" };
      setzt.art = art;

      if (art === 'geld') {
        /* Eine Geldregel in einer Gruppe ohne Kasse waere eine Regel, die
           niemand vollstrecken kann - die Strafe daraus haette keinen Saldo,
           in den sie fliessen koennte. Lieber hier eine verstaendliche Absage
           als spaeter eine unerklaerliche. */
        if (!g.gruppe.kasse_an) {
          return { fehler: 'Eine Geldstrafe braucht eine Kasse — schalte sie ein oder nimm eine Auflage' };
        }
        const roh = daten.cent !== undefined ? daten.cent : (basis ? basis.cent : undefined);
        const p = strafeCentPruefen(roh);
        if (p.fehler) return p;
        setzt.cent = p.cent; setzt.tat = null;
      } else {
        const roh = daten.tat !== undefined ? daten.tat : (basis ? basis.tat : '');
        const tat = String(roh ?? '').trim().replace(/\s+/g, ' ');
        if (tat.length < 2 || tat.length > REGEL_TAT_MAX) {
          return { fehler: `Auflage: 2 bis ${REGEL_TAT_MAX} Zeichen` };
        }
        setzt.tat = tat; setzt.cent = null;
      }
      if (daten.reihenfolge !== undefined) {
        const n = Number(daten.reihenfolge);
        if (!Number.isInteger(n) || n < 0 || n > 999) return { fehler: 'reihenfolge: 0 bis 999' };
        setzt.reihenfolge = n;
      }
      return { setzt };
    };

    if (aktion === 'anlegen') {
      const zahl = await env.DB.prepare(
        'SELECT count(*) AS n FROM hausregel WHERE gruppe_id = ? AND aktiv = 1')
        .bind(g.gruppe.id).first();
      if (zahl.n >= REGEL_MAX) {
        return fehler(request, `Höchstens ${REGEL_MAX} Regeln — eine Hausordnung, kein Gesetzbuch`, 409);
      }
      const f = felder(null);
      if (f.fehler) return fehler(request, f.fehler);

      let zeile;
      try {
        zeile = await env.DB.prepare(`
          INSERT INTO hausregel (gruppe_id, titel, text, art, cent, tat, reihenfolge, erstellt_von)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `).bind(g.gruppe.id, f.setzt.titel, f.setzt.text ?? null, f.setzt.art,
                f.setzt.cent ?? null, f.setzt.tat ?? null, f.setzt.reihenfolge ?? 0, ich.id).first();
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Eine Regel mit diesem Titel gibt es schon', 409);
        }
        throw e;
      }
      await kasseAdminLog(env, ich, g, 'regel_angelegt', f.setzt.titel);
      anstossGruppe(g.gruppe.id, request, env, ctx, 'regeln');
      return antwort(request, { ok: true, id: zeile.id }, 201);
    }

    const r = await env.DB.prepare(
      'SELECT * FROM hausregel WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.regel), g.gruppe.id).first();
    // Fremde Regel-Id: dieselbe Antwort wie "gibt es nicht" - eine Regel aus
    // einer anderen Gruppe ist fuer diese keine (Nachgereicht #1).
    if (!r) return fehler(request, 'Diese Regel gibt es hier nicht', 404);

    if (aktion === 'aus' || aktion === 'an') {
      const neu = aktion === 'an' ? 1 : 0;
      try {
        await env.DB.prepare('UPDATE hausregel SET aktiv = ? WHERE id = ?').bind(neu, r.id).run();
      } catch (e) {
        // Beim Wieder-Anschalten kann der Titel inzwischen von einer neueren
        // Regel belegt sein - der partielle Index greift genau dann.
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Der Titel ist inzwischen von einer anderen Regel belegt', 409);
        }
        throw e;
      }
      await kasseAdminLog(env, ich, g, 'regel_' + aktion, r.titel);
      anstossGruppe(g.gruppe.id, request, env, ctx, 'regeln');
      return antwort(request, { ok: true, aktiv: !!neu });
    }

    const f = felder(r);
    if (f.fehler) return fehler(request, f.fehler);
    const spalten = Object.keys(f.setzt);
    if (!spalten.length) return fehler(request, 'Nichts zu ändern');
    try {
      await env.DB.prepare(
        `UPDATE hausregel SET ${spalten.map(s => `${s} = ?`).join(', ')} WHERE id = ?`)
        .bind(...spalten.map(s => f.setzt[s]), r.id).run();
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return fehler(request, 'Eine Regel mit diesem Titel gibt es schon', 409);
      }
      throw e;
    }
    /* KEINE bestehende Strafe wird mitgezogen (Entscheidung 47). Sie hat
       Titel, Art und Betrag beim Verhaengen eingefroren, genau wie
       `buchung.cent` den Preis - eine Preisaenderung darf keine alte
       Abrechnung verschieben, und eine Regelaenderung keine alte Strafe. */
    await kasseAdminLog(env, ich, g, 'regel_geaendert', r.titel);
    anstossGruppe(g.gruppe.id, request, env, ctx, 'regeln');
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Verhaengen (Entscheidung 48: der Gruppenadmin, sonst niemand) - oder eine
     GUTSCHRIFT auf eine schon abgerechnete Strafe (52).

     DREI FREMDSCHLUESSEL kommen hier aus dem Rumpf, und jeder einzelne wird
     gegen die Gruppe geprueft: `regel`, `user` und `gutschrift`. Das ist die
     dichteste Haeufung im ganzen Umbau, und Nachgereicht #1 aus Etappe 1 ist
     genau daran entstanden ("Kein Schreibpfad prueft, ob sein ZIEL zur Gruppe
     gehoert") - eine fremde Id darf hier nicht mit 201 durchkommen und danach
     die falsche `gruppe_id` tragen. */
  'POST /api/strafe': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'regeln_an');
    if (g instanceof Response) return g;

    /* ZWEI AUSGAENGE SEIT ETAPPE 9. Der Gruppenadmin VERHAENGT (Entscheidung
       48), ein Mitglied SCHLAEGT VOR - dieselbe Route, weil es dieselben
       Felder sind und zwei Routen mit demselben Rumpf irgendwann
       auseinanderlaufen. Der Unterschied steckt allein im Anfangszustand:
       'offen' gegen 'vorgeschlagen'.

       Ein Vorschlag zaehlt in keiner Abrechnung mit (`SALDO_SUMMEN_SQL` nimmt
       nur 'offen' und 'abgerechnet') und schickt dem Betroffenen keine Mail -
       er ist noch nichts, was ihn beträfe. */
    const darfVerhaengen = istGruppenAdmin(g);

    // --- Der Gutschrift-Zweig (52): keine neue Strafe, sondern das Gegenstueck
    // zu einer bestehenden. Wie die Gegenbuchung aus Entscheidung 31 - der
    // abgeschlossene Monat bleibt unangetastet, die Korrektur ist sichtbar und
    // faellt in den laufenden.
    if (daten.gutschrift !== undefined) {
      // Eine Gutschrift ist eine Buchhaltungshandlung, kein Vorschlag - die
      // bleibt beim Gruppenadmin.
      if (!darfVerhaengen) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);
      const alt = await env.DB.prepare(
        'SELECT * FROM strafe WHERE id = ? AND gruppe_id = ?')
        .bind(Number(daten.gutschrift), g.gruppe.id).first();
      if (!alt) return fehler(request, 'Diese Strafe gibt es hier nicht', 404);
      if (alt.art !== 'geld') {
        return fehler(request, 'Nur eine Geldstrafe lässt sich gutschreiben — eine Auflage wird erlassen', 409);
      }
      if (alt.status !== 'abgerechnet') {
        return fehler(request,
          'Diese Strafe ist noch nicht abgerechnet — sie lässt sich schlicht erlassen', 409);
      }
      if (alt.bezug_strafe_id) {
        return fehler(request, 'Eine Gutschrift lässt sich nicht noch einmal gutschreiben', 409);
      }

      let zeile;
      try {
        zeile = await env.DB.prepare(`
          INSERT INTO strafe (gruppe_id, regel_id, user_id, titel, art, cent, grund,
                              verhaengt_von, bezug_strafe_id)
          VALUES (?, NULL, ?, ?, 'geld', ?, ?, ?, ?) RETURNING id
        `).bind(g.gruppe.id, alt.user_id, 'Gutschrift: ' + alt.titel, -(alt.cent ?? 0),
                String(daten.grund ?? '').trim().slice(0, STRAFE_GRUND_MAX) || null,
                ich.id, alt.id).first();
      } catch (e) {
        // Der partielle Index `strafe_gutschrift` - ein Doppelklick schriebe
        // sonst zwei und schriebe den Betrag zweimal gut.
        if (String(e.message || '').includes('UNIQUE')) {
          return fehler(request, 'Zu dieser Strafe gibt es schon eine Gutschrift', 409);
        }
        throw e;
      }
      await strafeLog(env, zeile.id, null, 'offen', ich.id, 'Gutschrift zu #' + alt.id);
      await kasseAdminLog(env, ich, g, 'strafe_gutschrift', String(alt.id));
      anstossGruppe(g.gruppe.id, request, env, ctx, 'regeln', 'kasse');
      return antwort(request, { ok: true, id: zeile.id }, 201);
    }

    // --- Der Normalfall: verhaengen.
    const zielId = Number(daten.user);
    if (!Number.isInteger(zielId) || zielId <= 0) return fehler(request, 'Wen trifft es? (`user`)');
    const ziel = await env.DB.prepare(`
      SELECT u.id, u.name FROM gruppen_mitglied m JOIN users u ON u.id = m.user_id
       WHERE m.gruppe_id = ? AND m.user_id = ? AND u.entfernt_am IS NULL
    `).bind(g.gruppe.id, zielId).first();
    // Nicht in dieser Gruppe heisst: geht diese Gruppe nichts an. Dieselbe
    // Antwort fuer "gibt es nicht" und "ist nicht hier".
    if (!ziel) return fehler(request, 'Diese Person ist nicht in dieser Gruppe', 403);

    let titel, art, cent = null, tat = null, regelId = null;
    if (daten.regel !== undefined && daten.regel !== null) {
      const r = await env.DB.prepare(
        'SELECT * FROM hausregel WHERE id = ? AND gruppe_id = ?')
        .bind(Number(daten.regel), g.gruppe.id).first();
      if (!r) return fehler(request, 'Diese Regel gibt es hier nicht', 404);
      if (!r.aktiv) return fehler(request, 'Diese Regel gilt nicht mehr', 409);
      /* HIER wird eingefroren (Entscheidung 47). Ab jetzt darf sich die Regel
         aendern, so oft sie will - diese Strafe bleibt, was sie war. */
      titel = r.titel; art = r.art; cent = r.cent; tat = r.tat; regelId = r.id;
    } else {
      /* Freie Strafe ohne Regel (Entscheidung 49) - sonst muesste der Admin
         fuer jeden Einzelfall eine Regel erfinden, die danach in der
         Hausordnung stehen bleibt.

         NUR FUER DEN, DER DIE GRUPPE FUEHRT. Ein VORSCHLAG muss sich auf eine
         geltende Regel berufen (Etappe 9): sonst duerfte jedes Mitglied
         Titel, Art und Betrag frei erfinden - "Aisha, 99,99 Euro, weil" -,
         und der Admin haette am Ende nur noch die Wahl, Unfug wegzuklicken.
         Die Hausordnung ist der Rahmen, innerhalb dessen vorgeschlagen wird;
         wer den Rahmen selbst setzen will, muss die Gruppe fuehren. */
      if (!darfVerhaengen) {
        return fehler(request,
          'Ein Vorschlag braucht eine Regel — frei verhängen darf nur, wer die Gruppe führt', 403);
      }
      titel = String(daten.titel ?? '').trim().replace(/\s+/g, ' ');
      if (titel.length < 2 || titel.length > REGEL_TITEL_MAX) {
        return fehler(request, `Titel: 2 bis ${REGEL_TITEL_MAX} Zeichen`);
      }
      art = String(daten.art || '');
      if (!['geld', 'tat'].includes(art)) return fehler(request, "art: 'geld' oder 'tat'");
      if (art === 'geld') {
        const p = strafeCentPruefen(daten.cent);
        if (p.fehler) return fehler(request, p.fehler);
        cent = p.cent;
      } else {
        tat = String(daten.tat ?? '').trim().replace(/\s+/g, ' ');
        if (tat.length < 2 || tat.length > REGEL_TAT_MAX) {
          return fehler(request, `Auflage: 2 bis ${REGEL_TAT_MAX} Zeichen`);
        }
      }
    }

    /* Eine Geldstrafe ohne Kasse haette keinen Saldo, in den sie fliessen
       koennte - 400 MIT BEGRUENDUNG, nicht still verschluckt. `regeln_an` und
       `kasse_an` sind unabhaengig (eine Gruppe darf Regeln ohne Kasse
       fuehren), und dann gibt es eben nur Auflagen. */
    if (art === 'geld' && !g.gruppe.kasse_an) {
      return fehler(request, 'Ohne Kasse gibt es kein Strafgeld — schalte sie ein oder nimm eine Auflage');
    }

    const grund = String(daten.grund ?? '').trim();
    if (grund.length > STRAFE_GRUND_MAX) {
      return fehler(request, `Grund: höchstens ${STRAFE_GRUND_MAX} Zeichen`);
    }

    /* Sich selbst vorschlagen darf man - warum auch nicht, wer sich selbst
       anzeigt, meint es ernst. Was NICHT geht: sich selbst eine Strafe
       verhaengen und sie damit an der Entscheidung des Admins vorbeitragen;
       das faellt aber schon durch `darfVerhaengen`. */
    const stand = darfVerhaengen ? 'offen' : 'vorgeschlagen';

    const zeile = await env.DB.prepare(`
      INSERT INTO strafe (gruppe_id, regel_id, user_id, titel, art, cent, tat, grund,
                          verhaengt_von, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, verhaengt_am
    `).bind(g.gruppe.id, regelId, ziel.id, titel, art, cent, tat, grund || null,
            ich.id, stand).first();

    await strafeLog(env, zeile.id, null, stand, ich.id, grund || null);
    if (stand === 'offen') {
      strafeMail(env, ctx, {
        strafe: { id: zeile.id, user_id: ziel.id, titel, art, cent, tat, grund },
        gruppeName: g.gruppe.name, anlass: 'verhaengt',
      });
      await kasseAdminLog(env, ich, g, 'strafe_verhaengt', `${ziel.id}:${titel}`);
    } else {
      // Der Betroffene bekommt (noch) nichts: ein Vorschlag ist keine Strafe.
      // Wer entscheiden muss, bekommt Post.
      einspruchMail(env, ctx, {
        strafe: { id: zeile.id, titel }, gruppeId: g.gruppe.id,
        gruppeName: g.gruppe.name, anlass: 'vorschlag', von: ich.name || 'Jemand',
      });
    }
    // 'kasse' MIT, wenn Geld im Spiel ist: die Abrechnungsansicht zeigt den
    // Strafenblock und muesste sonst auf ihren Minutentakt warten. Ein
    // Vorschlag steht dort noch nicht - er zaehlt nirgends mit.
    anstossGruppe(g.gruppe.id, request, env, ctx,
      ...(art === 'geld' && stand === 'offen' ? ['regeln', 'kasse'] : ['regeln']));
    return antwort(request, { ok: true, id: zeile.id, status: stand }, 201);
  },

  // -------------------------------------------------------------------------
  /* Einspruch (Etappe 9). Der Betroffene widerspricht EINMAL, der Admin
     entscheidet.

     WARUM NUR EINMAL, und wie das geprueft wird: eine gehaltene Strafe
     (`bestritten` -> `offen`) stuende sonst wieder im Ausgangszustand, und
     derselbe Einspruch liesse sich endlos wiederholen. Ein eigenes Flag
     braucht es dafuer nicht - `strafe_log` traegt jeden Wechsel, und ein
     bereits eingetragenes 'bestritten' IST die Auskunft. Kein
     Schemazuwachs, keine zweite Wahrheit.

     EINE BESTRITTENE GELDSTRAFE ZAEHLT IN KEINER ABRECHNUNG MIT
     (`SALDO_SUMMEN_SQL` nimmt nur 'offen' und 'abgerechnet'). Sie blockiert
     den Monatsabschluss auch nicht - sie rollt vorwaerts in den Monat, in dem
     ueber sie entschieden wird (siehe `bescheid`/`halten`). Ein Abschluss, der
     auf eine Entscheidung wartet, waere eine Gruppe, die ihr Admin im Urlaub
     am Abrechnen hindert; das Vorwaertsrollen ist derselbe Weg, den
     Entscheidung 31 fuer jede andere Korrektur schon geht. */
  'POST /api/strafe/einspruch': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'regeln_an');
    if (g instanceof Response) return g;

    const s = await env.DB.prepare(
      'SELECT * FROM strafe WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.strafe), g.gruppe.id).first();
    if (!s) return fehler(request, 'Diese Strafe gibt es hier nicht', 404);
    if (s.user_id !== ich.id) return fehler(request, 'Das ist nicht deine Strafe', 403);

    const grund = String(daten.grund ?? '').trim();
    if (!grund) return fehler(request, 'Ein Einspruch braucht eine Begründung');
    if (grund.length > STRAFE_GRUND_MAX) {
      return fehler(request, `Begründung: höchstens ${STRAFE_GRUND_MAX} Zeichen`);
    }

    const schon = await env.DB.prepare(
      "SELECT 1 FROM strafe_log WHERE strafe_id = ? AND neu = 'bestritten' LIMIT 1")
      .bind(s.id).first();
    if (schon) return fehler(request, 'Gegen diese Strafe hast du schon einmal Einspruch erhoben', 409);

    const r = await env.DB.prepare(`
      UPDATE strafe SET status = 'bestritten' WHERE id = ? AND status = 'offen' RETURNING id
    `).bind(s.id).first();
    if (!r) {
      return fehler(request, s.status === 'abgerechnet'
        ? 'Diese Strafe ist schon abgerechnet — sprich mit dem, der die Gruppe führt'
        : 'Gegen diese Strafe lässt sich gerade kein Einspruch erheben', 409);
    }

    await strafeLog(env, s.id, s.status, 'bestritten', ich.id, grund);
    einspruchMail(env, ctx, {
      strafe: { id: s.id, titel: s.titel }, gruppeId: g.gruppe.id,
      gruppeName: g.gruppe.name, anlass: 'einspruch', von: ich.name || 'Jemand',
    });
    anstossGruppe(g.gruppe.id, request, env, ctx,
      ...(s.art === 'geld' ? ['regeln', 'kasse'] : ['regeln']));
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* „Habe ich erledigt" - nur der Betroffene, nur bei einer Auflage
     (Entscheidung 55). Dieselbe Kette wie beim Saldo: der Betroffene meldet,
     der Admin bestaetigt.

     Geprueft wird gegen `strafe.user_id`, NICHT gegen die Rolle - wie bei
     `POST /api/saldo/meldung`. Eine Geldstrafe kennt kein "erledigt": sie
     wandert in die Abrechnung, und bezahlt wird ueber `saldo`. Zwei
     Buchhaltungen fuer dasselbe Geld gibt es nicht. */
  'POST /api/strafe/meldung': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'regeln_an');
    if (g instanceof Response) return g;

    const s = await env.DB.prepare(
      'SELECT * FROM strafe WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.strafe), g.gruppe.id).first();
    if (!s) return fehler(request, 'Diese Strafe gibt es hier nicht', 404);
    if (s.user_id !== ich.id) return fehler(request, 'Das ist nicht deine Strafe', 403);
    if (s.art === 'geld') {
      return fehler(request, 'Eine Geldstrafe läuft über die Abrechnung, nicht über eine Meldung');
    }

    // Optimistische Sperre wie beim Saldo: nur aus dem gelesenen Zustand
    // heraus, sonst verbuchen zwei gleichzeitige Klicks dasselbe zweimal.
    const r = await env.DB.prepare(`
      UPDATE strafe SET status = 'gemeldet', gemeldet_am = datetime('now')
       WHERE id = ? AND status = 'offen' RETURNING id
    `).bind(s.id).first();
    if (!r) return fehler(request, 'Diese Strafe lässt sich gerade nicht melden', 409);

    await strafeLog(env, s.id, s.status, 'gemeldet', ich.id,
      String(daten.notiz ?? '').trim().slice(0, STRAFE_GRUND_MAX) || null);
    anstossGruppe(g.gruppe.id, request, env, ctx, 'regeln');
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Der Bescheid des Gruppenadmins: erledigt, zurueckgewiesen oder erlassen.
     Jeder Wechsel landet in `strafe_log` (Entscheidung 49) - eine Strafe ist
     der Ort, an dem am meisten diskutiert wird, und das Protokoll ist die
     Antwort darauf. */
  'POST /api/strafe/bescheid': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'regeln_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const s = await env.DB.prepare(
      'SELECT * FROM strafe WHERE id = ? AND gruppe_id = ?')
      .bind(Number(daten.strafe), g.gruppe.id).first();
    if (!s) return fehler(request, 'Diese Strafe gibt es hier nicht', 404);

    const aktion = String(daten.aktion || '');
    if (!['erledigt', 'zurueck', 'erlassen', 'annehmen', 'verwerfen', 'halten'].includes(aktion)) {
      return fehler(request,
        "aktion: 'erledigt', 'zurueck', 'erlassen', 'annehmen', 'verwerfen' oder 'halten'");
    }
    let notiz = String(daten.notiz ?? '').trim();
    if (notiz.length > STRAFE_GRUND_MAX) {
      return fehler(request, `Notiz: höchstens ${STRAFE_GRUND_MAX} Zeichen`);
    }

    /* --- Etappe 9: über einen Vorschlag oder einen Einspruch entscheiden ----
       'annehmen' und 'halten' setzen `verhaengt_am` NEU, und das ist der Kern
       der Sache: dieses Feld bestimmt den Abrechnungsmonat (Entscheidung 51).
       Ein Vorschlag vom 28. Juli, der am 3. August angenommen wird, ist eine
       Strafe des AUGUST - der Juli kann längst abgeschlossen sein, und eine
       Strafe, die in einen geschlossenen Monat fiele, landete in keinem Saldo
       und wäre stillschweigend verschenkt.

       Dasselbe beim gehaltenen Einspruch. Es ist derselbe Weg, den
       Entscheidung 31 für jede Korrektur geht: nichts wird rückdatiert, alles
       rollt vorwärts. Das alte Datum steht in `strafe_log`. */
    if (aktion === 'annehmen' || aktion === 'verwerfen') {
      if (s.status !== 'vorgeschlagen') {
        return fehler(request, 'Das ist kein offener Vorschlag mehr', 409);
      }
      const neu = aktion === 'annehmen' ? 'offen' : 'verworfen';
      const r = await env.DB.prepare(`
        UPDATE strafe
           SET status = ?,
               verhaengt_am = CASE WHEN ? = 'offen' THEN datetime('now') ELSE verhaengt_am END,
               verhaengt_von = CASE WHEN ? = 'offen' THEN ? ELSE verhaengt_von END
         WHERE id = ? AND status = 'vorgeschlagen' RETURNING id
      `).bind(neu, neu, neu, ich.id, s.id).first();
      if (!r) return fehler(request, 'Der Stand hat sich gerade geändert', 409);

      await strafeLog(env, s.id, s.status, neu, ich.id, notiz || null);
      // Erst jetzt erfährt der Betroffene davon - vorher war es nur ein
      // Vorschlag, und ein Vorschlag ist keine Strafe.
      if (neu === 'offen') {
        strafeMail(env, ctx, {
          strafe: { id: s.id, user_id: s.user_id, titel: s.titel, art: s.art, cent: s.cent,
                    tat: s.tat, grund: s.grund },
          gruppeName: g.gruppe.name, anlass: 'verhaengt',
        });
      }
      await kasseAdminLog(env, ich, g, 'strafe_' + aktion, String(s.id));
      anstossGruppe(g.gruppe.id, request, env, ctx,
        ...(s.art === 'geld' ? ['regeln', 'kasse'] : ['regeln']));
      return antwort(request, { ok: true });
    }

    if (aktion === 'halten') {
      if (s.status !== 'bestritten') {
        return fehler(request, 'Gegen diese Strafe läuft gerade kein Einspruch', 409);
      }
      const r = await env.DB.prepare(`
        UPDATE strafe SET status = 'offen', verhaengt_am = datetime('now')
         WHERE id = ? AND status = 'bestritten' RETURNING id
      `).bind(s.id).first();
      if (!r) return fehler(request, 'Der Stand hat sich gerade geändert', 409);

      await strafeLog(env, s.id, s.status, 'offen', ich.id, notiz || null);
      await kasseAdminLog(env, ich, g, 'strafe_gehalten', String(s.id));
      anstossGruppe(g.gruppe.id, request, env, ctx,
        ...(s.art === 'geld' ? ['regeln', 'kasse'] : ['regeln']));
      return antwort(request, { ok: true });
    }

    if (aktion === 'erledigt' || aktion === 'zurueck') {
      if (s.art !== 'tat') {
        return fehler(request, 'Das gilt nur für eine Auflage — eine Geldstrafe läuft über die Abrechnung', 400);
      }
      if (aktion === 'zurueck') {
        if (s.status !== 'gemeldet') {
          return fehler(request, 'Nur eine gemeldete Auflage lässt sich zurückweisen', 409);
        }
        if (!notiz) return fehler(request, 'Eine Zurückweisung braucht einen Grund');
        const r = await env.DB.prepare(`
          UPDATE strafe SET status = 'offen', gemeldet_am = NULL
           WHERE id = ? AND status = 'gemeldet' RETURNING id
        `).bind(s.id).first();
        if (!r) return fehler(request, 'Der Stand hat sich gerade geändert', 409);
        await strafeLog(env, s.id, s.status, 'offen', ich.id, notiz);
      } else {
        const r = await env.DB.prepare(`
          UPDATE strafe SET status = 'erledigt', erledigt_am = datetime('now'), erledigt_von = ?
           WHERE id = ? AND status IN ('offen','gemeldet') RETURNING id
        `).bind(ich.id, s.id).first();
        if (!r) return fehler(request, 'Diese Auflage ist schon vom Tisch', 409);
        await strafeLog(env, s.id, s.status, 'erledigt', ich.id, notiz || null);
      }
      await kasseAdminLog(env, ich, g, 'strafe_' + aktion, String(s.id));
      anstossGruppe(g.gruppe.id, request, env, ctx, 'regeln');
      return antwort(request, { ok: true });
    }

    /* Erlassen. Der eine Fall, in dem es NICHT geht: die Geldstrafe ist schon
       abgerechnet (Entscheidung 52). Ein abgeschlossener Monat bleibt
       unangetastet - sonst stimmte eine verschickte Abrechnung nicht mehr mit
       dem ueberein, was die Seite zeigt. Der Weg ist dann die Gutschrift im
       laufenden Monat, und die Fehlermeldung sagt das auch. */
    if (s.status === 'abgerechnet') {
      return fehler(request,
        'Diese Strafe ist schon abgerechnet — der Weg ist eine Gutschrift im laufenden Monat', 409);
    }
    /* Erlassen kann man nur, was noch gilt. 'bestritten' gehört ausdrücklich
       dazu (Etappe 9): dem Einspruch stattzugeben IST ein Erlass, und einen
       zweiten Ausgang dafür zu erfinden hieße, dieselbe Sache zweimal zu
       nennen. Was nicht mehr gilt - erledigt, erlassen, verworfen -, lässt
       sich nicht noch einmal erlassen; ohne diese Zeile setzte ein zweiter
       Klick den Status stumpf auf denselben Wert und schriebe eine
       Protokollzeile, die nichts bedeutet.

       'vorgeschlagen' gehört NICHT dazu (Abnahmefund Etappe 9): ein Vorschlag
       ist noch keine Strafe, sein Ausgang heißt 'verwerfen'. Stand er hier
       mit drin, ging gleich darunter unbesehen die Erlass-Mail an den
       Betroffenen — und die wäre die erste Nachricht, die er zu der Sache
       überhaupt bekäme, denn `POST /api/strafe` schweigt beim Vorschlag mit
       Absicht. Eine Mail „die Sache ist vom Tisch" über eine Sache, von der
       er nie gehört hat. Die Meldung nennt darum den Weg, wie es diese Route
       auch beim abgerechneten Fall darüber tut. */
    if (s.status === 'vorgeschlagen') {
      return fehler(request,
        'Das ist noch ein Vorschlag — nimm ihn an oder verwirf ihn', 409);
    }
    if (!['offen', 'gemeldet', 'bestritten'].includes(s.status)) {
      return fehler(request, 'Diese Strafe ist schon vom Tisch', 409);
    }
    const r = await env.DB.prepare(`
      UPDATE strafe SET status = 'erlassen' WHERE id = ? AND status = ? RETURNING id
    `).bind(s.id, s.status).first();
    if (!r) return fehler(request, 'Der Stand hat sich gerade geändert', 409);

    await strafeLog(env, s.id, s.status, 'erlassen', ich.id, notiz || null);
    strafeMail(env, ctx, {
      strafe: { id: s.id, user_id: s.user_id, titel: s.titel, art: s.art, cent: s.cent, tat: s.tat },
      gruppeName: g.gruppe.name, anlass: 'erlassen',
    });
    await kasseAdminLog(env, ich, g, 'strafe_erlassen', String(s.id));
    anstossGruppe(g.gruppe.id, request, env, ctx, ...(s.art === 'geld' ? ['regeln', 'kasse'] : ['regeln']));
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Zwei Pfade, die sich gegenseitig ausschliessen (Opus-Konsultation vor der
     Festlegung, 2026-08-11 - der Plan nannte nur `?g=` und liesse einen
     Ausgetretenen damit ohne Zahlwege da stehen, obwohl `qr.svg` ihm schon
     einen QR-Code ausstellt):

     `?saldo=` - Besitz ueber `saldoBesitz()`, KEIN `inGruppe()`, KEIN
     `kasse_an` - fuer `index.html` (aktives Mitglied) UND `start.html`
     (Ausgetretener). Liefert Betrag und fertigen Verwendungszweck mit.

     `?g=` - Mitgliedschaft mit `kasse_an`, wie urspruenglich im Plan - nur
     noch fuer die Pflegeansicht in `gruppe.html`. Ohne Saldo im Kontext bleibt
     `offen_cent`/`zweck` `null`, PayPal-Links tragen keinen Betrag, und `bank`
     traegt keinen `qr`-Pfad (der braucht einen echten Saldo). */
  'GET /api/zahlwege': async (request, env) => {
    const ich = await nutzer(request, env);
    const url = new URL(request.url);
    const saldoRoh = url.searchParams.get('saldo');

    if (saldoRoh !== null) {
      const b = await saldoBesitz(request, env, ich, Number(saldoRoh));
      if (b instanceof Response) return b;

      const { results } = await env.DB.prepare(
        'SELECT id, art, wert, inhaber FROM zahlweg WHERE gruppe_id = ? ORDER BY reihenfolge, id')
        .bind(b.gruppe.id).all();
      const zweck = zweckBauen(b.gruppe.name, monatSchluessel(b.abrechnung.jahr, b.abrechnung.monat), ich.name);

      return antwort(request, {
        gruppe_id: b.gruppe.id, gruppe: b.gruppe.name, offen_cent: b.offenCent, zweck,
        wege: wegeAufbereiten(results, { offenCent: b.offenCent, saldoId: b.saldo.id }),
      });
    }

    const g = await inGruppe(request, env, ich, null, 'kasse_an');
    if (g instanceof Response) return g;

    const { results } = await env.DB.prepare(
      'SELECT id, art, wert, inhaber FROM zahlweg WHERE gruppe_id = ? ORDER BY reihenfolge, id')
      .bind(g.gruppe.id).all();

    return antwort(request, {
      gruppe_id: g.gruppe.id, gruppe: g.gruppe.name, offen_cent: null, zweck: null,
      wege: wegeAufbereiten(results, {}),
    });
  },

  // -------------------------------------------------------------------------
  /* Pflege, ausschliesslich Gruppenadmin. Vollersetzung der Liste in EINEM
     `batch` - die Reihenfolge ist eine Eigenschaft der LISTE (Entscheidung:
     `reihenfolge` steht am Index im Rumpf), kein Attribut einer einzelnen
     Zeile, ein Teil-Update haette diese Beziehung nirgends festhalten
     koennen. */
  'POST /api/zahlwege': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const g = await inGruppe(request, env, ich, daten, 'kasse_an');
    if (g instanceof Response) return g;
    if (!istGruppenAdmin(g)) return fehler(request, 'Das darf nur, wer die Gruppe führt', 403);

    const roh = Array.isArray(daten.wege) ? daten.wege : null;
    if (!roh) return fehler(request, 'wege: Liste erwartet');
    if (roh.length > ZAHLWEG_MAX) return fehler(request, `Höchstens ${ZAHLWEG_MAX} Zahlwege`);

    const zeilen = [];
    for (const [i, w] of roh.entries()) {
      const art = String(w && w.art || '');
      if (!ZAHLWEG_ARTEN.includes(art)) return fehler(request, `Zahlweg ${i + 1}: unbekannte Art`);
      const wert = String(w && w.wert || '').trim();
      if (!wert) return fehler(request, `Zahlweg ${i + 1}: Wert fehlt`);
      if (wert.length > ZAHLWEG_WERT_MAX) return fehler(request, `Zahlweg ${i + 1}: zu lang`);

      let wertFertig = wert, inhaber = null;
      if (art === 'bank') {
        wertFertig = ibanNormalisieren(wert);
        if (!ibanGueltig(wertFertig)) return fehler(request, `Zahlweg ${i + 1}: IBAN ungültig`);
        inhaber = String(w && w.inhaber || '').trim();
        if (!inhaber) return fehler(request, `Zahlweg ${i + 1}: Kontoinhaber fehlt`);
        if (inhaber.length > 70) return fehler(request, `Zahlweg ${i + 1}: Kontoinhaber höchstens 70 Zeichen`);
      }
      zeilen.push({ art, wert: wertFertig, inhaber, reihenfolge: i });
    }

    await env.DB.batch([
      env.DB.prepare('DELETE FROM zahlweg WHERE gruppe_id = ?').bind(g.gruppe.id),
      ...zeilen.map(z => env.DB.prepare(
        'INSERT INTO zahlweg (gruppe_id, art, wert, inhaber, reihenfolge) VALUES (?, ?, ?, ?, ?)')
        .bind(g.gruppe.id, z.art, z.wert, z.inhaber, z.reihenfolge)),
    ]);

    await kasseAdminLog(env, ich, g, 'zahlwege_gesetzt', String(zeilen.length));
    anstossGruppe(g.gruppe.id, request, env, ctx, 'kasse');
    return antwort(request, { ok: true });
  },

  // -------------------------------------------------------------------------
  /* Der EPC-QR (Girocode) als SVG - Query statt Pfadparameter, der Router
     kennt keine (§3). `saldoBesitz()` traegt die Besitz- und "schon
     ausgeglichen"-Pruefung; hier bleibt die Frage, ob der GEWAEHLTE Zahlweg
     wirklich zur Gruppe DIESES Saldos gehoert und eine Bank-Zeile ist - ein
     QR fuer PayPal/Wero/Bar ergibt keinen Sinn - UND die EPC-Obergrenze
     (999.999.999,99 EUR): eine Eigenschaft des Girocodes, nicht der
     Zahlwege im Allgemeinen, darum hier und nicht in `saldoBesitz()`. */
  'GET /api/zahlung/qr.svg': async (request, env) => {
    const ich = await nutzer(request, env);
    const url = new URL(request.url);
    const saldoRoh = Number(url.searchParams.get('saldo'));
    const b = await saldoBesitz(request, env, ich, saldoRoh);
    if (b instanceof Response) return b;
    if (b.offenCent > 99999999999) return fehler(request, 'Dieser Betrag ist für einen Girocode zu groß');

    const wegRoh = Number(url.searchParams.get('weg'));
    if (!Number.isInteger(wegRoh) || wegRoh <= 0) return fehler(request, 'Welcher Zahlweg?');

    const z = await env.DB.prepare(
      "SELECT id, wert, inhaber FROM zahlweg WHERE id = ? AND gruppe_id = ? AND art = 'bank'")
      .bind(wegRoh, b.gruppe.id).first();
    if (!z) return fehler(request, 'Diesen Zahlweg gibt es hier nicht', 404);

    const zweck = zweckBauen(b.gruppe.name, monatSchluessel(b.abrechnung.jahr, b.abrechnung.monat), ich.name);
    const nutzlast = epcNutzlast({ inhaber: z.inhaber, iban: z.wert, centBetrag: b.offenCent, zweck });
    const svg = qrSvg(nutzlast);

    return new Response(svg, {
      headers: { ...koepfe(request), 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
    });
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
       niemand vor der Seite, der die Antwort schon gesehen haette. Und nur an
       die Gruppen, die `tafel_an` fuehren - eine Meldung gehoert der Person
       (2b), sichtbar wird sie nur dort, wo eine Tafel sie zeigt. */
    anstossSchalter('tafel_an', request, env, ctx, 'tafel');
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

    // An WELCHEM Tisch wird gerufen (Schema 33), und ist der Notruf dort an.
    const g = await inGruppe(request, env, ich, daten, 'notruf_an');
    if (g instanceof Response) return g;

    const art = String(daten.art || '');
    if (!NOTRUF_ARTEN.has(art)) return fehler(request, "art: 'bier', 'kamerad' oder 'alles'");

    const koord = notrufKoordinaten(daten);
    if (koord.fehler) return fehler(request, koord.fehler);
    const { lat, lon, genau } = koord;

    /* Wer ihn sehen soll. `null` heisst an alle - siehe `notrufKreis` und
       migrations/0021. Geprueft VOR dem Anlegen: ein Notruf, dessen Kreis
       nicht steht, ist keiner, den man kurz mal stehen lassen kann.

       Nur der eigene Name darin ist die Probe (siehe `notrufKreis`): sie legt
       dieselbe Zeile an wie jeder andere Notruf und laeuft dieselben neunzig
       Minuten - sie schweigt nur nach aussen und zaehlt nicht mit. */
    const kreis = await notrufKreis(daten, env, ich.id, g.gruppe.id, istAdmin(ich));
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
        INSERT INTO notrufe (user_id, gruppe_id, art, lat, lon, genau, bis, live)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?)
        RETURNING id, erstellt, bis, live, standort_am
      `).bind(ich.id, g.gruppe.id, art, lat, lon, genau, `+${NOTRUF_MINUTEN} minutes`, live),
      // Der Zaehler fuer die Statistik - siehe Migration 0017, warum nicht
      // aus `notrufe` selbst gezaehlt wird. Nur beim ABSETZEN, nicht beim
      // Standort-Nachtrag: der ersetzt keinen Notruf, er ergaenzt einen.
      //
      // Die Probe zaehlt 0 statt gar nicht: `zuletzt` gehoert zum Betrieb der
      // Seite und nicht zur Statistik - wer probiert, war da. Nur der Balken
      // im Verlauf soll nichts davon wissen, sonst stuende dort am Ende die
      // Werkstatt und nicht die Runde.
      env.DB.prepare(`
        UPDATE users SET zuletzt = datetime('now'),
                         notrufe_insgesamt = notrufe_insgesamt + ?
        WHERE id = ?
      `).bind(kreis.probe ? 0 : 1, ich.id),
    ]);
    const zeile = neu.results[0];

    /* Der Kreis erst NACH dem Anlegen: er braucht die Id, die die Zeile oben
       gerade bekommen hat. Bis dahin steht der Notruf einen Wimpernschlag lang
       ohne Kreis da, gilt also fuer alle - das ist die richtige Richtung des
       Fehlers, falls hier etwas abbricht: ein Hilferuf, der zu weit geht, ist
       besser als einer, der niemanden erreicht. */
    if (kreis.ids) await kreisSetzen(env, zeile.id, kreis.ids);

    // An welchen Tisch der Ruf geht - siehe unten bei `anWen`.
    const welcheGruppe = g.gruppe.id;

    /* Die Post. Ein Notruf MELDET nur, er liefert nichts mit - also gilt die
       alte Regel und der Ausloeser bleibt draussen (siehe `benachrichtige`).
       Der Kartenlink steht in der Mail selbst: wer sie im Bett liest, soll
       nicht erst die Seite aufmachen muessen, um zu wissen, wohin.

       Ohne Kreis geht sie an alle mit Namen - dieselbe Runde wie vor
       Migration 0021.

       Bei der Probe gar keine: `empfaenger` waere hier die eigene Id, und
       weder `benachrichtige` noch `stosse` werfen den Absender von sich aus
       heraus (das taete `ausser`, und das setzt der Notruf nicht). Ein Klopfen
       am eigenen Geraet ist kein Test des Notrufs, sondern nur laut. */
    if (!kreis.probe) {
      /* "Ohne Kreis an alle" heisst seit Schema 32: an alle DIESER GRUPPE.
         Vorher war das dasselbe, weil es nur eine gab; jetzt waere es ein
         Notruf aus einem Buero an Leute, die von dem Buero nichts wissen. Der
         ausdruecklich gewaehlte Kreis (`kreis.ids`) bleibt unangetastet - wen
         jemand von Hand anwaehlt, waehlt er. */
      const anWen = kreis.ids ?? (await env.DB.prepare(`
        SELECT m.user_id AS id FROM gruppen_mitglied m
          JOIN users u ON u.id = m.user_id
         WHERE m.gruppe_id = ? AND m.user_id <> ? AND u.name IS NOT NULL
      `).bind(welcheGruppe, ich.id).all()).results.map(r => r.id);
      notrufPost(env, ctx, ich, zeile.id, art, lat, lon, anWen, zeile.bis, !!zeile.live);
    }

    anstossGruppe(welcheGruppe, request, env, ctx, 'tafel');
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
      RETURNING id, gruppe_id, art, erstellt, bis, live, standort_am
    `).bind(lat, lon, genau, ich.id).first();
    if (!zeile) return fehler(request, 'Du hast gerade keinen laufenden Notruf', 409);

    const kreis = await kreisLesen(env, zeile.id);
    /* 'notruf' statt 'tafel', und das ist der ganze Sinn dieser einen Zeile:
       ein Live-Standort traegt alle fuenf Sekunden nach, und die Marke
       'tafel' stiess dabei JEDE offene Seite in die volle Bestenliste - ein
       Zehner-Batch samt Verlauf, Terminen und Bewertungen, fuer eine
       verschobene Nadel. Die schlanke Marke holt `GET /api/notrufe`.

       NUR HIER. Alles andere am Notruf (absetzen, zuruecknehmen, Regler,
       Kreis) meldet weiter 'tafel': das passiert einmal je Notruf, und dort
       aendert sich mehr als eine Nadel.

       Die Gruppe kommt von der ZEILE, nicht aus dem Rumpf - derselbe Grund
       wie bei `/api/notruf/kreis` weiter unten. Kein `notruf_an`-Schalter
       hier: ein Live-Standort, der schon laeuft, soll weiterlaufen duerfen,
       auch wenn die Gruppe den Schalter inzwischen umgelegt hat - abgeschaltet
       wird ausgeblendet, nicht mitten in der Bewegung gekappt (Entscheidung 18). */
    anstossGruppe(zeile.gruppe_id, request, env, ctx, 'notruf');
    return antwort(request, {
      ok: true,
      notruf: notrufAntwort(
        { ...zeile, ...kreis, lat, lon, genau, name: ich.name, user_id: ich.id }, ich.id),
    });
  },

  /* Der schlanke Bruder von `/api/leaderboard`, fuer genau eine Sache: die
     Notrufzeilen nachziehen, wenn ein Live-Standort gewandert ist. Was das
     spart, steht eine Route weiter oben an der Marke 'notruf'.

     DIESELBE Abfrage wie dort (`notrufeStmt`), und das ist der Punkt: der
     Empfaengerkreis haengt im SQL am Betrachter (`?1`), und eine zweite
     Fassung davon waere genau die Sorte Kopie, die eines Tages
     auseinanderlaeuft - ein Ort, den einer sehen darf und der andere nicht.

     Der 401 fuer Abgemeldete braucht keine Sonderbehandlung: der Notrufblock
     ist fuer sie ohnehin verborgen, und die Seite laesst einen Fehler hier
     still fallen - der naechste Nachtrag kommt in fuenf Sekunden. */
  'GET /api/notrufe': async (request, env) => {
    /* Der Traeger laeuft NEBEN dem Ausweis her und nicht dahinter - genau der
       Fall, fuer den `stolzTraeger` gebaut ist. Diese Route wird alle fuenf
       Sekunden gerufen; eine zusaetzliche Runde hintereinander waere hier von
       allen Stellen die teuerste. */
    const [ich, traeger] = await Promise.all([nutzer(request, env), stolzTraeger(env)]);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const g = await inGruppe(request, env, ich, null, 'notruf_an');
    if (g instanceof Response) return g;
    const notrufe = await notrufeStmt(env, ich.id, traeger, g.gruppe.id).all();
    return antwort(request, {
      notrufe: notrufe.results.map(n => notrufAntwort(n, ich.id)),
    }, 200, KEIN_NOTRUF_CACHE);
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
      RETURNING id, gruppe_id, art, lat, lon, genau, erstellt, bis, live, standort_am
    `).bind(daten.live ? 1 : 0, ich.id).first();
    if (!zeile) return fehler(request, 'Du hast gerade keinen laufenden Notruf', 409);

    const kreis = await kreisLesen(env, zeile.id);
    // Die Gruppe kommt von der ZEILE - siehe die Begruendung an /notruf/standort.
    anstossGruppe(zeile.gruppe_id, request, env, ctx, 'tafel');
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

    const zeile = await env.DB.prepare(`
      SELECT id, gruppe_id, art, lat, lon, genau, erstellt, bis, live, standort_am
      FROM notrufe
      WHERE user_id = ? AND weg_am IS NULL AND bis > datetime('now')
    `).bind(ich.id).first();
    if (!zeile) return fehler(request, 'Du hast gerade keinen laufenden Notruf', 409);

    /* Die Gruppe kommt vom laufenden NOTRUF, nicht aus dem Rumpf: der Ruf
       gehoert dem Tisch, an dem er abgesetzt wurde, und ein nachtraeglich
       mitgeschicktes Feld duerfte ihn nicht auf einen anderen umhaengen. Und
       aus demselben Grund steht `notrufKreis` erst JETZT: der waehlbare Kreis
       ist der DIESER Gruppe, nicht irgendeiner. */
    const welcheGruppe = zeile.gruppe_id;
    const kreis = await notrufKreis(daten, env, ich.id, welcheGruppe, istAdmin(ich));
    if (kreis.fehler) return fehler(request, kreis.fehler);

    await kreisSetzen(env, zeile.id, kreis.ids);

    /* Angeschrieben wird der ganze neue Kreis, nicht die Differenz - warum,
       steht an `notrufPost`. Ohne Kreis ist das die ganze Runde: wer von
       "nur an drei" auf "an alle" umlegt, erreicht damit auch die uebrigen.

       Die Probe schreibt niemanden an - auch nicht sich selbst, siehe
       `POST /api/notruf`. Wer einen laufenden Notruf nachtraeglich auf die
       Probe zurueckzieht, hat die Runde dabei schon erreicht; die Post von
       vorhin bleibt draussen, die Karte nimmt der Kreiswechsel weg. */
    if (!kreis.probe) {
      /* "Ohne Kreis an alle" heisst seit Schema 32: an alle DIESER GRUPPE.
         Vorher war das dasselbe, weil es nur eine gab; jetzt waere es ein
         Notruf aus einem Buero an Leute, die von dem Buero nichts wissen. Der
         ausdruecklich gewaehlte Kreis (`kreis.ids`) bleibt unangetastet - wen
         jemand von Hand anwaehlt, waehlt er. */
      const anWen = kreis.ids ?? (await env.DB.prepare(`
        SELECT m.user_id AS id FROM gruppen_mitglied m
          JOIN users u ON u.id = m.user_id
         WHERE m.gruppe_id = ? AND m.user_id <> ? AND u.name IS NOT NULL
      `).bind(welcheGruppe, ich.id).all()).results.map(r => r.id);
      notrufPost(env, ctx, ich, zeile.id, zeile.art, zeile.lat, zeile.lon, anWen, zeile.bis, !!zeile.live);
    }

    anstossGruppe(welcheGruppe, request, env, ctx, 'tafel');
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
    const [ich, traeger] = await Promise.all([nutzer(request, env), stolzTraeger(env)]);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const g = await inGruppe(request, env, ich, null, 'notruf_an');
    if (g instanceof Response) return g;
    const leute = await kreisWaehlbarStmt(env, ich.id, g.gruppe.id, traeger).all();
    /* `probe` ist die eigene Id, und nur der Wirt bekommt sie - er darf sich
       selbst waehlen und damit den Notruf in der laufenden Anlage ausprobieren
       (siehe `notrufKreis`). Sie steht NEBEN der Liste und nicht darin: `leute`
       ist ein Adressbuch, und man selbst gehoert nicht in sein eigenes. Wie der
       Knopf dazu heisst, entscheidet die Seite. */
    return antwort(request, {
      leute: leute.results,
      probe: istAdmin(ich) ? ich.id : null,
    }, 200, KEIN_FREMDER_CACHE);
  },

  /* Zurueckgenommen. Kein Loeschen: die Zeile bleibt bis zum Aufraeumen stehen,
     damit die offenen Seiten den Notruf verschwinden SEHEN, statt ihn wortlos
     zu verlieren - `weg_am` faellt aus der Abfrage, der Anstoss kommt trotzdem.
     Wer keinen offenen hat, bekommt kein Nein: zweimal "weg" ist kein Fehler,
     sondern derselbe Wunsch zweimal. */
  'POST /api/notruf/weg': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    // Die Gruppe kommt von der ZEILE - siehe die Begruendung an /notruf/standort.
    const weg = await env.DB.prepare(`
      UPDATE notrufe SET weg_am = datetime('now')
      WHERE user_id = ? AND weg_am IS NULL
      RETURNING gruppe_id
    `).bind(ich.id).first();

    if (weg) anstossGruppe(weg.gruppe_id, request, env, ctx, 'tafel');
    return antwort(request, { ok: true, weg: weg ? 1 : 0 });
  },

  // -------------------------------------------------------------------------
  /* Das Rad drehen. Braucht ein Token: wer nicht mitspielt, soll den Tag nicht
     verbrauchen - und "gedreht von Basti" ist die Zeile, die aus der Ziehung
     eine Handlung macht. Ein zweiter Aufruf am selben Tag ist kein Fehler, er
     bekommt schlicht dasselbe Ergebnis mit `schon: true`. */
  'POST /api/drehen': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const daten = await json(request);

    // An welchem Tisch wird gedreht (Schema 33), und ist das Rad dort an.
    const g = await inGruppe(request, env, ich, daten, 'rad_an');
    if (g instanceof Response) return g;
    /* `tafel_an` und `rad_an` sind entkoppelt (Entscheidung 40): mit Tafel
       zieht das Rad gewichtet nach Bestand wie bisher, ohne Tafel
       gleichverteilt - siehe `gewicht()`, `losFeldStmt()`. */
    const tafelAn = !!g.gruppe.tafel_an;

    const tag = bierTag();
    /* Wen der Regenbogen heute trifft, muss VOR dem Feld feststehen: seine
       Farbe wird mit dem Feld eingefroren (`losSegmente`), und ein Rad, das
       sich beim Nachzeichnen umfaerbt, waere kein Beleg mehr. */
    const traeger = await stolzTraeger(env);
    // Wer heute Geburtstag hat (Schema 31) - er entscheidet gleich mit, wer
    // gewinnt und ob ueberhaupt gezogen wird. Laeuft neben dem Traeger her.
    const kinderP = geburtstagsKinder(env);
    /* Der Verfallslauf laeuft VOR dem Lesen und im selben batch: wer seit drei
       Stunden nicht geantwortet hat, gibt den Tag hier frei - und die beiden
       Abfragen dahinter sehen das bereits. */
    const [verfallen, tagRoh, feld, termine] = await env.DB.batch([
      verfallStmt(env, tag, g.gruppe.id), losTagStmt(env, tag, g.gruppe.id),
      losFeldStmt(env, traeger, g.gruppe.id, tafelAn),
      termineStmt(env, traeger, g.gruppe.id),
    ]);
    const lage = tagesLage(tagRoh.results);
    const topf = losTopf(feld.results, lage);
    const kinder = await kinderP;
    const ehre = ehrenLage(kinder, topf, termine.results, tag);

    // Es gilt schon eines? Dann gilt das, egal wer fragt.
    if (lage.gueltig) {
      /* Hier hat zwar niemand gezogen, aber der Verfallslauf oben kann etwas
         umgeschrieben haben - dann steht bei den anderen noch ein Los, das es
         nicht mehr gibt. Ohne diese Aenderung schweigt die Leitung. */
      if (verfallen.meta.changes) anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel');
      return antwort(request,
        { ...losAntwort(tag, lage, topf, termine.results, kinder, tafelAn), schon: true });
    }
    /* Steht der Abend des Geburtstagskindes schon, faellt die Ziehung heute
       aus (siehe `ehrenLage`). Die Seite ruft hier dann gar nicht mehr an -
       ein Tab, der seit dem Morgen offensteht, aber schon. NACH der Pruefung
       auf ein geltendes Los: ein Ergebnis, das dasteht, soll sich weiter
       melden duerfen, statt in einen Fehler zu laufen. */
    if (ehre && ehre.nur) {
      return fehler(request,
        'Heute wird gefeiert — der Abend steht schon. Drehen geht nur zu Ehren.', 409);
    }
    if (topf.length < lage.mindest) {
      return fehler(request, lage.raus.length
        ? 'Heute hat abgesagt, wer da war.'
        : tafelAn
          ? `Zu wenig gemeldet — die Flasche braucht mindestens ${lage.mindest}, ` +
            'die heute etwas Kaltes haben.'
          : `Zu wenige in der Runde — die Flasche braucht mindestens ${lage.mindest}.`,
        409);
    }

    /* DIE EINE GEZINKTE ZIEHUNG. Hat heute jemand Geburtstag und noch keinen
       Abend, zeigt die Flasche auf ihn - er richtet aus, und das ist das
       Geschenk der Runde an ihn. Gezogen wird trotzdem und nicht gesetzt:
       bei zwei Geburtstagskindern entscheidet weiterhin der Bestand, wie bei
       jeder anderen Ziehung auch.

       `losSegmente` unten bekommt weiter den GANZEN Topf. Das Feld wird mit
       der Ziehung eingefroren und ist der Beleg des Abends - stuende dort nur
       das Geburtstagskind, zeigte ein Rad von morgen ein Rad mit einem
       einzigen Bogen, und niemand saehe mehr, gegen wen es gewonnen hat. */
    const gewinner = ziehe(ehre ? topf.filter(p => ehre.fuer.includes(p.name)) : topf, tafelAn);
    /* Das Rennen zweier gleichzeitiger Dreher entscheidet der partielle
       Unique-Index `los_gueltig`: wer nicht geschrieben hat, liest gleich
       darauf das fremde Ergebnis und zeigt es an. Kein Sperren, keine
       Transaktion ueber zwei Anfragen. Die WHERE-Klausel muss wortwoertlich
       der Index-Bedingung entsprechen, sonst findet SQLite den Index nicht.

       `gewinner.biere` bindet immer eine Zahl (0 oder mehr) - die Spalte ist
       NOT NULL, und `losFeldStmt` liefert seit Etappe 2 auch ohne Tafel ein
       `coalesce(r.biere, 0)`. Dass es ohne Tafel nirgends ANGEZEIGT wird,
       entscheidet `losSegmente` mit `tafelAn`, nicht diese Zeile. */
    const gesetzt = await env.DB.prepare(`
      INSERT INTO los (tag, gruppe_id, user_id, biere, feld, gedreht_von)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(gruppe_id, tag) WHERE status IN ('offen','zugesagt') DO NOTHING
    `).bind(tag, g.gruppe.id, gewinner.id, gewinner.biere,
            JSON.stringify(losSegmente(topf, kinder, tafelAn)), ich.id).run();

    const [tagRoh2, feld2, termine2] = await env.DB.batch([
      losTagStmt(env, tag, g.gruppe.id), losFeldStmt(env, traeger, g.gruppe.id, tafelAn),
      termineStmt(env, traeger, g.gruppe.id),
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
    anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel');
    return antwort(request, {
      ...losAntwort(tag, lage2, losTopf(feld2.results, lage2), termine2.results, kinder, tafelAn),
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

    /* WELCHES RAD (Schema 33). Seit jede Gruppe taeglich ihr eigenes dreht,
       gibt es an einem Tag mehrere geltende Lose - "das Los von heute" ist
       keine eindeutige Auskunft mehr.

       Zwei Wege herein, zwei Quellen fuer die Gruppe, und KEINE davon ist der
       Rumpf allein: aus der Seite kommt sie als `gruppe` (dann steht sie da
       und ist durch die Mitgliedschaft gedeckt), aus der Mail kommt sie ueber
       die Los-Id, denn die traegt der signierte Link ohnehin. Ein
       Unangemeldeter soll die Gruppe nicht selbst benennen duerfen - er
       benennt das Los, und das Los sagt, wohin es gehoert. */
    let welche = null;
    if (daten.los != null) {
      const l = await env.DB.prepare('SELECT gruppe_id FROM los WHERE id = ?')
        .bind(Number(daten.los)).first();
      welche = l ? l.gruppe_id : null;
    }
    if (welche == null && daten.gruppe != null) {
      const g = await inGruppe(request, env, ich, daten);
      if (g instanceof Response) return g;
      welche = g.gruppe.id;
    }

    const [, tagRoh] = await env.DB.batch([
      verfallStmt(env, tag, welche), losTagStmt(env, tag, welche),
    ]);
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
      /* Die Gruppe kommt vom LOS, nicht aus dem Rumpf (Schema 33). Diese Route
         ist die eine, die auch ohne Anmeldung erreichbar ist - aus der
         Gewinner-Mail heraus, ueber die Signatur -, und ein Rumpffeld, das ein
         Unangemeldeter setzt, waere die falsche Quelle fuer eine
         Gruppenzugehoerigkeit. Der Abend gehoert dem Tisch, an dem gedreht
         wurde. */
      neuerTermin = await env.DB.prepare(`
        INSERT INTO termine (gastgeber_id, gruppe_id, beginnt_am, endet_am, los_id, erstellt_von)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(los_id) DO NOTHING
        RETURNING id
      `).bind(ich.id, z.gruppe_id, beginn, ende, z.id, ich.id).first();
    }

    /* Erst die Zusage macht aus der Ziehung einen Abend - also geht die
       Nachricht auch erst hier raus, und nur, wenn der Termin WIRKLICH neu
       entstanden ist. Beim zweiten Ruf greift `ON CONFLICT DO NOTHING`, und
       dann gibt es nichts zu vermelden. */
    if (neuerTermin) {
      mailTerminNeu(env, ctx, {
        id: neuerTermin.id, beginnt_am: beginn, endet_am: ende,
        // Die Gruppe des Loses - sie entscheidet, WER von dem Abend erfaehrt.
        gruppe_id: z.gruppe_id,
        gastgeber: ich.name, titel: null, fassung: 0,
      }, ich.id, 'zugesagt');
    }

    // Nur fuer die Ziehungswege (Entscheidung 40) - `z` traegt selbst kein
    // `tafel_an`, das Los kennt nur seine Gruppe, nicht ihre Schalterleiste.
    const gruppeZeile = await env.DB.prepare('SELECT tafel_an FROM gruppen WHERE id = ?')
      .bind(z.gruppe_id).first();
    const tafelAn = !!(gruppeZeile && gruppeZeile.tafel_an);

    const traeger = await stolzTraeger(env);
    const kinderP = geburtstagsKinder(env);
    const [tagRoh2, feld, termine] = await env.DB.batch([
      // Dieselbe Gruppe wie oben - sonst antwortet die Seite mit dem Rad
      // einer anderen Runde auf die eigene Zusage.
      losTagStmt(env, tag, z.gruppe_id), losFeldStmt(env, traeger, z.gruppe_id, tafelAn),
      termineStmt(env, traeger, z.gruppe_id),
    ]);
    const lage2 = tagesLage(tagRoh2.results);
    /* Zusage wie Absage aendern Rad, Liste und Termine auf einen Schlag.
       AUSDRUECKLICH mit der Gruppe des Loses statt ueber den Schreibenden:
       wer aus der Mail heraus antwortet, traegt kein Geraete-Token bei sich,
       und `anstoss()` faende darum keine einzige Gruppe. Die Meldung ginge
       still ins Leere, und die Tafel bliebe stehen, bis der Zeitgeber greift. */
    anstossGruppe(z.gruppe_id, request, env, ctx, 'tafel');
    /* Die Terminliste faehrt mit: sonst muesste die Seite gleich darauf die
       Bestenliste nachladen, nur damit der eben angelegte Abend dasteht. */
    return antwort(request, {
      ...losAntwort(tag, lage2, losTopf(feld.results, lage2), termine.results,
                    await kinderP, tafelAn),
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

    // An welchem Tisch (Schema 33), und sind Termine dort an.
    const g = await inGruppe(request, env, ich, daten, 'termine_an');
    if (g instanceof Response) return g;

    const p = pruefeBeginn(daten.beginnt_am);
    if (p.fehler) return fehler(request, p.fehler);
    const e = pruefeEnde(daten.endet_am, p.d);
    if (e.fehler) return fehler(request, e.fehler);

    const titel = String(daten.titel ?? '').trim().replace(/\s+/g, ' ');
    if (titel.length > TERMIN_TITEL_MAX) {
      return fehler(request, `Der Titel darf höchstens ${TERMIN_TITEL_MAX} Zeichen haben`);
    }

    /* Auswaerts oder bei jemandem - das entscheidet allein `ort` (siehe
       migrations/0024). Steht dort etwas, wird ein mitgeschickter Gastgeber
       gar nicht erst angesehen: zwei Angaben zum selben Ort waeren zwei
       Wahrheiten, und die Seite bietet auch nur eine von beiden an. */
    const ort = String(daten.ort ?? '').trim().replace(/\s+/g, ' ');
    if (ort.length > TERMIN_TITEL_MAX) {
      return fehler(request, `Der Ort darf höchstens ${TERMIN_TITEL_MAX} Zeichen haben`);
    }

    /* Der Gastgeber kommt als Name aus der Liste - Ids stehen nirgends auf der
       Seite. NUR AUS DIESER GRUPPE: Namen sind instanzweit eindeutig, ohne den
       `gruppen_mitglied`-Filter traegt ein Tippfehler einen Fremden auf die
       Tafel, der davon nie erfaehrt und ihn auch nicht wieder loeschen kann
       (`POST /api/termin/aendern` liest die Gruppe aus der Zeile, `inGruppe()`
       weist ihn mit 403 ab). Dieselbe Klammer wie `zielFehlt()` und
       `kreisWaehlbarStmt` - die Gruppe steht in der WHERE-Klausel, nicht in
       einer Pruefung danach. */
    const wer = ort ? '' : String(daten.gastgeber ?? '').trim().toLowerCase();
    const gast = wer
      ? await env.DB.prepare(`
          SELECT u.id, u.name FROM users u
            JOIN gruppen_mitglied m ON m.user_id = u.id
           WHERE u.name_klein = ? AND m.gruppe_id = ? AND u.entfernt_am IS NULL
        `).bind(wer, g.gruppe.id).first()
      /* Auswaerts gibt es keinen Gastgeber. Die Spalte ist NOT NULL und traegt
         dann den, der den Abend ausgemacht hat - dasselbe wie `erstellt_von`. */
      : ort ? { id: ich.id, name: ich.name } : null;
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
      INSERT INTO termine (gastgeber_id, gruppe_id, beginnt_am, endet_am, titel, ort, erstellt_von)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).bind(gast.id, g.gruppe.id, alsDbZeit(p.d), alsDbZeit(e.d),
            titel || null, ort || null, ich.id).first();

    mailTerminNeu(env, ctx, {
      id: neu.id, beginnt_am: alsDbZeit(p.d), endet_am: alsDbZeit(e.d),
      gruppe_id: g.gruppe.id,
      gastgeber: ort ? null : gast.name, ort: ort || null,
      titel: titel || null, fassung: 0,
    }, ich.id, 'eingetragen');

    const alle = await termineStmt(env, await stolzTraeger(env), g.gruppe.id).all();
    anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel');
    return antwort(request, {
      ok: true, id: neu.id, gastgeber: ort ? null : gast.name, ort: ort || null,
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
      SELECT t.id, t.gastgeber_id, t.gruppe_id, t.erstellt_von, t.los_id,
             t.beginnt_am, t.endet_am,
             -- Der Ort MUSS mit heraus: auswaerts steht in gastgeber_id der
             -- Eintragende, und terminWo() haelt den Namen nur dann aus den
             -- Mails heraus, wenn es den Ort ueberhaupt zu sehen bekommt.
             t.titel, t.abgesagt_am, t.fassung, t.ort,
             coalesce(u.name, 'Ehemaliger') AS gastgeber,
             (t.beginnt_am <= datetime('now')) AS laeuft
      FROM termine t JOIN users u ON u.id = t.gastgeber_id WHERE t.id = ?
    `).bind(Number(daten.id)).first();
    if (!t) return fehler(request, 'Den Termin gibt es nicht', 404);
    // Die Gruppe kommt vom TERMIN, nicht aus dem Rumpf - er gehoert dem Tisch,
    // an dem er eingetragen wurde (Nachgereicht #1 aus Etappe 1).
    const g = await inGruppe(request, env, ich, { gruppe: t.gruppe_id }, 'termine_an');
    if (g instanceof Response) return g;
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
      const alle = await termineStmt(env, await stolzTraeger(env), t.gruppe_id).all();
      anstossGruppe(t.gruppe_id, request, env, ctx, 'tafel');
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

    const alle = await termineStmt(env, await stolzTraeger(env), t.gruppe_id).all();
    anstossGruppe(t.gruppe_id, request, env, ctx, 'tafel');
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

    /* An welchem Tisch (Schema 33). Hier haengt mehr daran als eine Spalte:
       ein Mensch hat kuenftig EINEN SCHNITT JE GRUPPE - was am Tresen ueber
       ihn gesagt wird, bleibt am Tresen. Deshalb traegt die Gruppe unten auch
       den UPSERT-Konflikt und die Ruecknahme. */
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;

    const ziel = zielAus(`${daten.ziel_art}:${daten.ziel_id}`);
    if (!ziel) return fehler(request, "ziel_art: 'user' oder 'termin', ziel_id: eine Zahl");

    /* Der Schalter haengt am ZIEL, nicht an einer festen Spalte: ein Mensch
       gehoert zur Tafel, ein Abend zu den Terminen. Kein zweiter DB-Griff -
       `g.gruppe` traegt die ganze Schalterleiste schon aus `inGruppe()`. */
    const bewertSchalter = ziel.art === 'termin' ? 'termine_an' : 'tafel_an';
    if (!g.gruppe[bewertSchalter]) {
      return fehler(request, `Das ist in „${g.gruppe.name}" abgeschaltet`, 403);
    }

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
      /* Die Gruppe steht in BEIDEN Anweisungen: eine Ruecknahme am Tresen darf
         die Note im Buero nicht mitnehmen. Ohne sie loeschte dieselbe Zeile
         Code beide - und der Betroffene saehe nur, dass eine Bewertung
         verschwunden ist, die er gar nicht angefasst hat. */
      const [, weg] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE kommentare SET bewertung_id = NULL WHERE bewertung_id IN (
            SELECT id FROM bewertungen
             WHERE autor_id = ? AND gruppe_id = ? AND ziel_art = ? AND ziel_id = ?)
        `).bind(ich.id, g.gruppe.id, ziel.art, ziel.id),
        env.DB.prepare(`
          DELETE FROM bewertungen
           WHERE autor_id = ? AND gruppe_id = ? AND ziel_art = ? AND ziel_id = ?
        `).bind(ich.id, g.gruppe.id, ziel.art, ziel.id),
      ]);
      if (weg.meta.changes) {
        anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
      }
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
      /* Nicht nur "gibt es", sondern "ist am selben Tisch" (Nachgereicht #1
         aus Etappe 1): sonst liesse sich am Tresen ein Schnitt fuer jemanden
         anlegen, der dort nie war. */
      const wer = await env.DB.prepare(`
        SELECT 1 FROM users u
          JOIN gruppen_mitglied m ON m.user_id = u.id
         WHERE u.id = ? AND u.name IS NOT NULL AND m.gruppe_id = ?
      `).bind(ziel.id, g.gruppe.id).first();
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
      /* `gruppe_id = ?` gehoert in die WHERE-Klausel, nicht in eine Pruefung
         danach (Nachgereicht #1 aus Etappe 1): ein Termin einer fremden
         Gruppe soll sich hier genauso wenig finden wie einer, den es nicht
         gibt - dieselbe Fehlermeldung, keine zusaetzliche Auskunft. */
      const t = await env.DB.prepare(`
        SELECT abgesagt_am, gastgeber_id, ort, (beginnt_am <= datetime('now')) AS gewesen
        FROM termine WHERE id = ? AND gruppe_id = ?
      `).bind(ziel.id, g.gruppe.id).first();
      if (!t) return fehler(request, 'Den Termin gibt es nicht', 404);
      if (t.abgesagt_am) return fehler(request, 'Der Abend ist abgesagt worden', 409);
      if (!t.gewesen) return fehler(request, 'Der Abend hat noch nicht angefangen', 409);
      /* Auswaerts faellt beides weg - die Sperre und das Echo. Der Abend
         gehoert niemandem (migrations/0024): "Versorgung" und "Location"
         bewerten dann den Italiener, nicht den, der ihn vorgeschlagen hat, und
         genau deshalb darf der auch mitbewerten. Die Sterne selbst haengen
         ohnehin am Abend und nicht an einem Menschen - `bewerteter` traegt
         allein die Echo-Mail weiter unten. */
      if (!t.ort && t.gastgeber_id === ich.id) {
        return fehler(request, 'Den eigenen Abend bewertet man nicht', 403);
      }
      bewerteter = t.ort ? null : t.gastgeber_id;
    }

    /* Wie die Meldesperre, aber ausdruecklich nur gegen ANDERE Ziele - warum,
       steht bei BEWERTSPERRE. Das eigene Blatt darf man tippen, so schnell man
       will; es ist immer dieselbe Zeile. */
    const letzte = await env.DB.prepare(`
      SELECT 1 FROM bewertungen
      WHERE autor_id = ? AND NOT (gruppe_id = ? AND ziel_art = ? AND ziel_id = ?)
        AND coalesce(geaendert, erstellt) > datetime('now', ?) LIMIT 1
    `).bind(ich.id, g.gruppe.id, ziel.art, ziel.id, `-${BEWERTSPERRE} seconds`).first();
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

    /* Die Spaltenliste im ON CONFLICT muss WORTWOERTLICH der UNIQUE-Klausel
       aus migrations/0033 entsprechen (autor_id, gruppe_id, ziel_art, ziel_id),
       sonst findet SQLite den Konflikt nicht und der UPSERT wird zu einem
       zweiten INSERT, der am UNIQUE stirbt. */
    const b = await env.DB.prepare(`
      INSERT INTO bewertungen (autor_id, gruppe_id, ziel_art, ziel_id, sterne)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(autor_id, gruppe_id, ziel_art, ziel_id)
        DO UPDATE SET sterne = excluded.sterne, geaendert = datetime('now')
      RETURNING id
    `).bind(ich.id, g.gruppe.id, ziel.art, ziel.id, JSON.stringify(s.sterne)).first();

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
        INSERT INTO kommentare (ziel_art, ziel_id, gruppe_id, autor_id, bewertung_id, text, bild_key, sterne)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).bind(ziel.art, ziel.id, g.gruppe.id, ich.id, b.id, text, bi.key,
              JSON.stringify(s.sterne)).first();
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
        `bewertung:${b.id}`, ziel, ich.id);
    }

    /* Zwei Marken: der Schnitt steht auch in der Liste bzw. am Termin, der
       Thread selbst ist das Ziel. Wer beides offen hat, laedt beides. */
    anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
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
  /* Schreiben. Auf SICH SELBST ausdruecklich erlaubt - sonst kann der
     Gastgeber im eigenen Thread nicht antworten. Auf einen Termin jederzeit,
     auch vorher ("bring Chips mit"); nur bewertet wird erst hinterher. */
  'POST /api/kommentar': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!ich.name) return fehler(request, 'Erst einen Namen für die Liste wählen', 409);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');

    // An welchem Tisch (Schema 33) - auch am Menschen, nicht nur am Abend:
    // was am Tresen ueber jemanden gesagt wird, bleibt am Tresen.
    const g = await inGruppe(request, env, ich, daten);
    if (g instanceof Response) return g;

    const ziel = zielAus(`${daten.ziel_art}:${daten.ziel_id}`);
    if (!ziel) return fehler(request, "ziel_art: 'user' oder 'termin', ziel_id: eine Zahl");

    /* Der Schalter haengt am ZIEL, nicht an einer festen Spalte - siehe
       /api/bewerten. Kein zweiter DB-Griff, `g.gruppe` traegt die Leiste. */
    const kommentarSchalter = ziel.art === 'termin' ? 'termine_an' : 'tafel_an';
    if (!g.gruppe[kommentarSchalter]) {
      return fehler(request, `Das ist in „${g.gruppe.name}" abgeschaltet`, 403);
    }

    /* Ein Foto allein ist ein gueltiger Kommentar - "so sah es aus" braucht
       keinen Satz dazu. Leer bleiben duerfen aber nicht beide. */
    const b = await pruefeBild(env, daten.bild);
    if (b.fehler) return fehler(request, b.fehler, b.status);

    const text = String(daten.text ?? '').trim();
    if (!text && !b.key) return fehler(request, 'Ohne Text kein Kommentar');
    if (text.length > KOMMENTAR_MAX) {
      return fehler(request, `Höchstens ${KOMMENTAR_MAX} Zeichen`);
    }

    const fehlt = await zielFehlt(env, ziel, g.gruppe.id);
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
      INSERT INTO kommentare (ziel_art, ziel_id, gruppe_id, autor_id, antwort_auf, an_id, text, bild_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).bind(ziel.art, ziel.id, g.gruppe.id, ich.id, wurzel, anId, text, b.key).first();

    if (angesprochen && angesprochen !== ich.id) {
      mailEcho(env, ctx, angesprochen, ich.name, {
        kurz: 'Antwort auf deinen Beitrag',
        lang: `${ich.name} hat dir geantwortet: „${text.slice(0, 200)}${text.length > 200 ? ' …' : ''}"`,
      }, `kommentar:${neu.id}`, ziel, ich.id);
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
    anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel', `${ziel.art}:${ziel.id}`);
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
      'SELECT id, autor_id, gruppe_id, geloescht_am, bild_key, ziel_art, ziel_id FROM kommentare WHERE id = ?')
      .bind(Number(daten.id)).first();
    if (!k) return fehler(request, 'Den Kommentar gibt es nicht', 404);
    if (k.autor_id !== ich.id) return fehler(request, 'Das ist nicht deiner', 403);
    if (k.geloescht_am) return fehler(request, 'Der ist schon gelöscht', 409);

    // Die Gruppe kommt vom KOMMENTAR, nicht aus dem Rumpf - siehe /api/termin/aendern.
    const g = await inGruppe(request, env, ich, { gruppe: k.gruppe_id },
      k.ziel_art === 'termin' ? 'termine_an' : 'tafel_an');
    if (g instanceof Response) return g;

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
      anstossGruppe(g.gruppe.id, request, env, ctx, 'tafel', `${k.ziel_art}:${k.ziel_id}`);
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
    anstossGruppe(g.gruppe.id, request, env, ctx, `${k.ziel_art}:${k.ziel_id}`);
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
      'SELECT id, gruppe_id, geloescht_am, ziel_art, ziel_id FROM kommentare WHERE id = ?')
      .bind(id).first();
    if (!k) return fehler(request, 'Den Kommentar gibt es nicht', 404);
    if (k.geloescht_am) return fehler(request, 'Der ist gelöscht', 409);

    // Die Gruppe kommt vom KOMMENTAR - ohne diese Pruefung koennte heute
    // jeder Angemeldete auf eine fremde Karte reagieren (Nachgereicht #1).
    const g = await inGruppe(request, env, ich, { gruppe: k.gruppe_id },
      k.ziel_art === 'termin' ? 'termine_an' : 'tafel_an');
    if (g instanceof Response) return g;

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
    anstossGruppe(g.gruppe.id, request, env, ctx, `${k.ziel_art}:${k.ziel_id}`);
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

    /* WELCHE GRUPPE (Schema 33) - und hier ist es keine Feinheit, sondern der
       Unterschied zwischen Lesen und Ueberschreiben. Seit dem Tabellentausch
       gibt es je Gruppe eine eigene Bewertung desselben Menschen. Ohne diese
       Schranke liefert `meins` unten IRGENDEINE davon, die Seite legt sie ins
       Sterneblatt, und der naechste Tipp schickt sie mit der Gruppe des
       BLATTES zurueck - der UPSERT trifft dann die Zeile der anderen Gruppe
       und ueberschreibt sie. Ein Leseweg, der Daten zerstoert.

       Der Schalter haengt am ZIEL, nicht an einer festen Spalte - dieselbe
       Regel wie bei /api/kommentar und /api/bewerten. */
    const bewertungenSchalter = ziel.art === 'termin' ? 'termine_an' : 'tafel_an';
    const g = await inGruppe(request, env, ich, null, bewertungenSchalter);
    if (g instanceof Response) return g;

    const ichId = ich.id;
    /* Wen der Regenbogen heute traegt, entscheidet hier ueber zwei Dinge: den
       Namen ueber dem Blatt und jeden Autor im Faden darunter. Beides muss
       aus DERSELBEN Auskunft kommen - sonst traegt ein Mensch ihn im Kopf des
       Blattes und in seinem eigenen Kommentar zwei Zeilen tiefer nicht mehr. */
    const traeger = await stolzTraeger(env);
    const stmts = [
      /* `gruppe_id` PFLICHT (Gegenlesen-Fund): ohne sie zeigte der Schnitt
         eines Menschen die Sterne aus JEDER Gruppe zusammengerechnet, statt
         "ein Schnitt je Gruppe" (Entscheidung 17). */
      env.DB.prepare(
        'SELECT ziel_art, ziel_id, sterne FROM bewertungen WHERE gruppe_id = ? AND ziel_art = ? AND ziel_id = ?')
        .bind(g.gruppe.id, ziel.art, ziel.id),
      env.DB.prepare(
        'SELECT sterne FROM bewertungen WHERE autor_id = ? AND gruppe_id = ? AND ziel_art = ? AND ziel_id = ?')
        .bind(ichId, g.gruppe.id, ziel.art, ziel.id),
      ...baumStmts(env, ziel, g.gruppe.id, traeger),
    ];
    /* Bei einem Abend haengt das Bewerten an seinem Zustand - dieselbe Regel
       wie in POST /api/bewerten, nur andersherum gelesen: die Seite soll das
       Formular gar nicht erst anbieten, statt am 409 haengenzubleiben. Wichtig
       geworden ist das mit der Chronik: dort ist jeder Abend erreichbar, auch
       der abgesagte, unter dem noch Kommentare stehen. Reitet im selben batch
       mit - ein eigener Ruf waere eine Runde fuer eine Zeile. */
    if (ziel.art === 'termin') {
      // `gruppe_id` PFLICHT (Gegenlesen-Fund): sonst liesse sich Ort und
      // Gastgeber eines beliebigen Termins einer fremden Gruppe erfragen,
      // wenn die Termin-Id erraten oder durchprobiert wird.
      stmts.push(env.DB.prepare(`
        SELECT abgesagt_am, gastgeber_id, ort, (beginnt_am <= datetime('now')) AS gewesen
        FROM termine WHERE id = ? AND gruppe_id = ?
      `).bind(ziel.id, g.gruppe.id));
    } else if (ziel.art === 'user') {
      /* Nur fuer den Namen ueber dem Blatt - der IST hier der Mensch, und ein
         Mensch traegt auf jedem Blatt dieselbe Farbe. Eine eigene Zeile im
         selben batch und keine Runde extra; der Titel steht damit im
         Regenbogen, egal woher das Blatt aufgeschlagen wurde: aus der Liste,
         aus einem Link oder aus einer Mail.

         Beim ABEND gibt es das nicht, und das ist Absicht: dort heisst der
         Titel "Bierabend bei Basti", und der Regenbogen gilt dem Menschen und
         nicht dem Satz um ihn herum. Sein Name traegt ihn dort, wo er als Name
         dasteht - in der Zeile der Terminliste (`gastgeber_farbe`). */
      stmts.push(env.DB.prepare(
        `SELECT ${farbeSql('u', traeger)} AS farbe FROM users u WHERE u.id = ?`,
      ).bind(ziel.id));
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
      /* Auswaerts hat der Abend keinen Gastgeber, also auch keinen, dem er
         gehoert - dieselbe Ausnahme wie in POST /api/bewerten, und aus
         demselben Grund an derselben Stelle. */
      : !a.ort && a.gastgeber_id === ich.id       ? 'Den eigenen Abend bewertet man nicht.'
      : a.abgesagt_am                             ? 'Abgesagt — bewertet wird ein Abend, den es gab.'
      : !a.gewesen                                ? 'Bewertet wird, wenn der Abend gewesen ist.'
      : null;

    return antwort(request, {
      ziel: `${ziel.art}:${ziel.id}`,
      // Der Platz DESSEN, um den es auf diesem Blatt geht - nur beim Melder,
      // siehe die Statementliste oben.
      ziel_farbe: ziel.art === 'user' && a ? a.farbe : null,
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
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Dafür muss man mitschreiben', 401);
    const g = await inGruppe(request, env, ich, null, 'termine_an');
    if (g instanceof Response) return g;

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
    // Einmal geholt, zweimal eingesetzt - Gastgeber und Eintragender lesen
    // denselben Traeger, sonst traegt einer von beiden ihn und der andere nicht.
    const chronikTraeger = await stolzTraeger(env);
    const zeilen = await env.DB.prepare(`
      SELECT t.id, t.gastgeber_id, t.beginnt_am, t.endet_am, t.titel, t.los_id,
             t.abgesagt_am, t.erstellt_von, t.ort,
         coalesce(u.name, 'Ehemaliger') AS gastgeber,
         ${farbeSql('u', chronikTraeger)} AS gastgeber_farbe,
         coalesce(e.name, 'Ehemaliger') AS eingetragen_von,
         CASE WHEN e.id IS NULL THEN NULL
              ELSE ${farbeSql('e', chronikTraeger)} END AS von_farbe
      FROM termine t
      JOIN users u ON u.id = t.gastgeber_id
      LEFT JOIN users e ON e.id = t.erstellt_von
      WHERE t.beginnt_am <= datetime('now') AND t.gruppe_id = ?
        AND (? = '' OR t.beginnt_am < ? OR (t.beginnt_am = ? AND t.id < ?))
      ORDER BY t.beginnt_am DESC, t.id DESC
      LIMIT ?
    `).bind(g.gruppe.id, zeiger, zeiger, zeiger, zeigerId, anzahl + 1).all();

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
          WHERE gruppe_id = ? AND ziel_art = 'termin' AND ziel_id IN (${platz})
        `).bind(g.gruppe.id, ...ids),
        env.DB.prepare(`
          SELECT ziel_art, ziel_id, count(*) AS anzahl FROM kommentare
          WHERE gruppe_id = ? AND geloescht_am IS NULL AND ziel_art = 'termin'
            AND ziel_id IN (${platz})
          GROUP BY ziel_art, ziel_id
        `).bind(g.gruppe.id, ...ids),
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

    /* Wen der Regenbogen heute trifft. Das Kontor bekommt ihn seit dem
       Umbau auf die Farbwahl AUCH - ein Mensch soll auf allen Blättern
       dieselbe Farbe tragen, und "ausser im Kontor" waere genau die Ausnahme,
       die man beim Vergleichen zweier Bilder nicht im Kopf hat.

       Er kommt hier aber NICHT als Marke in `farbe`: die Farbreihe an der
       Karte muss weiter zeigen, welche Kreide gewaehlt ist - das ist ja die
       Farbe, auf die er zurueckfaellt, sobald es einen anderen trifft. Also
       zwei Felder: `farbe` die Kreide, `stolz_heute` der Regenbogen. */
    const traeger = await stolzTraeger(env);
    const [leute, mails, regel] = await env.DB.batch([
      env.DB.prepare(`
        SELECT u.id, u.name, u.email, u.rolle, u.quelle, u.erstellt,
               u.gesperrt_am, u.gesperrt_grund, u.entfernt_am,
               u.mail_stumm_am, u.mail_prefs, u.stolz, u.geburtstag,
               -- Der Platz in der Kreidereihe, und daneben ob er GEWAEHLT ist:
               -- das Kontor zeigt "automatisch" anders an als "so bestellt".
               ${farbeSql()} AS farbe, u.farbe AS farbe_gewaehlt,
               coalesce(g.name, 'Ehemaliger') AS gesperrt_von,
               (SELECT count(*) FROM tokens t      WHERE t.user_id = u.id)   AS geraete,
               (SELECT count(*) FROM reports r     WHERE r.user_id = u.id)   AS meldungen,
               (SELECT max(r.gemeldet_am) FROM reports r WHERE r.user_id = u.id) AS zuletzt,
               (SELECT count(*) FROM kommentare k  WHERE k.autor_id = u.id)  AS kommentare,
               -- Nur echte Gastgeberschaften: auswaerts steht in der Spalte
               -- bloss der, der den Abend ausgemacht hat (migrations/0024).
               (SELECT count(*) FROM termine  t
                 WHERE t.gastgeber_id = u.id AND t.ort IS NULL)              AS gastgeber,
               (SELECT count(*) FROM bewertungen b
                 WHERE b.ziel_art = 'user' AND b.ziel_id = u.id)             AS bewertet
        FROM users u
        LEFT JOIN users g ON g.id = u.gesperrt_von
        ORDER BY u.entfernt_am IS NOT NULL, u.name IS NULL, u.name COLLATE NOCASE
      `),
      /* Die Kachel "Mails, 24 h". Dieselben zwei Toepfe wie in der Statistik
         (siehe dort Abfrage 7): sonst nennt der Kopf eine kleinere Zahl als
         das Bild darunter, und beide haetten recht. */
      env.DB.prepare(`
        SELECT sum(n) AS n, sum(kaputt) AS kaputt FROM (
          SELECT count(*) AS n, sum(fehler IS NOT NULL) AS kaputt
          FROM mail_ausgang WHERE gesendet_am > datetime('now','-1 day')
          UNION ALL
          SELECT sum(anzahl), sum(kaputt) FROM versand_ausgang
          WHERE weg = 'mail' AND erstellt > datetime('now','-1 day')
        )
      `),
      // Ob die Regenbogenvergabe ueberhaupt laeuft (Schema 29). Eine Zeile,
      // und sie reitet hier mit, statt eine eigene Route zu bekommen.
      env.DB.prepare('SELECT aktiv FROM stolz_regel WHERE id = 1'),
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
        // Laeuft die Regenbogenvergabe? Und wen kann sie treffen - gezaehlt
        // aus derselben Liste, damit der Schalter sagen kann, ob sein Kreis
        // ueberhaupt jemanden enthaelt.
        stolz_aktiv: !!(regel.results[0] && regel.results[0].aktiv),
        stolz_kreis: alle.filter(u => !u.entfernt_am && u.stolz).length,
      },
      nutzer: alle.map(u => ({
        id: u.id,
        name: u.name,
        // Im Klartext, und das mit Absicht: ohne sie ist die Nutzerverwaltung
        // blind. Die Seite dahinter liegt hinter der Adminpruefung.
        email: u.email,
        rolle: u.rolle,
        gemessen: u.quelle === 'ha',
        // Welche Kreide er traegt, und ob das seine Wahl war oder die
        // Anmeldereihenfolge (siehe migrations/0028).
        farbe: u.farbe,
        farbe_gewaehlt: u.farbe_gewaehlt != null,
        /* Ob er den Regenbogen als Farbe gewaehlt hat - und ob er ihn HEUTE
           auch traegt. Immer nur einer traegt ihn; die anderen aus dem Kreis
           schreiben so lange in ihrer Kreide (Schema 29). */
        stolz: !!u.stolz,
        stolz_heute: u.id === traeger,
        /* Der eingetragene Tag, so wie er dasteht (Schema 31) - 'MM-TT' oder
           'JJJJ-MM-TT'. ROH und nicht als "hat heute": das Kontor ist die
           Stelle, an der er GEAENDERT wird, und dafuer muss dastehen, was
           drinsteht. Ob heute jemand feiert, sieht der Wirt auf der Tafel wie
           alle anderen. */
        geburtstag: u.geburtstag || null,
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
    if (!['sperren', 'entsperren', 'rolle', 'entfernen', 'farbe', 'stolz', 'geburtstag']
      .includes(aktion)) {
      return fehler(request, "aktion: 'sperren', 'entsperren', 'rolle', 'entfernen', " +
        "'farbe', 'stolz' oder 'geburtstag'");
    }

    const ziel = await env.DB.prepare(`
      SELECT id, name, email, rolle, quelle, gesperrt_am, entfernt_am, stolz
      FROM users WHERE id = ?
    `).bind(Number(daten.id)).first();
    if (!ziel) return fehler(request, 'Den gibt es nicht', 404);
    if (ziel.entfernt_am) return fehler(request, 'Der ist schon entfernt', 409);

    /* Vor jeder Handlung geholt, nicht danach: 'entfernen' loescht die
       Mitgliedschaft selbst (siehe unten), und ein Anstoss NACH dem Loeschen
       faende keine Gruppe mehr - dessen Tafeln muessten aber gerade DANN
       erfahren, dass er raus ist. Dieselbe Liste traegt unten das Nachruecken. */
    const zielGruppen = (await env.DB.prepare(
      'SELECT gruppe_id AS id FROM gruppen_mitglied WHERE user_id = ?')
      .bind(ziel.id).all()).results.map(z => z.id);

    // --- Die drei Schutzregeln, vor jeder Handlung ---------------------------
    /* Die eigene Farbe ist ausdruecklich erlaubt. Die Selbstregel darunter
       schuetzt davor, sich das Kontor zuzuschliessen - eine Kreide kann das
       nicht, und wer seine Farbe nicht selbst waehlen darf, braucht die Wahl
       nicht. Sie war der Anlass fuer die ganze Spalte.

       Fuer den Regenbogenkreis (`stolz`) gilt dasselbe aus demselben Grund,
       und aus einem zweiten dazu: sich selbst hineinzunehmen oder
       herauszunehmen ist die Handlung, bei der eine Rueckfrage am wenigsten
       zu suchen hat. Und der eigene Geburtstag (Schema 31) ist die einzige
       Angabe im ganzen Kontor, bei der der Betreffende die Wahrheit sicher
       kennt und alle anderen sie raten. */
    const gegenMich = ziel.id === ich.id;
    if (gegenMich && aktion !== 'entsperren' && aktion !== 'farbe' && aktion !== 'stolz'
      && aktion !== 'geburtstag') {
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
       Instanz hat er eine: der Melder aus der Wohnung ist zugleich das
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
      /* Die Push-Abos gehen mit. `stosse` filtert Gesperrte ohnehin heraus,
         genau wie `benachrichtige` - die Zeile stehen zu lassen waere also
         folgenlos, aber sie waere ein offener Zustellweg zu jemandem, der
         gerade hinausgebeten wurde. Beim Entsperren kommt das Abo von selbst
         zurueck: die Seite meldet es bei jedem Start neu an. */
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE users SET gesperrt_am = datetime('now'), gesperrt_von = ?, gesperrt_grund = ?
          WHERE id = ?
        `).bind(ich.id, grund || null, ziel.id),
        env.DB.prepare('DELETE FROM push_abos WHERE user_id = ?').bind(ziel.id),
      ]);

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

    } else if (aktion === 'farbe') {
      /* Ein PLATZ in der Kreidereihe, kein Farbwert - warum, steht in
         migrations/0028. `null` gibt ihn wieder frei und stellt damit die
         Anmeldereihenfolge her; das ist kein Sonderfall, sondern der
         Ausgangszustand jeder Zeile.

         Doppelte Plaetze sind erlaubt: ohne sie liesse sich kein Tausch
         machen, ohne einen der beiden erst auf einen dritten zu schieben. */
      const roh = daten.farbe;
      const platz = roh === null || roh === undefined ? null : Number(roh);
      if (platz !== null && (!Number.isInteger(platz) || platz < 0 || platz >= FARBEN)) {
        return fehler(request, `farbe: 0 bis ${FARBEN - 1} oder null`);
      }
      detail = platz === null ? 'automatisch' : String(platz);
      await env.DB.prepare('UPDATE users SET farbe = ? WHERE id = ?')
        .bind(platz, ziel.id).run();

    } else if (aktion === 'stolz') {
      /* Der Kreis, aus dem taeglich einer gezogen wird (Schema 29). Ein
         Umschalter und kein Wert: der Knopf im Kontor traegt den Zustand
         schon, ein mitgeschickter waere eine zweite Wahrheit daneben.
         Ob die Vergabe ueberhaupt laeuft, steht woanders - `POST
         /api/admin/stolz`. */
      const neu = ziel.stolz ? 0 : 1;
      detail = neu ? 'im Kreis' : 'raus';
      await env.DB.prepare('UPDATE users SET stolz = ? WHERE id = ?')
        .bind(neu, ziel.id).run();

    } else if (aktion === 'geburtstag') {
      /* Ein WERT und kein Umschalter (Schema 31): 'MM-TT', 'JJJJ-MM-TT' oder
         `null` zum Loeschen. Geprueft wird in `geburtstagPruefen` - dieselbe
         Stelle, die auch der Deckel benutzt, damit hier nicht angenommen wird,
         was dort abgewiesen wird. */
      const geprueft = geburtstagPruefen(daten.geburtstag);
      if (geprueft.fehler) return fehler(request, geprueft.fehler);
      detail = geprueft.wert || 'geloescht';
      await env.DB.prepare('UPDATE users SET geburtstag = ? WHERE id = ?')
        .bind(geprueft.wert, ziel.id).run();

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
      // Wo er ueberall drin war, steht schon in `zielGruppen` (vor jeder
      // Handlung geholt) - und genau dort muss gleich jemand nachruecken.
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE users SET entfernt_am = datetime('now'),
                           email = NULL, name = NULL, name_klein = NULL,
                           mail_prefs = NULL, mail_stumm_am = NULL
          WHERE id = ?
        `).bind(ziel.id),
        env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(ziel.id),
        // Und der Meldeweg dazu. Ein Entfernter, dem weiter aufs Handy
        // geklopft wird, waere die haesslichste Art, das Wort "entfernt" zu
        // widerlegen.
        env.DB.prepare('DELETE FROM push_abos WHERE user_id = ?').bind(ziel.id),
        /* UND AUS ALLEN RUNDEN (Schema 32). Eine Mitgliedschaft ist kein
           Beitrag, der als "Ehemaliger" stehenbleiben soll - sie ist eine
           Aussage ueber die Gegenwart, und der Entfernte ist nicht mehr da.
           Bliebe die Zeile, haette das drei Folgen auf einmal: die
           Mitgliederzahl auf der Kachel zaehlte ihn weiter mit (und
           widerspraeche der Liste daneben, die Entfernte ausblendet), eine
           oeffentliche Runde bliese damit die einzige Zahl auf, die ein
           Fremder von ihr sieht - und war er Gruppenadmin, faende
           `nachruecken()` fuer immer seine Geisterzeile und liesse die Runde
           ohne handlungsfaehige Fuehrung zurueck. */
        env.DB.prepare('DELETE FROM gruppen_mitglied WHERE user_id = ?').bind(ziel.id),
        env.DB.prepare('DELETE FROM push_stumm WHERE user_id = ?').bind(ziel.id),
      ]);
      /* Und fuer jede Runde, die er gefuehrt hat, rueckt jemand nach. NACH dem
         Loeschen und einzeln, weil `nachruecken` seine eigene Pruefung fuehrt
         und dabei schreibt; die Liste wird darum VORHER geholt. */
      for (const id of zielGruppen) await nachruecken(env, ctx, id, ich.id);
    }

    await env.DB.prepare(
      'INSERT INTO admin_log (admin_id, aktion, ziel_id, detail) VALUES (?, ?, ?, ?)')
      .bind(ich.id, aktion, ziel.id, detail).run();

    /* Sperren, Entfernen und der Rollenwechsel aendern die Tafel: der eine
       faellt aus dem Topf, der andere aus der Liste. Farbe und Regenbogenkreis
       aendern sie auch, nur milder - da faellt niemand heraus, es sieht bloss
       anders aus. Ohne Anstoss sehen die offenen Seiten den alten Stand bis
       zum naechsten Nachfassen.

       Geweckt werden SEINE Tafeln (`zielGruppen`), nicht die des handelnden
       Admins - siehe die Begruendung oben an `zielGruppen`. */
    for (const gid of zielGruppen) anstossGruppe(gid, request, env, ctx, 'tafel');
    return antwort(request, { ok: true, aktion, id: ziel.id }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* Der Schalter ueber der Regenbogenvergabe (Schema 29). Eine eigene Route,
     weil er an KEINEM Mitglied haengt: `POST /api/admin/nutzer` verlangt ein
     Ziel und prueft es gegen vier Schutzregeln, von denen hier keine greift.

     Und ein eigener Schalter neben dem Kreis, weil "niemand ist im Kreis" und
     "die Vergabe ruht" von aussen gleich aussehen, aber nicht dasselbe sind:
     das eine loescht die Auswahl, das andere legt sie schlafen. */
  'POST /api/admin/stolz': async (request, env, ctx) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const daten = await json(request);

    /* ZWEI Handgriffe an derselben einen Zeile, und darum an derselben Route:
       der Schalter und das Weiterdrehen (Schema 30). Getrennte Routen waeren
       zweimal dieselbe Adminpruefung fuer zwei Aenderungen an `stolz_regel`.

       Weitergedreht wird um EINEN Schritt und nicht neu gewuerfelt: ein
       echter Wurf faellt bei zweien im Kreis in der Haelfte der Faelle wieder
       auf denselben, und ein Knopf, der sichtbar nichts tut, sieht kaputt
       aus. Wer heute dran ist, rechnet `stolzTraeger` weiterhin aus dem
       Biertag - hier wird nur die Verschiebung erhoeht. */
    if (daten && daten.weiter === true) {
      await env.DB.batch([
        env.DB.prepare('UPDATE stolz_regel SET versatz = versatz + 1 WHERE id = 1'),
        env.DB.prepare(
          'INSERT INTO admin_log (admin_id, aktion, ziel_id, detail) VALUES (?, ?, ?, ?)')
          .bind(ich.id, 'stolz_regel', null, 'weitergedreht'),
      ]);
      anstossAlle(request, env, ctx, 'tafel');
      return antwort(request, { ok: true, weiter: true, traeger: await stolzTraeger(env) },
        200, KEIN_FREMDER_CACHE);
    }

    if (!daten || typeof daten.aktiv !== 'boolean') {
      return fehler(request, 'aktiv: true oder false — oder weiter: true');
    }
    const aktiv = daten.aktiv ? 1 : 0;

    await env.DB.batch([
      env.DB.prepare('UPDATE stolz_regel SET aktiv = ? WHERE id = 1').bind(aktiv),
      /* Ins Protokoll wie jede andere Handlung des Wirts - ohne Ziel-Id, denn
         es gibt keine: der Schalter gilt der ganzen Runde. */
      env.DB.prepare(
        'INSERT INTO admin_log (admin_id, aktion, ziel_id, detail) VALUES (?, ?, ?, ?)')
        .bind(ich.id, 'stolz_regel', null, aktiv ? 'an' : 'aus'),
    ]);

    // Die Tafel faerbt sich damit um - sofort, nicht beim naechsten Nachfassen.
    anstossAlle(request, env, ctx, 'tafel');
    return antwort(request, { ok: true, aktiv: !!aktiv }, 200, KEIN_FREMDER_CACHE);
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
     gebunden statt eingesetzt: er landet in `datetime('now', ?)`.

     Die fuenf Kassenbilder haengen NUR hier, nicht in `/api/admin/statistik`
     - das Kontor bekommt Ranglisten der RUNDE ueber den Gruppenwaehler, aber
     ist die Verwaltung der Instanz, keine Kassenansicht (siehe `gruppe.html`
     dafuer). `?monat=` waehlt den Kalendermonat (Entscheidung 28), unabhaengig
     vom `?tage=`-Fenster der elf. Ohne `kasse_an` fehlt der Schluessel
     `kasse` in der Antwort komplett - die Seite prueft `if (s.kasse)` und
     zeichnet sonst nichts, statt eine leere Reihe leerer Bilder zu zeigen. */
  'GET /api/statistik': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const g = await inGruppe(request, env, ich, null, 'statistik_an');
    if (g instanceof Response) return g;

    const { tage, fenster, vorlauf, von, bis } = statistikFenster(request);
    const { monat, jahr, monatZahl, von: mVon, bis: mBis } = statistikMonat(request);
    const traeger = await stolzTraeger(env);
    const runde = statistikAbfragen(env, fenster, vorlauf, g.gruppe.id, traeger);
    const kasse = g.gruppe.kasse_an
      ? kasseAbfragen(env, g.gruppe.id, jahr, monatZahl, traeger) : [];
    /* DREI Bloecke seit Etappe 8, jeder an seinem eigenen Schalter - und
       darum wird ueber `length` geschnitten und nie ueber eine getippte
       Position. Eine Gruppe mit Regeln, aber ohne Kasse liest den dritten
       Block dort, wo bei einer anderen der zweite steht. */
    const regeln = g.gruppe.regeln_an
      ? regelnAbfragen(env, g.gruppe.id, jahr, monatZahl, traeger) : [];
    const ergebnis = await env.DB.batch([...runde, ...kasse, ...regeln]);
    const nachRunde = runde.length;
    const nachKasse = nachRunde + kasse.length;
    return antwort(request, {
      /* `von`/`bis` sind die Kanten der Achse, nicht des Filters (siehe
         `statistikFenster`). Sie stehen neben `tage`, weil sie dasselbe sagen -
         nur in Tagen statt in einer Zahl. */
      tage, von, bis, ...statistikRunde(ergebnis.slice(0, nachRunde), tage),
      kasse: kasse.length
        ? statistikKasse(ergebnis.slice(nachRunde, nachKasse), monat, mVon, mBis) : undefined,
      regeln: regeln.length
        ? statistikRegeln(ergebnis.slice(nachKasse, nachKasse + regeln.length), monat) : undefined,
      // Damit der Holzrahmen dieser Seite weiss, ob er heute bemalt ist -
      // dieselbe Auskunft wie in `/api/me`, nur ohne eine zweite Runde.
      stolz_heute: traeger === ich.id,
    }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  /* `statistik_an` prueft diese Route NICHT - der Wirt fuehrt Aufsicht ueber
     die ganze Instanz (Entscheidung 25) und soll eine Runde nicht deshalb
     nicht mehr einsehen koennen, weil ihr Admin den Einstieg fuer sich
     abgeschaltet hat. `inGruppe()` prueft trotzdem, dass die Gruppe existiert -
     der Wirt kommt ueberall hinein, auch ohne Mitgliedschaft. */
  'GET /api/admin/statistik': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    /* Ohne `?g=` zeigt das Kontor die Auffanggruppe - beim ersten Aufruf
       kennt die Seite noch keine Wahl. Ueber den SLUG gesucht, nicht ueber
       die Id 1: der Worker darf sich darauf nicht verlassen (migrations/0032).

       DER SLUG HEISST SEIT 0039 `crew-waf`, vorher `am-tresen`. Die beiden
       gehoeren zusammen ausgerollt: stuende hier der alte und in der Datenbank
       der neue, faende das Kontor beim ersten Aufruf keine Gruppe. */
    const url = new URL(request.url);
    if (!url.searchParams.get('g')) {
      const heim = await env.DB.prepare(
        "SELECT id FROM gruppen WHERE slug = 'crew-waf'").first();
      if (heim) {
        url.searchParams.set('g', String(heim.id));
        request = new Request(url, request);
      }
    }
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;

    const { tage, fenster, vorlauf } = statistikFenster(request);
    /* Auch hier der Regenbogen: wer ihn heute traegt, traegt ihn auf JEDEM
       Blatt. Ein Melder, der in der Statistik der Runde bunt ist und im
       Kontor gruen, waere beim Vergleich zweier Bilder eine Falle. */
    const traeger = await stolzTraeger(env);

    /* Alles in EINEM batch, die Runde und der Betrieb zusammen: zwei Batches
       waeren zwei Rundfluege zur Datenbank fuer eine einzige Seitenansicht.
       `runde.length` statt einer von Hand gezaehlten Zahl (vormals
       `STATISTIK_ABFRAGEN`) - der Schnitt haengt jetzt an der Laenge des
       Arrays, nicht an einer Ziffer, die beim naechsten Bild in
       `statistikAbfragen` sonst falsch waere. */
    const runde = statistikAbfragen(env, fenster, vorlauf, g.gruppe.id, traeger);
    const ergebnis = await env.DB.batch([
      ...runde,
      /* 7 — Mails je Art, Fehler daneben. AUS ZWEI TOEPFEN seit 0025:
         `mail_ausgang` fuehrt die Meldungen des Verteilers (eine Zeile je
         Empfaenger, darum `count(*)`), `versand_ausgang` die fuenf, die daran
         vorbeigehen - Anmeldelink, Adresswechsel hin und zurueck,
         Betreibermeldung, Testmail (eine Zeile je Vorgang, darum
         `sum(anzahl)`). Die aeussere Gruppierung faellt beides auf dieselbe
         Art zusammen, falls je eine Meldung beide Wege nimmt. */
      env.DB.prepare(`
        SELECT art, sum(n) AS n, sum(kaputt) AS kaputt FROM (
          SELECT art, count(*) AS n, sum(fehler IS NOT NULL) AS kaputt
          FROM mail_ausgang WHERE gesendet_am > datetime('now', ?1)
          GROUP BY art
          UNION ALL
          SELECT art, sum(anzahl), sum(kaputt)
          FROM versand_ausgang
          WHERE weg = 'mail' AND erstellt > datetime('now', ?1)
          GROUP BY art
        ) GROUP BY art ORDER BY n DESC
      `).bind(fenster),
      /* 7b — dieselben Mails, aber je Tag: die Kachel "Mails, 24 h" im Kopf
         nennt eine einzelne Zahl, und eine einzelne Zahl sagt nicht, ob das
         viel ist. Die Linie darunter schon. Dieselben zwei Toepfe wie oben -
         zwei Zaehlweisen fuer dieselbe Frage waeren die sicherste Art, dass
         Kachel und Balken sich widersprechen. */
      env.DB.prepare(`
        SELECT tag, sum(n) AS n FROM (
          SELECT date(gesendet_am) AS tag, count(*) AS n
          FROM mail_ausgang WHERE gesendet_am > datetime('now', ?1)
          GROUP BY tag
          UNION ALL
          SELECT date(erstellt) AS tag, sum(anzahl)
          FROM versand_ausgang
          WHERE weg = 'mail' AND erstellt > datetime('now', ?1)
          GROUP BY tag
        ) GROUP BY tag ORDER BY tag
      `).bind(fenster),
      /* 7c — und das Klopfen an der Tuer, das bis 0025 gar nicht gezaehlt
         wurde. Eigenes Bild und kein zweiter Balken im Mail-Diagramm: die
         Zahlen sind nicht gegeneinander lesbar. Eine Mail geht an eine
         Adresse, ein Push an jedes Geraet - wer zwei hat, zaehlt zweimal. */
      env.DB.prepare(`
        SELECT art, sum(anzahl) AS n, sum(kaputt) AS kaputt
        FROM versand_ausgang
        WHERE weg = 'push' AND erstellt > datetime('now', ?1)
        GROUP BY art ORDER BY n DESC
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
        SELECT z.user_id, coalesce(u.name,'Ehemaliger') AS name,
               ${farbeSql('u', traeger)} AS farbe, count(*) AS n
        FROM zugriffe z JOIN users u ON u.id = z.user_id
        GROUP BY z.user_id ORDER BY n DESC
      `),
      env.DB.prepare('SELECT count(*) AS n FROM zugriffe'),
      // Fuer den Gruppenwaehler im Kontor (Entscheidung 25): ALLE Gruppen,
      // nicht nur die, in denen der Wirt selbst Mitglied ist.
      env.DB.prepare('SELECT id, name FROM gruppen ORDER BY name COLLATE NOCASE'),
      /* SEIT WANN diese Gruppe existiert - fuer die Jahresliste des
         Rueckblicks im Kontor (Etappe 11). Sie rechnete bis dahin aus der
         Wachstumskurve, und die zaehlt `users.erstellt`: ein Mensch von 2023,
         der 2026 einer neuen Gruppe beitritt, steht dort mit 2023: Das Kontor
         bot dann ein Jahr an, das `GET /api/wrapped` mit 400 abweist. Dieselbe
         Quelle wie dort - `min(beigetreten)`, aus `users.erstellt`
         zurueckgefuellt (0032) und deshalb auch fuer die Auffanggruppe richtig,
         die erst im August 2026 angelegt wurde. */
      env.DB.prepare(
        'SELECT min(beigetreten) AS seit FROM gruppen_mitglied WHERE gruppe_id = ?')
        .bind(g.gruppe.id),
    ]);

    const [mails, mailsJeTag, pushs, postwillig,
           aufrufeJeNutzerTag, aufrufeJeNutzer, aufrufeInsgesamt, alleGruppenZeilen,
           gruppeSeit] =
      ergebnis.slice(runde.length);

    /* Die Saeule je Tag, aus den flachen Zeilen gebaut: eine Gruppe je Tag,
       ein Feld je Nutzer darin. Die Reihenfolge der Reihen folgt der
       Rangliste `aufrufeJeNutzer` (meistbeschaeftigt zuerst) - dieselbe
       Reihenfolge, mit der die Seite ihnen Farben zuteilt. */
    const aufrufeNutzerReihen = aufrufeJeNutzer.results.map(z => ({
      feld: 'u' + z.user_id, titel: z.name, farbe: z.farbe,
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
      // Welche Runde diese elf Bilder zeigen, und was sich sonst waehlen
      // liesse - der Gruppenwaehler im Kontor (Entscheidung 25).
      // `seit` ist der Boden der Jahresliste im Kontor - siehe die Abfrage.
      gruppe: { id: g.gruppe.id, name: g.gruppe.name,
                seit: (gruppeSeit.results[0] || {}).seit || null },
      gruppen: alleGruppenZeilen.results,
      ...statistikRunde(ergebnis, tage),
      mails: mails.results.map(m => ({ ...m, kaputt: m.kaputt || 0 })),
      mails_je_tag: mailsJeTag.results,
      pushs: pushs.results.map(m => ({ ...m, kaputt: m.kaputt || 0 })),
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

    /* Die Gruppe, und zwar VOR allem anderen (Etappe 11). Bis hierher rechnete
       der Rueckblick ueber die ganze Instanz: "Eiskoenig" zaehlte Platz-1-Tage
       aller Menschen und zeigte ihre NAMEN in einem Balkenbild, "Das Rad"
       summierte alle Lose, "Was gesagt wurde" alle Kommentare. Mit der zweiten
       Gruppe war das eine Preisgabe ueber die Gruppengrenze hinweg - genau das,
       wogegen `inGruppe()` gebaut wurde. Der Rueckblick war die letzte
       Leseroute des Repos ohne diese Pruefung. */
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;
    /* Der Schalter von HAND und nicht ueber `inGruppe(…, 'statistik_an')` -
       genau wie bei `GET /api/admin/statistik`: der Wirt fuehrt Aufsicht ueber
       die ganze Instanz (Entscheidung 25) und soll eine Runde nicht deshalb
       nicht mehr einsehen koennen, weil ihr Admin den Einstieg fuer sich
       abgeschaltet hat. */
    if (!istAdmin(ich) && !g.gruppe.statistik_an) {
      return fehler(request, `Das ist in „${g.gruppe.name}" abgeschaltet`, 403);
    }
    const gruppeId = g.gruppe.id;

    const url = new URL(request.url);
    const jahr = Number(url.searchParams.get('jahr'));
    const heuteJahr = new Date().getUTCFullYear();
    // `String(jahr).length` allein liesse ein negatives Jahr durch (das
    // Minuszeichen zaehlt nicht mit) - deshalb zusaetzlich `jahr >= 1000`.
    if (!Number.isInteger(jahr) || jahr < 1000 || String(jahr).length !== 4) {
      return fehler(request, 'jahr: eine vierstellige Jahreszahl');
    }
    if (jahr > heuteJahr) return fehler(request, 'Dieses Jahr ist noch nicht dran');

    /* Vor dem grossen Rundflug: gibt es DIESE GRUPPE in diesem Jahr ueberhaupt
       schon? Billiger, hier abzubrechen, als erst den ganzen batch zu fahren
       und danach wegzuwerfen.

       `min(beigetreten)` aus `gruppen_mitglied`, nicht `min(users.erstellt)`
       (instanzweit und ab Etappe 11 falsch) und ausdruecklich auch nicht
       `gruppen.erstellt`: die Auffanggruppe "Crew WAF" wurde von Migration 0032
       mit `datetime('now')` angelegt, also im August 2026 - sie wuerde 2025
       abweisen, obwohl ihre Daten weiter zurueckreichen. `beigetreten` ist
       dagegen aus `users.erstellt` zurueckgefuellt worden (0032, ausdruecklich
       und mit Begruendung) und ist damit genau die Quelle, die hier gebraucht
       wird.

       In derselben Runde: MEIN Beitrittsdatum. Es begrenzt die drei
       persoenlichen Abfragen (15/16/17) - siehe den langen Kommentar dort. Ein
       Wirt ohne Mitgliedschaft hat keines; dann entfaellt der Ich-Teil. */
    const [erster, meins] = await env.DB.batch([
      env.DB.prepare(
        'SELECT min(beigetreten) AS beigetreten FROM gruppen_mitglied WHERE gruppe_id = ?')
        .bind(gruppeId),
      env.DB.prepare(
        'SELECT beigetreten FROM gruppen_mitglied WHERE gruppe_id = ? AND user_id = ?')
        .bind(gruppeId, ich.id),
    ]);
    const ersteZeile = erster.results[0] || {};
    const ersteJahr = ersteZeile.beigetreten
      ? Number(ersteZeile.beigetreten.slice(0, 4)) : heuteJahr;
    if (jahr < ersteJahr) {
      return fehler(request, `Vor ${ersteJahr} gab es „${g.gruppe.name}" noch nicht`);
    }
    /* `meinBeitritt` ist null fuer den Wirt, der ohne Mitgliedschaft
       hereinkommt. Die Ich-Abfragen laufen dann trotzdem mit - ein batch hat
       eine feste Laenge, und ein Loch darin waere die Sorte gezaehlte Position,
       die Etappe 6 gerade beseitigt hat. Sie bekommen stattdessen ein Fenster,
       das nichts durchlaesst, und die ANTWORT traegt `ich: null`.

       Der Platzhalter statt `bind(null)`: `gemeldet_am >= NULL` ist in SQL
       NULL, nicht falsch, und wuerde je nach Umgebung still alles ODER nichts
       liefern. Eine Jahreszahl, hinter der es keine Meldung gibt, ist die
       Antwort, die man beim Lesen sofort versteht. */
    const meinBeitritt = (meins.results[0] || {}).beigetreten || null;
    const meinFenster = meinBeitritt || '9999-12-31 00:00:00';

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

    /* Der Regenbogen gilt auch im Rueckblick (Schema 29), obwohl der ein
       ganzes Jahr zeigt: er ist eine Auszeichnung von HEUTE, und der
       Rueckblick wird heute gelesen. Traege ihn nur die Tafel und nicht das
       Blatt darin, stuende derselbe Mensch auf einer Seite in zwei Farben. */
    const traeger = await stolzTraeger(env);

    /* Welche Bloecke ueberhaupt laufen, entscheidet der WORKER - die Seite
       entscheidet nur, wie viele Kacheln davon uebrig bleiben (Etappe 11).
       Dieselbe Arbeitsteilung wie bei `GET /api/statistik`, und aus demselben
       Grund: eine Gruppe ohne Kasse soll keine Kassenabfrage bezahlen, und die
       Seite soll nicht aus leeren Zahlen erraten muessen, ob etwas fehlt oder
       nichts da ist.

       ALLES IN EINEM `batch()`, ausgelesen ueber die `.length` der Bloecke und
       NIEMALS ueber eine getippte Position - genau der Fehler, den Etappe 6 an
       der Statistik schon einmal repariert hat. `nimm()` schiebt den Zeiger
       selbst weiter; eine Zahl steht in diesem Abschnitt nirgends. */
    const gemeinsam = { gruppeId, traeger, jahr, jahrStart, letzterTag,
                        jahrStartVoll, jahrEndeExkl, jahrPrefix,
                        ichId: ich.id, meinFenster };
    const abNamen  = wrappedNamenAbfragen(env, gemeinsam);
    const abPrivat = privatSeite(g.gruppe) ? wrappedPrivatAbfragen(env, gemeinsam) : [];
    const abSeit   = vereinSeite(g.gruppe) ? wrappedVereinSeitAbfragen(env, gemeinsam) : [];
    const abKasse  = g.gruppe.kasse_an     ? wrappedKasseJahrAbfragen(env, gemeinsam) : [];
    const abRegeln = g.gruppe.regeln_an    ? wrappedRegelnJahrAbfragen(env, gemeinsam) : [];

    const alles = await env.DB.batch([
      ...abNamen, ...abPrivat, ...abSeit, ...abKasse, ...abRegeln,
    ]);
    let ab = 0;
    const nimm = block => alles.slice(ab, ab += block.length);
    const namenErg  = nimm(abNamen);
    const privatErg = nimm(abPrivat);
    const seitErg   = nimm(abSeit);
    const kasseErg  = nimm(abKasse);
    const regelnErg = nimm(abRegeln);

    const [leute] = namenErg;
    /* Die Privatseite kann GANZ fehlen (eine Gruppe mit Kasse und Hausordnung,
       ohne Tafel, Rad, Notruf und Termine) - dann ist `privatErg` leer, und
       jeder dieser Namen faellt auf `LEER` zurueck. Ein Rueckfall statt eines
       `if` um den halben Auswertungsblock: die Rechnungen darunter kommen mit
       leeren Listen von sich aus auf null und Nullen, und die ANTWORT laesst
       `runde` dann ganz weg (siehe unten). Ein zweiter Zweig waere derselbe
       Code ein zweites Mal. */
    const LEER = { results: [] };
    const [
      eiskoenigZeilen = LEER, meldungenJeMonat = LEER, kaeltester = LEER, waermster = LEER,
      radUebersicht = LEER, radGewonnen = LEER, abendBewertungen = LEER,
      abendKommentare = LEER, abendListe = LEER, gastgeberBewertungen = LEER,
      gastgeberAbende = LEER, kommentareZahl = LEER, reaktionDesJahres = LEER,
      bilderSplit = LEER, ichKaltSerie = LEER, ichKaeltestes = LEER,
      ichSterneVergeben = LEER,
    ] = privatErg;

    const namen = new Map(leute.results.map(u => [u.id, u.name]));
    // Die Melderfarbe daneben: dieselbe Zeile traegt sie schon, und beide
    // Balkenbilder des Rueckblicks brauchen sie.
    const farben = new Map(leute.results.map(u => [u.id, u.farbe]));
    const mitName = (zeilen, feld = 'user_id') =>
      zeilen.map(z => ({ ...z, name: namen.get(z[feld]) || 'Ehemaliger' }));

    // -- Eiskoenig ------------------------------------------------------------
    const eiskoenig = mitName(eiskoenigZeilen.results)
      .map(z => ({ id: z.user_id, name: z.name, farbe: farben.get(z.user_id) ?? null, tage: z.tage }));

    // -- wie oft gemeldet wurde, je Monat --------------------------------------
    const meldungMonat = Array(12).fill(0);
    for (const z of meldungenJeMonat.results) meldungMonat[z.monat - 1] = z.n;
    const meldungSumme = meldungMonat.reduce((a, c) => a + c, 0);

    // -- kaeltester/waermster Moment -------------------------------------------
    const momentAntwort = z => z ? {
      grad: z.grad, userId: z.user_id, name: z.name,
      // Aus derselben Karte wie die Balken daneben - wer heute den Regenbogen
      // traegt, traegt ihn auf DIESEM Blatt an jeder Stelle oder an keiner.
      farbe: farben.get(z.user_id) ?? null,
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
      gewonnen: mitName(radGewonnen.results).map(z => ({
        id: z.user_id, name: z.name, farbe: farben.get(z.user_id) ?? null, n: z.n })),
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
        terminId: t.id, wann: utc(t.beginnt_am), schnitt,
        // Auswaerts nennt das Blatt den Ort; der Name in `gastgeber_id` ist
        // dort nur der Eintragende und geht deshalb gar nicht erst hinaus.
        gastgeberName: t.ort ? null : t.gastgeber_name, ort: t.ort || null,
        // Wie ueberall: die Farbe faellt mit dem Namen weg, nicht danach.
        gastgeberFarbe: t.ort ? null : (farben.get(t.gastgeber_id) ?? null),
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
      farbe: farben.get(gastgeberGewinner.id) ?? null,
      schnitt: gastgeberGewinner.schnitt, abende: abendeJeGastgeber.get(gastgeberGewinner.id) || 0,
    } : null;

    // -- was gesagt wurde ---------------------------------------------------------
    const reaktion = reaktionDesJahres.results[0] || null;
    const bilderZeile = bilderSplit.results[0] || {};
    const gesagtes = {
      kommentare: (kommentareZahl.results[0] || { n: 0 }).n,
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
      kaeltestes: (ichKaeltestes.results[0] || {}).grad ?? null,
      sterneVergeben,
      abendeAusgerichtet: abendeJeGastgeber.get(ich.id) || 0,
    };

    // -- Der Verein ------------------------------------------------------------
    /* Dieselbe Bauart wie oben, nur kuerzer: aus jedem Block wird eine Form,
       und ein Feld, dessen Quelle nicht gelaufen ist, ist `null` - nicht 0.
       Die Seite baut eine Kachel, WENN ihre Daten da sind (`wrappedKacheln`
       hat diesen Vertrag schon), und `null` heisst dort "gibt es hier nicht",
       waehrend 0 heisst "gibt es, war aber nichts". Die beiden zu verwechseln
       hiesse, einer Gruppe ohne Hausordnung eine Kachel "0 Strafen"
       hinzustellen. */
    const seitZeile = seitErg.length ? (seitErg[0].results[0] || {}) : {};
    const vereinSeit = seitZeile.seit || null;

    const [kasseMonat = LEER, kasseJeMensch = LEER, kasseJeGetraenk = LEER,
           kasseStand = LEER, kasseNachschub = LEER, meineBuchungen = LEER,
           meineZahlmoral = LEER] = kasseErg;
    const [strafenJeRegel = LEER, strafenJeMensch = LEER, meineStrafen = LEER] = regelnErg;

    const kasse = kasseErg.length ? (() => {
      const monat = Array(12).fill(0);
      for (const z of kasseMonat.results) monat[z.monat - 1] = z.n;
      const summe = monat.reduce((a, c) => a + c, 0);
      const stand = kasseStand.results[0] || { eingenommen: 0, ausgegeben: 0, strafgeld: 0 };
      const n = kasseNachschub.results[0]
        || { lieferungen: 0, flaschen: 0, groesste: 0, wert: 0 };
      return {
        summe, monat,
        je_mensch: kasseJeMensch.results.map(z => ({
          id: z.user_id, name: z.name, farbe: z.farbe, n: z.n })),
        je_getraenk: kasseJeGetraenk.results,
        stand: {
          eingenommen: stand.eingenommen,
          strafgeld: stand.strafgeld || 0,
          ausgegeben: stand.ausgegeben,
          // Gerechnet, nicht gespeichert - wie im Monatsbild (statistikKasse).
          saldo: stand.eingenommen + (stand.strafgeld || 0) - stand.ausgegeben,
        },
        nachschub: n.lieferungen ? n : null,
      };
    })() : null;

    const regeln = regelnErg.length ? (() => {
      const jeRegel = strafenJeRegel.results;
      return {
        strafen: jeRegel.reduce((a, c) => a + c.n, 0),
        /* KEINE Geldsumme hier, und das ist Absicht. Sie liesse sich aus
           `cent` bilden - nur waere sie eine ANDERE als die `strafgeld` der
           Kassenkachel: diese Abfrage zaehlt, was verhaengt wurde
           (Statusliste von `regelnAbfragen`), jene, was als Geld gilt
           ('offen' und 'abgerechnet', Liste von `SALDO_SUMMEN_SQL`). Beide
           sind fuer ihren Zweck richtig, und beide in EINER Geschichte
           auszugeben - dreissig Sekunden auseinander, beide "Strafgeld"
           genannt - waere ein Widerspruch, den kein Leser aufloesen kann.
           Das Geld steht in der Kassenkachel, hier steht die Zahl. */
        je_regel: jeRegel,
        je_mensch: strafenJeMensch.results.map(z => ({
          id: z.user_id, name: z.name, farbe: z.farbe, n: z.n, cent: z.cent })),
      };
    })() : null;

    /* Meine Vereinsbilanz. Sie steht NEBEN `ich` und nicht darin: die eine ist
       die Bilanz an der Tafel, die andere die in der Kasse, und §4.4 des Plans
       haelt sie ausdruecklich als ZWEI Kacheln auseinander - eine
       zusammengelegte haette acht `wr-paar`-Felder, durch die man scrollt statt
       sie anzusehen. */
    const meinVerein = (kasseErg.length || regelnErg.length) ? (() => {
      const b = meineBuchungen.results[0] || { flaschen: 0, gezahlt: 0 };
      const z = meineZahlmoral.results[0] || { monate: 0, bezahlt: 0, gerechnet: 0, tage: null };
      const st = meineStrafen.results[0] || { n: 0, cent: 0 };
      return {
        flaschen: b.flaschen, gezahlt: b.gezahlt,
        strafen: st.n, strafen_cent: st.cent,
        monate: z.monate, bezahlt: z.bezahlt || 0,
        // `gerechnet` ist der Nenner des Schnitts, `monate` der der Quote -
        // zwei verschiedene Zahlen, und genau deshalb reisen beide mit. Wer
        // nie bezahlt hat, hat `gerechnet = 0`, und dann gibt es keinen
        // Schnitt statt eines schmeichelhaften.
        gerechnet: z.gerechnet,
        tage: z.gerechnet && z.tage != null ? Math.round(z.tage * 10) / 10 : null,
      };
    })() : null;

    return antwort(request, {
      jahr,
      // Welche Gruppe dieser Rueckblick zeigt - die Seite schreibt den Namen in
      // die Auftakt-Kachel. Wer in drei Gruppen ist, hat drei Rueckblicke, und
      // ohne den Namen saehen alle drei gleich aus.
      gruppe: { id: g.gruppe.id, name: g.gruppe.name },
      /* `null` statt eines leeren Gegenstuecks, auf BEIDEN Seiten: die Seite
         baut eine Kachel, wenn ihre Daten existieren. Ein `runde` voller
         Nullen waere ein Rueckblick, der behauptet, es sei nichts passiert -
         statt zu sagen, dass es diese Seite hier nicht gibt. */
      runde: privatSeite(g.gruppe) ? {
        eiskoenig,
        meldungen: meldungSumme ? { summe: meldungSumme, monat: meldungMonat } : null,
        kaeltester: momentAntwort(kaeltester.results[0]),
        waermster: momentAntwort(waermster.results[0]),
        rad, abend, gastgeber, gesagtes,
      } : null,
      verein: vereinSeite(g.gruppe) ? { seit: vereinSeit, kasse, regeln } : null,
      // Der Ich-Teil entfaellt fuer den Wirt, der nicht Mitglied ist: eine
      // eigene Bilanz in einer Gruppe, in der man nicht ist, gibt es nicht.
      ich: meinBeitritt && privatSeite(g.gruppe) ? ichAntwort : null,
      mein_verein: meinBeitritt ? meinVerein : null,
      // Ein abgeschlossenes Jahr aendert sich nie wieder - die Edge darf es
      // laenger halten. Das laufende Jahr bleibt privat/kurz wie die Bestenliste.
      // `?g=` ist Teil der URL und damit Teil des Cache-Schluessels; `Vary`
      // steht schon da, ein fremder Rueckblick kann hier nicht herauskommen.
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
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const recht = await rundmailRecht(request, env, ich, daten);
    if (recht instanceof Response) return recht;
    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);

    try {
      const wieViele = await rundmailAbschicken(env, ctx, ich.id, geprueft, recht.gruppeId);
      return antwort(request, { ok: true, empfaenger: wieViele }, 200, KEIN_FREMDER_CACHE);
    } catch (e) {
      if (e.sperre) return fehler(request, e.message, 429);
      throw e;
    }
  },

  // -------------------------------------------------------------------------
  /* Die Testmail - nur an den Admin selbst, der gerade im Kontor sitzt, und
     bewusst AUSSERHALB von `rundmailAbschicken`: keine Stundensperre (sie
     wuerde sonst den echten Versand danach blockieren) und kein `admin_log`
     (sonst stuende sie im Protokoll als Rundmail). Direkt `schickeMail`, mit
     einem Praefix im Betreff, damit sie im Postfach nicht mit einer echten
     verwechselt wird.

     SEIT 0025 WIRD SIE DOCH GEZAEHLT, unter eigener Art `testmail`. Hier
     stand vorher "kein `mail_ausgang` (sonst zaehlte sie in der
     Mail-Statistik mit)" - die Sorge war, dass eine Probe die Rundmail-Zahl
     aufblaeht. Mit einer eigenen Art tut sie das nicht: sie steht als eigener
     Balken daneben, und dass Proben gelaufen sind, ist eine Auskunft und
     keine Verfaelschung. In `mail_ausgang` landet sie weiterhin nicht - dort
     haengt die Doppel-Sperre, und die hat eine Testmail nicht verdient.

     Im Protokoll traegt genau diese Art eine rote Marke "Test" (`istProbe` in
     `admin.html`). Wer sie hier umbenennt, nimmt sie dort still ab. */
  // -------------------------------------------------------------------------
  /* Die Vorschau im Kontor - und zwar die ECHTE Mail, nicht ihr Nachbau.
     Zurueck kommt genau das HTML, das gleich in der Post liegt; das Kontor
     stellt es in einen eigenen Rahmen und redet ihm nicht hinein.

     WARUM ES DIESE ROUTE GIBT: `admin.html` hat die Mail bis hierher SELBST
     nachgebaut, mit der Auflage im Kommentar, jede Aenderung an `mailRumpf`
     nachzuziehen. Genau das ist beim Kopfstreifen vergessen worden - die
     Vorschau zeigte eine Mail, die es so nicht mehr gab. Zwei Stellen fuer
     dasselbe Aussehen halten nur so lange, wie jemand daran denkt; eine
     Stelle haelt immer.

     Nichts wird gesendet und nichts gespeichert, darum auch keine
     Stundensperre. Sie steht trotzdem hinter `istAdmin`: das Aussehen einer
     Rundmail geht niemanden etwas an, der keine schreiben darf. */
  'POST /api/admin/rundmail/vorschau': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);

    return antwort(request, {
      betreff: geprueft.betreff,
      html: mailRumpf(rundmailHtml(geprueft)),
      text: rundmailText(geprueft),
    }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
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

    /* Ausloeser und Empfaenger sind hier derselbe Mensch, und beide stehen
       trotzdem da: im Protokoll liest sich "Anna -> TESTMAIL -> an Anna"
       genau richtig - eine Probe an sich selbst ist, was es ist. */
    await mitProtokoll(env, 'testmail', () =>
      schickeMail(env, ich.email, `[Test] ${geprueft.betreff}`,
        rundmailText(geprueft), mailRumpf(rundmailHtml(geprueft))),
      { ausloeser: ich.id, namen: [ich.name] });

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
    if (!env.AGENTMAIL_KEY) return fehler(request, 'Mailversand ist nicht eingerichtet', 503);

    const daten = await json(request);
    if (!daten) return fehler(request, 'Kein JSON im Rumpf');
    const recht = await rundmailRecht(request, env, ich, daten);
    if (recht instanceof Response) return recht;
    const geprueft = rundmailPruefen(daten);
    if (geprueft.fehler) return fehler(request, geprueft.fehler);
    const p = pruefeVersand(daten.versand_am);
    if (p.fehler) return fehler(request, p.fehler);

    const zeile = await env.DB.prepare(`
      INSERT INTO rundmail_geplant
        (admin_id, gruppe_id, betreff, text, bild_url, knopf_text, knopf_link, versand_am)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(ich.id, recht.gruppeId, geprueft.betreff, geprueft.text, geprueft.bildUrl,
            geprueft.knopfText, geprueft.knopfLink, alsDbZeit(p.d)).first();

    return antwort(request, { ok: true, id: zeile.id }, 200, KEIN_FREMDER_CACHE);
  },

  // -------------------------------------------------------------------------
  'GET /api/admin/rundmail/geplant': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    const recht = await rundmailRecht(request, env, ich, null);
    if (recht instanceof Response) return recht;

    /* `gruppe_id IS ?` statt `= ?`: bei `recht.gruppeId === null` (der Wirt)
       wird daraus `gruppe_id IS NULL` und die Liste bleibt seine eigene -
       ein Gruppenadmin sieht so nur seine Gruppe, der Wirt nur die Post der
       Instanz, nie beides vermischt. 'fehlgeschlagen' steht mit da, sonst
       verschwindet eine Rundmail, deren Versand scheiterte (etwa an der
       Stundensperre), spurlos aus der Liste. */
    const zeilen = await env.DB.prepare(`
      SELECT id, betreff, text, bild_url, knopf_text, knopf_link,
             versand_am, status, fehler, empfaenger, erstellt
      FROM rundmail_geplant
      WHERE status IN ('geplant', 'fehlgeschlagen') AND gruppe_id IS ?
      ORDER BY versand_am
    `).bind(recht.gruppeId).all();

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
     ist: einmal rausgegangen oder fehlgeschlagen ruehrt niemand mehr dran.

     DIE BESITZPRUEFUNG HAENGT AN DER ZEILE, NICHT AM RUMPF (Abnahmefund vor
     dem Bau, siehe Opus-Konsultation): ein Gruppenadmin koennte sonst ein
     fremdes `gruppe`-Feld im Rumpf faelschen und die geplante Rundmail des
     Wirts oder einer anderen Gruppe abbestellen. Erst die Zeile lesen, dann
     GEGEN IHRE eigene `gruppe_id` pruefen, wer da darf. */
  'POST /api/admin/rundmail/geplant/aendern': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);

    const daten = await json(request);
    if (!daten || !daten.id) return fehler(request, 'Ohne id kein Ziel');

    const zeile = await env.DB.prepare(
      'SELECT status, gruppe_id FROM rundmail_geplant WHERE id = ?').bind(daten.id).first();
    if (!zeile) return fehler(request, 'Die gibt es nicht (mehr)', 404);

    if (zeile.gruppe_id) {
      const g = await inGruppe(request, env, ich, { gruppe: zeile.gruppe_id });
      if (g instanceof Response) return g;
      if (!istGruppenAdmin(g)) return fehler(request, 'Nicht dein Zimmer', 403);
    } else if (!istAdmin(ich)) {
      return fehler(request, 'Nicht dein Zimmer', 403);
    }

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
  /* Das Protokoll. Es fuehrt seit 0025 DREI Quellen statt einer, und damit
     hat es seine Bedeutung geaendert: aus "wer hat was verwaltet" ist "was
     ist passiert" geworden. Das war eine bewusste Bestellung, keine
     schleichende Erweiterung - vorher stand hier nur `admin_log`, und die
     Rundmail war die einzige Post, die je auftauchte (auch die nur, weil ein
     Versand durchs Kontor eine Verwaltungshandlung IST und die Zeile
     nebenbei die Stundensperre traegt).

     `quelle` unterscheidet die drei, und zwar fuer die Seite: sie waehlt
     danach das Zeichen und den Satzbau, und das Sieb darueber siebt danach.

     DIE MAILS WERDEN GEBUENDELT. Ein Notruf sind sechs Zeilen in
     `mail_ausgang` (eine je Empfaenger, das Gatter gegen die Doppelmail
     braucht sie so) - im Protokoll ist er EIN Vorgang mit einer Sechs
     daneben.

     DER BEZUG ALLEIN GENUEGT ALS SCHLUESSEL, und das ist kein Zufall,
     sondern eine Folge des UNIQUE-Index `mail_einmal` auf
     (user_id, art, bezug): zu einem Bezug kann jeder Mensch hoechstens EINE
     Mail bekommen. Damit ist eine Bezugsgruppe zwangslaeufig ein einziger
     Versandstoss und kann nicht ueber die Zeit streuen - nachgesehen, nicht
     geschlossen: ueber alle Gruppen in der Datenbank gilt `min = max` und
     `Zeilen = Empfaenger`. Eine Minute im Schluessel wuerde deshalb nichts
     trennen, was zusammengehoert, aber sehr wohl einen Stoss zerreissen, der
     zufaellig ueber eine Minutengrenze rutscht.

     DIE RUNDMAIL HAT NUR NOCH EINE ZEILE. Bis 2026-08-08 hatte sie zwei -
     "Anna -> rundmail „Betreff"" aus dem `admin_log` und "Mail -> rundmail
     · 5 Mails" aus dem Ausgang. Das war als zwei Auskuenfte gedacht (wer, und
     wie viele) und wurde als Doppelung gelesen, zu Recht: es ist EIN Vorgang,
     zwei Sekunden auseinander gebucht. Jetzt haengt die Zahl an der
     Verwaltungszeile, und der Ausgang laesst `rundmail` aus.

     Das Fenster von fuenf Minuten in dem Unterausdruck ist nicht geraten,
     sondern gedeckt: `rundmailAbschicken` legt die `admin_log`-Zeile selbst
     als Stundensperre aus, zwei Rundmails koennen also nie naeher als eine
     Stunde beieinander liegen. Die Mails wiederum stehen ein paar Sekunden
     NACH der Log-Zeile (`benachrichtige` laeuft ungewartet los, der INSERT
     kommt danach) - deshalb greift das Fenster in beide Richtungen.

     BLAETTERN STATT ABSCHNEIDEN. Vorher `LIMIT 60` und fertig; die aeltere
     Geschichte war schlicht nicht erreichbar, und ein Sieb auf der Seite
     siebte nur diese 60. Jetzt kommt eine Seite (`limit`, Vorgabe 20), ein
     `sk` als Marke fuer die naechste und `zaehler` ueber die GANZE Geschichte
     - erst damit sagt "verwaltet 3" ueber dem Blatt die Wahrheit und nicht
     "3 in den letzten 60 Zeilen".

     WARUM `sk` UND NICHT `wann`. Ein Zeitstempel taugt nicht als Marke: zwei
     Zeilen koennen auf dieselbe Sekunde fallen (ein Terminstoss und ein Push
     dazu tun das regelmaessig), und `wann < marke` verschluckte dann beim
     Blaettern die zweite. `sk` haengt Quelle, Art, Anzahl und Betroffenen an
     den Zeitstempel; die Sortierung bleibt chronologisch, weil alle drei
     Quellen ihre Zeit im selben Format 'YYYY-MM-DD HH:MM:SS' fuehren und
     lexikografisch damit gleich chronologisch ist.

     `q` SIEBT AUS DEMSELBEN GRUND HIER UND NICHT AUF DER SEITE wie `quelle`:
     dort liegt immer nur die geladene Seite. Ein Wortfilter im Browser hiesse
     "drei Treffer unter den zwanzig, die du gerade siehst" - und der vierte,
     der eine Seite tiefer liegt, waere unauffindbar, ohne dass irgendwo
     staende, dass er fehlt.

     DIE ZAEHLER AN DEN REITERN SIEBT ES NICHT MIT, absichtlich und wortgleich
     zur Runde (siehe `filterZeichnen` im Kontor): eine Zahl, die beim Tippen
     mitwandert, liest sich, als haette sich die Geschichte geaendert. Die
     Reiter sagen weiter, wie viel es GIBT; was das Wort davon uebrig laesst,
     steht darunter. */
  'GET /api/admin/protokoll': async (request, env) => {
    const ich = await nutzer(request, env);
    if (!ich) return fehler(request, 'Nicht angemeldet', 401);
    if (!istAdmin(ich)) return fehler(request, 'Nicht dein Zimmer', 403);

    const p = new URL(request.url).searchParams;
    const quelle = PROTOKOLL_QUELLEN.has(p.get('quelle')) ? p.get('quelle') : null;
    const marke = p.get('vor') || null;
    const limit = Math.min(Math.max(1, Number(p.get('limit')) || PROTOKOLL_SEITE),
                           PROTOKOLL_SEITE_MAX);

    /* Das Suchwort. `%` und `_` werden entschaerft, bevor das Muster daraus
       wird - sonst holt ein getipptes `%` die ganze Geschichte zurueck und ein
       `_` trifft jedes beliebige Zeichen. Ein Prozentzeichen ist in einem
       Betreff nichts Ausgefallenes ("30% mehr"), das ist kein Randfall.

       Die Laengengrenze ist kein Schutz, sondern Hausverstand: ein Muster von
       sechzig Zeichen findet nichts mehr, was ein Mensch gesucht hat.

       GROSS/KLEIN nimmt `LIKE` von selbst, aber nur fuer ASCII - "MUELLER"
       findet "Mueller", ein falsch geschriebenes "MÜLLER" findet "Müller"
       nicht. Das lokal nachzubauen hiesse, die Union in JS zu ziehen; das ist
       fuer einen Umlaut in falscher Schreibweise der falsche Preis. */
    const wort = (p.get('q') || '').trim().slice(0, 60);
    const muster = wort ? '%' + wort.replace(/[\\%_]/g, '\\$&') + '%' : null;

    /* Eine Zeile mehr holen als gezeigt wird: sie wird nicht ausgeliefert,
       sie beantwortet nur "gibt es noch was". Ein zweiter `count(*)` fuer
       dieselbe Frage waere eine zweite Abfrage fuer ein Ja/Nein. */
    const [seite, zaehler, verwaltet] = await env.DB.batch([
      env.DB.prepare(`
        SELECT * FROM (SELECT *, ${PROTOKOLL_SK} AS sk FROM (${PROTOKOLL_UNION}))
        WHERE (?1 IS NULL OR quelle = ?1) AND (?2 IS NULL OR sk < ?2)
          AND (?4 IS NULL OR ${PROTOKOLL_HEUHAUFEN} LIKE ?4 ESCAPE '\\')
        ORDER BY sk DESC LIMIT ?3
      `).bind(quelle, marke, limit + 1, muster),
      /* Die Zahlen an den Sieben, ueber alles. Sie kosten einen vollen
         Durchlauf der Union - vertretbar, weil das Protokoll in Zeilen misst,
         die ein Mensch ausloest, und nicht in Messwerten. */
      env.DB.prepare(`
        SELECT quelle, count(*) AS n FROM (${PROTOKOLL_UNION}) GROUP BY quelle
      `),
      /* Dieselbe Frage wie frueher, eigens noch einmal gestellt: die
         Uebersichtskarte heisst "Zuletzt im Protokoll" und meint die
         Verwaltung. Sie aus der gemischten Liste zu sieben ginge schief -
         ein einziger Notruf legt sieben Zeilen oben drauf, und nach zwei
         lebhaften Abenden staende in der Karte "noch hat niemand etwas
         verwaltet", obwohl gestern jemand gesperrt wurde. Drei Zeilen
         kosten weniger als dieser Irrtum. */
      env.DB.prepare(`
        SELECT * FROM (${PROTOKOLL_ADMIN_SELECT})
        ORDER BY wann DESC LIMIT 3
      `),
    ]);

    const form = z => ({
      quelle: z.quelle, aktion: z.aktion, wer: z.wer, wen: z.wen,
      detail: z.detail, anzahl: z.anzahl, kaputt: z.kaputt,
      ausloeser: z.ausloeser || null,
      empfaenger: protokollNamen(z.empfaenger),
      wann: utc(z.wann), sk: z.sk,
    });

    const mehr = seite.results.length > limit;
    const zeilen = seite.results.slice(0, limit).map(form);
    const gezaehlt = { alle: 0, admin: 0, mail: 0, push: 0 };
    for (const z of zaehler.results) {
      gezaehlt[z.quelle] = z.n;
      gezaehlt.alle += z.n;
    }

    return antwort(request, {
      zeilen, mehr, zaehler: gezaehlt,
      // Die Marke fuer die naechste Seite - null, wenn es keine gibt.
      weiter: mehr && zeilen.length ? zeilen[zeilen.length - 1].sk : null,
      verwaltet: verwaltet.results.map(form),
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

    /* An welcher Gruppe die Seite gerade steht - ohne Schalter, denn diese
       Route buendelt VIER Funktionen mit VIER verschiedenen Schaltern
       (Bestenliste/`tafel_an`, Rad/`rad_an`, Termine/`termine_an`,
       Notrufe/`notruf_an`). Jede davon blendet weiter unten fuer sich aus -
       ein einzelner Schalter fuer die ganze Route waere zu grob. */
    const g = await inGruppe(request, env, ich, null);
    if (g instanceof Response) return g;
    const { tafel_an: tafelAn, rad_an: radAn, termine_an: termineAn, notruf_an: notrufAn } = g.gruppe;

    const tag = bierTag();
    /* Wen der Regenbogen heute trifft (Schema 29). Die Abfrage steht hier
       oben, weil ihr Ergebnis in den TEXT der Abfragen darunter geht - ein
       gebundener Wert kaeme dafuer zu spaet. Sie kostet eine Zeile aus einer
       Tabelle mit neun Zeilen. */
    const traeger = await stolzTraeger(env);
    /* Die Geburtstagskinder (Schema 31) daneben. Sie gehen NICHT in den Text
       der Abfragen darunter - anders als der Regenbogen reiten sie auf keiner
       Farbmarke mit, sondern kommen als eigenes Feld an der Zeile heraus
       (warum, steht in 0031). Deshalb darf das hier auch nebenher laufen. */
    const kinderP = geburtstagsKinder(env);
    const [stand, best, verlauf, los, losFeld, termine, bewertungen, zaehler, chronik, notrufe] =
      await env.DB.batch([
      /* Gesperrte bleiben in der Liste stehen - das ist Historie, und ein
         Name, der ueber Nacht verschwindet, sieht nach Datenverlust aus. Sie
         tragen nur eine stille Marke und fallen aus dem Topf (losFeldStmt).
         Entfernte fallen von selbst heraus: ihr Name ist dann NULL.

         `JOIN gruppen_mitglied` seit Etappe 2 - vorher zeigte die Bestenliste
         jeden Melder der Instanz, nicht nur die dieser Gruppe. Die Antwort
         laesst die Zeilen bei `tafel_an = 0` unten einfach weg, statt hier
         schon zu sparen - dieselbe Abfrage fuer beide Faelle, ein Schalter,
         der umspringt, aendert daran nur die Sichtbarkeit, nichts Zweites. */
      env.DB.prepare(`
        SELECT u.id, u.name, u.quelle, u.gesperrt_am, r.biere, r.temperatur, r.gemeldet_am,
               /* Die Tafel kennt sonst keine Melderfarben - sie schreibt in
                  Kreide und in einer. Sie braucht die Spalte trotzdem, denn
                  auf der Marke STOLZ sitzt der Regenbogen (Schema 29), und der
                  soll auch an der Zeile stehen, nicht nur am Rad-Bogen.
                  KEINE RUECKWAERTSSTRICHE HIER DRIN - dieser Kommentar steht
                  in einem Template-Literal, und einer davon macht daraus zwei
                  Zeichenketten und aus dem Bau einen Syntaxfehler. */
               ${farbeSql('u', traeger)} AS farbe
        FROM gruppen_mitglied m
        JOIN users u ON u.id = m.user_id
        JOIN (SELECT user_id, max(id) AS id FROM reports GROUP BY user_id) j
          ON j.user_id = u.id
        JOIN reports r ON r.id = j.id
        WHERE m.gruppe_id = ? AND u.name IS NOT NULL
        ORDER BY r.biere DESC, r.gemeldet_am ASC
      `).bind(g.gruppe.id),
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
      losTagStmt(env, tag, g.gruppe.id),
      losFeldStmt(env, traeger, g.gruppe.id, tafelAn),
      termineStmt(env, traeger, g.gruppe.id),
      bewertungenStmt(env, g.gruppe.id),
      kommentarZaehlerStmt(env, g.gruppe.id),
      /* Wie viele Abende die Chronik ueberhaupt herzugeben hat. Nur die Zahl,
         und nur, damit die Seite weiss, ob der Knopf dahin einen Sinn ergibt -
         ohne sie stuende er auch an einer Tafel, hinter der nichts liegt. */
      env.DB.prepare(
        "SELECT count(*) AS n FROM termine WHERE beginnt_am <= datetime('now') AND gruppe_id = ?")
        .bind(g.gruppe.id),
      /* Die Notrufe reiten hier mit statt auf einer eigenen Route - dieselbe
         Ueberlegung wie beim Rest: eine Runde weniger, und die Marke 'tafel'
         holt sie ohne eine zweite Sorte Anstoss mit nach. Dass sie NUR in
         diesem Zweig steht, ist der Punkt: der beschnittene Stand fuer
         Vorbeikommende oben enthaelt keine Zeile davon, und das ist keine
         Sparsamkeit, sondern die Bedingung. Ein Ort geht niemanden etwas an,
         der kein Token hat. */
      notrufeStmt(env, ich.id, traeger, g.gruppe.id),
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

    /* Als Set und nicht als Liste: das Feld sucht je Zeile einmal darin, und
       bei neun Meldern ist der Unterschied keiner - aber die Absicht steht so
       da, ohne dass in der Schleife ein `includes` sitzt. */
    const geburtstage = new Set(await kinderP);

    /* `tafel_an` blendet HIER aus, nicht in der Abfrage oben - dieselbe
       Regel wie ueberall in der Schalterleiste (18): der Schalter aendert
       die Sichtbarkeit, nicht die Datenlage. */
    const feld = tafelAn ? stand.results.map(r => ({
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
      // Sein Platz in der Kreidereihe. Die Tafel liest davon nur die Marke
      // `STOLZ` - den Regenbogen (Schema 29); die neun Kreiden zeichnet sie nicht.
      farbe: r.farbe,
      /* Schema 31, und ausdruecklich NEBEN `farbe` und nicht darin: wer an
         seinem Geburtstag auch den Regenbogen traegt, soll beides tragen. Ein
         Ja/Nein und keine Zahl - das Alter gibt diese Anwendung nirgends
         heraus, gefeiert wird DASS und nicht WIE OFT. */
      geburtstag: geburtstage.has(r.id),
      best: bestmarke.get(r.id) ?? r.biere,
      verlauf: kurve.get(r.id) || [r.biere],
    })) : [];

    /* Eine halbe Minute Cache: die Seite wird oefter geladen als gemeldet. Das
       gilt auch fuer das Rad - wer selbst dreht, sieht es sofort aus der
       Antwort auf POST /api/drehen, alle anderen binnen einer halben Minute. */
    const lage = tagesLage(los.results);
    return antwort(request, {
      feld,
      /* `rad_an` blendet das ganze Rad aus - `null` wie ueberall sonst
         ("kein Rad, keine Mail, keine HA-Meldung", Entscheidung 6).
         `tafelAn` reist mit hinein: mit Tafel gewichtet nach Bestand,
         ohne Tafel gleichverteilt (Entscheidung 40). Die Liste der Termine
         geht unveraendert mit hinein, auch bei `termine_an = 0` - eine
         Zusage braucht ihren Termin, um "19 Uhr bei Basti" zu sagen, ob die
         Termine-Zunge selbst gerade zu sehen ist oder nicht. */
      los: radAn ? losAntwort(tag, lage, losTopf(losFeld.results, lage), termine.results,
                      [...geburtstage], tafelAn) : null,
      termine: termineAn ? termine.results.map(t => terminAntwort(t, noten, wieViele)) : [],
      chronik: termineAn ? chronik.results[0].n : 0,
      notrufe: notrufAn ? notrufe.results.map(n => notrufAntwort(n, ich.id)) : [],
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

/* ---------------------------------------------------------------------------
   Die Vorschauzeilen wegraeumen, an denen kein Kommentar mehr haengt.

   Eine `vorschauen`-Zeile gehoert keiner Karte, sondern einer Adresse: beim
   Loeschen eines Kommentars wird sie nur ABGEHAENGT (`vorschau_id = NULL`),
   weil dieselbe Adresse unter drei anderen Karten noch stehen kann. Und die
   Tippvorschau legt Zeilen an, die nie an einer Karte landen, weil der Link
   getippt und nicht abgeschickt wurde. Beides bleibt sonst fuer immer liegen.

   REIHENFOLGE andersherum als bei den Waisen oben - dort erst das Objekt, hier
   erst die Zeile. Der Grund ist, dass es hier ein EINZIGES Statement ist: es
   gibt kein Fenster zwischen Suchen und Loeschen, in dem sich ein frischer
   Kommentar an eine Zeile haengt, die gleich faellt. Der Preis ist ein Objekt,
   das im Bucket liegen bleibt, wenn der Lauf zwischen den beiden `await`
   stirbt - das ist unsichtbar. Ein `bild_key` ins Leere waere es nicht:
   `vorschauen` ist ein CACHE und reichte die kaputte Karte dem naechsten
   Poster derselben Adresse wieder heraus.

   NOT EXISTS und nicht NOT IN: bei `NOT IN (SELECT vorschau_id FROM
   kommentare)` genuegt ein einziges NULL darin, und die Bedingung ist fuer
   JEDE Zeile unwahr - das Aufraeumen liefe still leer, ohne Fehler. Ein Index
   auf `kommentare.vorschau_id` bleibt aus, `0022` begruendet warum; die Tafel
   hat Tausende Kommentare, nicht Millionen. */
async function vorschauenWegraeumen(env) {
  const weg = await env.DB.prepare(`
    DELETE FROM vorschauen
    WHERE id IN (
      SELECT v.id FROM vorschauen v
      WHERE v.geholt < datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM kommentare k WHERE k.vorschau_id = v.id)
      ORDER BY v.geholt
      LIMIT ?
    )
    RETURNING bild_key
  `).bind(`-${VORSCHAU_MUELL} days`, VORSCHAUEN_PRO_LAUF).all();

  /* Die Mehrzahl der Zeilen hat gar kein Bild - `fehler`-Zeilen von halb
     getippten Adressen. Ein `null` im Stapel fuer R2 waere bestenfalls
     wirkungslos, und die Zeilen sind an dieser Stelle schon weg.

     Kein `if (!env.BILDER) return` am Anfang wie bei den Waisen: ohne Bucket
     sollen die Zeilen trotzdem verschwinden. */
  const keys = weg.results.map(z => z.bild_key).filter(Boolean);
  if (keys.length && env.BILDER) await env.BILDER.delete(keys);

  return { zeilen: weg.results.length, bilder: keys.length };
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

    // Und die Vorschauen ohne Kommentar. Eigener try aus demselben Grund.
    try {
      const weg = await vorschauenWegraeumen(env);
      if (weg.zeilen) console.log(`Vorschauen weggeraeumt: ${weg.zeilen} (Bilder: ${weg.bilder})`);
    } catch (e) {
      console.error('Vorschauen:', e && e.stack || e);
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
