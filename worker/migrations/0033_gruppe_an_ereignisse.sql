-- ===========================================================================
-- Schema 33: Jedes Ereignis gehoert einer Gruppe.
--
-- 0032 hat die Gruppe angelegt, diese Datei haengt die Vergangenheit daran.
-- Fuenf Tabellen bekommen eine `gruppe_id`, und alles, was heute darin steht,
-- wird "Am Tresen" zugeschlagen. DIE BEIDEN DATEIEN GEHOEREN ZUSAMMEN
-- AUSGEROLLT - ein Worker zwischen den Staenden sieht Ereignisse ohne Gruppe.
--
-- WELCHE FUENF, und welche ausdruecklich NICHT:
--
--   los, notrufe, termine, kommentare, bewertungen   -> ja
--   reports                                          -> NEIN
--   reaktionen, notruf_kreis                         -> NEIN
--
-- `reports` NICHT, und das ist die wichtigste Zeile dieser Datei: die MELDUNG
-- GEHOERT DER PERSON, nicht der Gruppe. Man meldet einmal, dass zwoelf kalte
-- im Kuehlschrank stehen, und jede Gruppe, die eine Tafel fuehrt, zeigt die
-- Meldungen ihrer Mitglieder. Gruppenweit wird, was ein EREIGNIS ist - nicht,
-- was ein Zustand eines Menschen ist. Daran haengt mehr als eine Spalte: weil
-- `reports` unangetastet bleibt, bleibt `POST /api/report` unangetastet, und
-- damit bleibt die Home-Assistant-Seite unangetastet. Sie liegt in einem
-- privaten Repo und kann hier nicht mitziehen.
--
-- `reaktionen` und `notruf_kreis` NICHT, weil sie als Kindtabelle an einem
-- Elternteil haengen, das die Gruppe schon traegt (`reaktionen.kommentar_id`
-- und `notruf_kreis.notruf_id`, beide mit ON DELETE CASCADE). Eine eigene
-- Spalte waere dieselbe Auskunft ein zweites Mal - und die zweite kann falsch
-- werden.
--
-- WARUM DIE VIER NEUEN SPALTEN NULL ZULASSEN. SQLite kann `NOT NULL` nicht
-- nachruesten; wer es will, muss die Tabelle neu bauen, umkopieren und
-- umbenennen - mit `PRAGMA foreign_keys = OFF` am Kopf, wovor 0002
-- ausdruecklich warnt. Vier solche Tausche in einer Datei waeren der
-- riskanteste einzelne Schritt des ganzen Projekts, und sie brauchten es
-- nicht: die Spalte ist nullbar, die Migration fuellt sie im selben Schritt,
-- und die Zusicherung "der Worker schreibt hier nie NULL" liegt an EINER
-- Stelle - im Schreibpfad, wo ohnehin `inGruppe()` steht.
-- DAS IST EINE ABWAEGUNG, KEINE NACHLAESSIGKEIT. Wer sie spaeter "aufraeumen"
-- will, raeumt vier Tabellentausche in eine Datei.
--
-- `bewertungen` IST DIE AUSNAHME und wird doch getauscht - nicht wegen der
-- Spalte, sondern wegen einer Schranke, die mit Gruppen falsch wird. Siehe
-- unten, der Abschnitt hat seinen eigenen Kopf.
--
-- ZWEI INDIZES WERDEN FALSCH, sobald es mehr als eine Gruppe gibt, und werden
-- hier mitgezogen. Auch das steht unten bei den Indizes.
-- ===========================================================================

/* HIER STAND `PRAGMA foreign_keys = OFF;`, WIE IN 0002, 0004, 0014 UND 0019 -
   UND ES HAETTE DIESE MIGRATION AN DER ECHTEN DATENBANK SCHEITERN LASSEN.

   Der Grund, warum es dort trug und hier nicht: keine der frueheren
   Migrationen hat je eine Tabelle getauscht, auf die zu diesem Zeitpunkt
   schon ein Kind zeigte. 0004 baute `los` neu, bevor es `termine.los_id` gab;
   0019 baute `reaktionen` neu, also das KIND. `bewertungen` ist die erste
   Tabelle mit einem lebenden Verweis darauf: `kommentare.bewertung_id`, seit
   0007 und ohne ON DELETE.

   Und das PRAGMA hilft dagegen nicht: `wrangler d1 migrations apply` fuehrt
   die Datei in einer Transaktion aus, und innerhalb einer Transaktion ist
   `PRAGMA foreign_keys` wirkungslos. Nachgestellt in einer eigenen Sandbox
   (Migrationen 0001-0032, dann zwei Bewertungen mit zwei Kommentaren daran):
   `DROP TABLE bewertungen` -> FOREIGN KEY constraint failed, die Migration
   rollt sauber zurueck und steht danach NICHT in `d1_migrations`. Die Kette
   Migration -> Worker -> Seite waere gleich im ersten Glied stehengeblieben,
   und der ausgerollte Worker haette auf eine Datenbank ohne `gruppe_id`
   gesehen: jeder Aufruf ein 500er. Lokal faellt das NIE auf - dort ist
   `bewertungen` beim Migrieren leer.

   STATTDESSEN: die Kindverweise werden um den Tausch HERUMGETRAGEN. Kurz
   abgelegt, geloest, und hinterher wieder angeknuepft. Das kommt ohne PRAGMA
   aus, laeuft in jeder Transaktion und ist an den Ids festgemacht, die der
   Tausch ohnehin mitnimmt. */
CREATE TABLE kommentar_bewertung_merk AS
  SELECT id, bewertung_id FROM kommentare WHERE bewertung_id IS NOT NULL;
UPDATE kommentare SET bewertung_id = NULL;

-- ---------------------------------------------------------------------------
-- Die vier nullbaren Spalten, samt Fuellung.
-- ---------------------------------------------------------------------------
ALTER TABLE los        ADD COLUMN gruppe_id INTEGER REFERENCES gruppen(id);
ALTER TABLE notrufe    ADD COLUMN gruppe_id INTEGER REFERENCES gruppen(id);
ALTER TABLE termine    ADD COLUMN gruppe_id INTEGER REFERENCES gruppen(id);
ALTER TABLE kommentare ADD COLUMN gruppe_id INTEGER REFERENCES gruppen(id);

/* Idempotent ueber `WHERE gruppe_id IS NULL`: ein zweiter Lauf findet nichts
   mehr vor und ruehrt nichts an, was inzwischen einer anderen Gruppe gehoert.
   Die Id kommt ueber den Slug herein, nicht als 1 - siehe 0032. */
UPDATE los        SET gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen') WHERE gruppe_id IS NULL;
UPDATE notrufe    SET gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen') WHERE gruppe_id IS NULL;
UPDATE termine    SET gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen') WHERE gruppe_id IS NULL;
UPDATE kommentare SET gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen') WHERE gruppe_id IS NULL;

-- ---------------------------------------------------------------------------
-- `bewertungen`: der eine Tabellentausch, und warum er sein muss.
--
-- Die alte Schranke lautet UNIQUE (autor_id, ziel_art, ziel_id) - EINE
-- Bewertung je Autor und Ziel, instanzweit. Mit Gruppen ist das falsch: ein
-- Mensch hat kuenftig EINEN SCHNITT JE GRUPPE. Was am Tresen ueber ihn gesagt
-- wird, bleibt am Tresen; im Buero faengt er bei null an.
--
-- Bliebe die Schranke stehen, waere das nicht bloss eine fehlende Moeglichkeit,
-- sondern ein stiller Datenverlust: der Upsert in `POST /api/bewerten` traegt
-- dieselbe Spaltenliste im ON CONFLICT und wuerde die Tresen-Bewertung beim
-- Bewerten im Buero UEBERSCHREIBEN statt eine zweite anzulegen. Die alte Note
-- waere weg, und niemand saehe, wo sie geblieben ist. Ein Index laesst sich
-- ersetzen, eine UNIQUE-Klausel in der Tabellendefinition nicht - also der
-- Tausch, nach dem Muster von 0004, 0014 und 0019.
--
-- WEIL DIE TABELLE OHNEHIN NEU GEBAUT WIRD, bekommt sie ihre `gruppe_id`
-- gleich als NOT NULL. Das ist der Unterschied zu den vier oben, und er ist
-- kein Zufall, sondern der Grund, aus dem der Tausch sich lohnt: hier kostet
-- die Zusicherung nichts extra.
--
-- Die IDs werden mit uebernommen (`INSERT ... (id, ...) SELECT id, ...`).
-- `kommentare.bewertung_id` zeigt hierher; ohne die alten Ids stuenden die
-- Sternzeilen ueber den falschen Kommentaren.
--
-- WAS SICH NICHT AENDERT: Termin-Bewertungen zaehlen weiterhin nicht auf den
-- Schnitt des Gastgebers ein (0006), und der Fremdschluessel bleibt weg -
-- `ziel_id` zeigt mal auf `users`, mal auf `termine`.
-- ---------------------------------------------------------------------------
CREATE TABLE bewertungen_neu (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  autor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Neu, und als einzige der fuenf gleich NOT NULL - siehe Kopf.
  gruppe_id INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,

  ziel_art TEXT    NOT NULL CHECK (ziel_art IN ('user','termin')),
  -- Polymorph, deshalb bewusst OHNE Fremdschluessel: einer koennte nur auf
  -- eine der beiden Tabellen zeigen. Dass das Ziel existiert, prueft der
  -- Worker, bevor er schreibt.
  ziel_id  INTEGER NOT NULL,

  -- JSON, ein Schluessel je Kategorie. Nicht bewertete Kategorien stehen als
  -- `null` drin und fallen aus jedem Schnitt heraus.
  sterne   TEXT    NOT NULL,

  erstellt  TEXT NOT NULL DEFAULT (datetime('now')),
  geaendert TEXT,

  -- Eine Bewertung je Autor, GRUPPE und Ziel: neu bewerten heisst weiterhin
  -- ueberschreiben, aber nur innerhalb derselben Gruppe. Der Upsert in
  -- `POST /api/bewerten` muss diese Spaltenliste wortwoertlich fuehren, sonst
  -- findet SQLite den Konflikt nicht.
  UNIQUE (autor_id, gruppe_id, ziel_art, ziel_id)
);

INSERT INTO bewertungen_neu (id, autor_id, gruppe_id, ziel_art, ziel_id, sterne, erstellt, geaendert)
  SELECT id, autor_id,
         (SELECT id FROM gruppen WHERE slug = 'am-tresen'),
         ziel_art, ziel_id, sterne, erstellt, geaendert
    FROM bewertungen;

DROP TABLE bewertungen;
ALTER TABLE bewertungen_neu RENAME TO bewertungen;

/* Und die Sternzeilen wieder an ihre Bewertung. Das traegt nur, weil der
   INSERT oben die alten Ids mitgenommen hat - sonst haenge hier jede Karte am
   falschen Menschen. Die Merktabelle faellt danach weg; sie hat genau so lange
   gelebt wie der Tausch. */
UPDATE kommentare SET bewertung_id = (
    SELECT m.bewertung_id FROM kommentar_bewertung_merk m WHERE m.id = kommentare.id)
  WHERE id IN (SELECT id FROM kommentar_bewertung_merk);
DROP TABLE kommentar_bewertung_merk;

-- ---------------------------------------------------------------------------
-- Die Indizes.
--
-- ZWEI BESTEHENDE WERDEN FALSCH und werden ersetzt:
--
-- `los_gueltig` war UNIQUE ueber `los(tag)` und hielt fest, dass es hoechstens
-- EIN gueltiges Los je Tag gibt. Kuenftig dreht JEDE Gruppe ihr eigenes Rad,
-- taeglich - wer in drei Gruppen ist, kann dreimal gezogen werden. Bliebe der
-- alte Index stehen, koennte am selben Tag nur eine einzige Gruppe drehen und
-- alle anderen liefen stumm in ein `DO NOTHING`. Die Nebenlaeufigkeit steckt
-- weiter ganz in diesem Index; die WHERE-Klausel am ON CONFLICT im Worker muss
-- wortwoertlich der hier entsprechen.
--
-- `los_tag` bekommt die Gruppe voran, weil kein Lesepfad mehr nach einem Tag
-- ueber alle Gruppen fragt.
--
-- Die drei neuen tragen die Richtung, in der ab jetzt jede Tafel liest:
-- "was gehoert DIESER Gruppe" steht vorn, das bisherige Kriterium dahinter.
-- ---------------------------------------------------------------------------
DROP INDEX los_gueltig;
CREATE UNIQUE INDEX los_gueltig ON los(gruppe_id, tag) WHERE status IN ('offen','zugesagt');

DROP INDEX los_tag;
CREATE INDEX los_tag ON los(gruppe_id, tag);

-- `idx_notrufe_offen` (bis, weg_am) bleibt, wie er ist: der Cron raeumt
-- erloschene Notrufe ueber ALLE Gruppen weg und will die Gruppe nicht davor.
-- Fuer den Lesepfad kommt dieser hier dazu.
CREATE INDEX notrufe_gruppe ON notrufe(gruppe_id, bis);

-- `termine_zeit` (beginnt_am DESC) bleibt fuer den Kehr; der Lesepfad nimmt
-- diesen.
CREATE INDEX termine_gruppe ON termine(gruppe_id, beginnt_am DESC);

CREATE INDEX kommentare_gruppe  ON kommentare(gruppe_id, ziel_art, ziel_id, erstellt);
CREATE INDEX bewertungen_gruppe ON bewertungen(gruppe_id, ziel_art, ziel_id);

-- Der alte, ohne Gruppe. Er wurde beim Tausch mitgeloescht und kommt hier
-- zurueck: `baumBauen()` und die Schnittrechnung fragen an einer Stelle noch
-- ohne Gruppe nach einem Ziel, und ein fehlender Index faellt dort erst bei
-- Last auf.
CREATE INDEX bewertungen_ziel ON bewertungen(ziel_art, ziel_id);

-- ---------------------------------------------------------------------------
-- Pruefsaetze. Von Hand nachfahren (`wrangler d1 execute … --command`); die
-- Migration selbst kann an ihnen nicht scheitern, SQLite kennt kein RAISE
-- ausserhalb eines Triggers.
--
--   Muessen ALLE 0 ergeben, sonst ist die Migration unvollstaendig
--   durchgelaufen:
--     SELECT count(*) FROM los         WHERE gruppe_id IS NULL;
--     SELECT count(*) FROM notrufe     WHERE gruppe_id IS NULL;
--     SELECT count(*) FROM termine     WHERE gruppe_id IS NULL;
--     SELECT count(*) FROM kommentare  WHERE gruppe_id IS NULL;
--     SELECT count(*) FROM bewertungen WHERE gruppe_id IS NULL;
--
--   Muss dieselbe Zahl ergeben wie VOR der Migration (der Tausch darf keine
--   Zeile verlieren):
--     SELECT count(*) FROM bewertungen;
--
--   Muss 0 ergeben (keine Sternzeile haengt am falschen Kommentar):
--     SELECT count(*) FROM kommentare
--      WHERE bewertung_id IS NOT NULL
--        AND bewertung_id NOT IN (SELECT id FROM bewertungen);
-- ---------------------------------------------------------------------------
