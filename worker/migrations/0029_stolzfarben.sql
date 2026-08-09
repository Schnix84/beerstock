-- ===========================================================================
-- Schema 29: Einer traegt heute die Regenbogenfarben.
--
-- Seit Schema 28 haengt eine Kreide am MENSCHEN: sieben Toene, einer je
-- Melder, derselbe am Rad-Bogen wie an der Kurve. Hier kommt ein ACHTER
-- Zustand dazu, der keine achte Kreide ist: einer aus einem vorher
-- bestimmten Kreis wird taeglich ausgelost und ueberall dort, wo sonst
-- seine Kreide steht, im Regenbogen gezeichnet - Bogen, Name und Bestand am
-- Glücksrad, seine Zeile auf der Tafel, seine Kurve in der Statistik.
--
-- ZWEI DINGE WERDEN GESPEICHERT, MEHR NICHT:
--
--   users.stolz          0/1 - kann es diesen Melder treffen?
--   stolz_regel.aktiv    0/1 - findet die Vergabe ueberhaupt statt?
--
-- WARUM BEIDES UND NICHT NUR EINS. "Niemand ist im Kreis" und "die Vergabe
-- ruht" sehen von aussen gleich aus, sind es aber nicht: das eine loescht
-- die Auswahl, das andere legt sie schlafen. Wer im Advent abschaltet und
-- im Juni wieder an, will nicht daneben aufschreiben muessen, wer vorher
-- drin war.
--
-- WER ES HEUTE IST, WIRD NICHT GESPEICHERT. Es gibt keine Tagestabelle, und
-- das ist Absicht:
--
--   * Die Bestenliste (`GET /api/leaderboard`) ist eine gecachte LESEroute,
--     die im Minutentakt gerufen wird und ausdruecklich nichts schreibt
--     (dort steht es so an `losTagStmt`). Eine Auslosung, die beim ersten
--     Abruf des Tages eine Zeile schreibt, wuerde genau das brechen.
--   * Der Wurf laesst sich aus dem TAG selbst rechnen: `bierTag()` ist der
--     Biertag dieser Anwendung (Tagesgrenze um LOS_GRENZE Uhr, nicht um
--     Mitternacht), und ein Wurf daraus faellt in jedem Isolat gleich aus.
--     Kein Speicher, keine Wettlaeufe, kein Mitternachtssprung mitten am
--     Abend.
--   * Und wo es doch ein BELEG sein muss, ist es laengst eingefroren: die
--     Ziehung schreibt ihr Feld als JSON nach `los.feld`, samt `farbe` - ein
--     Rad von vorgestern zeichnet sich mit den Farben von vorgestern (siehe
--     `losSegmente`). Der Regenbogen reitet in demselben Feld mit.
--
-- Anders als beim Gluecksrad ist hier kein `crypto.getRandomValues` noetig:
-- dort geht es darum, wer den Abend ausrichtet - eine Frage mit Kosten. Hier
-- geht es um eine Farbe fuer einen Tag.
--
-- WIE DER WORKER ES HERAUSGIBT: als Platz `7` in der Kreidereihe - die es
-- nicht gibt, denn die Reihe hat die Plaetze 0..6 (`FARBEN`). Alles, was
-- heute schon `farbe` liest - Rad, Tafel, Kurven, Balken, Rueckblick -,
-- bekommt den Regenbogen damit ohne eine einzige neue Zutat im Datenweg.
-- Waehlen kann diesen Platz niemand: `POST /api/admin/nutzer` mit
-- `aktion: 'farbe'` prueft weiterhin gegen 0..6.
--
-- WAS DAS KONTOR ANGEHT: dort wird NICHT im Regenbogen gezeichnet. Die
-- Monogramme und die Statistik des Wirts fragen `farbeSql()` ohne Traeger
-- und bekommen darum immer die echte Kreide. Der Wirt soll seine Leute an
-- der Farbe wiedererkennen, waehrend er sie verwaltet.
--
-- KEIN `UPDATE ... WHERE name = 'Brunx'` IN DIESER DATEI - dieselbe Regel
-- wie bei 0028: wer im Kreis ist, ist eine Tatsache ueber die Runde von
-- heute und keine Schemageschichte. Beide Spalten fangen bei 0 an, der Rest
-- wird im Kontor bestellt.
--
-- ZEIT: nichts Neues, keine der beiden Spalten traegt eine.
-- ===========================================================================

/* Reines ALTER TABLE ADD COLUMN - kein Tabellentausch, also auch kein
   `PRAGMA foreign_keys = OFF`. NOT NULL mit Vorgabe 0 geht dabei, weil die
   Vorgabe konstant ist: die bestehenden Zeilen bekommen sie eingetragen. */
ALTER TABLE users ADD COLUMN stolz INTEGER NOT NULL DEFAULT 0;

/* EINE Zeile, und der CHECK sorgt dafuer, dass es dabei bleibt. Kein
   allgemeiner Einstellungsspeicher mit Schluessel und Wert: der zieht binnen
   eines Jahres zwanzig Zeichenketten an, die niemand mehr zuordnen kann. Was
   hier steht, hat einen Namen. */
CREATE TABLE stolz_regel (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  aktiv  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO stolz_regel (id, aktiv) VALUES (1, 0);
