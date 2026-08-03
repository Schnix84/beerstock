-- ===========================================================================
-- Schema 8: Ein Foto je Kommentar.
--
-- In der Zeile steht der R2-SCHLUESSEL, nicht die URL. Sonst stuende die
-- Domain in jeder Zeile und ein Umzug des Buckets waere ein UPDATE ueber
-- alles; so ist er ein Wort in `wrangler.jsonc` (BILDER_URL).
--
-- Eine Spalte statt einer Tabelle `bilder(kommentar_id, key, rang)`: ein Foto
-- je Kommentar reicht, und mehrere sind spaeter ohne Datenverlust nachruestbar
-- (die Spalte wandert dann in die neue Tabelle). Bis dahin spart sie einen
-- JOIN in einer Abfrage, die ohnehin schon drei Statements im batch hat.
-- ===========================================================================

ALTER TABLE kommentare ADD COLUMN bild_key TEXT;

-- ---------------------------------------------------------------------------
-- Die Buchfuehrung ueber Uploads.
--
-- Noetig, weil das Hochladen VOR dem Abschicken laeuft: die Kommentarsperre
-- greift erst beim Abschicken, das Bild ist da laengst im Bucket. Ohne diese
-- Tabelle waere die Upload-Route die einzige ungebremste Schreibroute des
-- Workers - und die einzige, die Speicher belegt. In R2 zaehlen kann man
-- nicht, ein `list()` je Upload waere teurer als die Zeile hier.
--
-- Sie ist zugleich das Verzeichnis der verwaisten Objekte: wer hochlaedt und
-- dann nicht abschickt, hinterlaesst eine Zeile hier ohne Gegenstueck in
-- `kommentare.bild_key`. Aufgeraeumt wird bewusst nicht laufend (bei 250 kB je
-- Foto dauert es Jahre bis zu einem spuerbaren Rest); falls es je stoert, ist
-- es ein LEFT JOIN von hier nach dort und ein `delete()` je Treffer.
--
-- NACHTRAG: gebaut. `waisenWegraeumen()` in `src/index.js` haengt seit
-- 2026-08-03 am taeglichen Cron und macht genau das - mit einem Tag
-- Schonfrist, damit niemandem das Bild unter dem noch offenen Formular
-- weggeraeumt wird. Die Zeilen verschwinden dabei mit; diese Tabelle ist
-- seither kein Archiv mehr, sondern nur noch Sperre und Arbeitsvorrat.
-- ---------------------------------------------------------------------------
CREATE TABLE bild_uploads (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  autor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bild_key TEXT    NOT NULL UNIQUE,
  erstellt TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bild_uploads_autor ON bild_uploads(autor_id, erstellt);
