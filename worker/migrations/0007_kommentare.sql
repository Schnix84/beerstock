-- ===========================================================================
-- Schema 7: Kommentare und Reaktionen.
--
-- GENAU EINE ANTWORTEBENE, wie bei WhatsApp. Zeigt `antwort_auf` auf eine
-- Antwort, haengt der Worker sie an deren Wurzel um. Der Grund ist kein
-- Prinzip, sondern die Spaltenbreite: auf dem Handy ist bei Stufe drei nichts
-- mehr zu lesen.
--
-- Sterne und Kommentare sind BEWUSST getrennt: Sterne sind eine Zeile je Autor
-- und Ziel und werden ueberschrieben, Kommentare sind beliebig viele und
-- bleiben stehen. Sonst verschwindet ein Kommentar mit drei Antworten und
-- einem Bier darunter, weil jemand seine Note von 4 auf 5 hebt.
-- ===========================================================================

CREATE TABLE kommentare (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Dasselbe Paar wie bei `bewertungen`, aus demselben Grund ohne
  -- Fremdschluessel: es zeigt mal auf `users`, mal auf `termine`.
  ziel_art TEXT    NOT NULL CHECK (ziel_art IN ('user','termin')),
  ziel_id  INTEGER NOT NULL,

  autor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- NULL = Wurzel. Eine Antwort zeigt immer auf eine Wurzel, nie auf eine
  -- andere Antwort - dafuer sorgt der Worker.
  antwort_auf INTEGER REFERENCES kommentare(id),

  -- Gesetzt, wenn der Kommentar zusammen mit Sternen abgeschickt wurde. Dann
  -- zeichnet die Seite die Sternzeile ueber den Text. Eine eigene Adresse
  -- braucht er trotzdem, sobald Antworten und Reaktionen daran haengen.
  bewertung_id INTEGER REFERENCES bewertungen(id),

  text      TEXT NOT NULL,
  erstellt  TEXT NOT NULL DEFAULT (datetime('now')),
  geaendert TEXT,

  -- Weich geloescht: Text weg, Karte bleibt als "gelöscht" stehen. Ein hartes
  -- DELETE riesse die Antworten darunter aus dem Zusammenhang.
  geloescht_am TEXT
);

CREATE INDEX kommentare_ziel ON kommentare(ziel_art, ziel_id, erstellt);
CREATE INDEX kommentare_wurzel ON kommentare(antwort_auf);

CREATE TABLE reaktionen (
  kommentar_id INTEGER NOT NULL REFERENCES kommentare(id) ON DELETE CASCADE,
  autor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  art          TEXT    NOT NULL
               CHECK (art IN ('daumen_hoch','daumen_runter','herz','bier')),
  erstellt     TEXT NOT NULL DEFAULT (datetime('now')),

  -- Der Primaerschluessel IST die Regel: derselbe Druck auf dieselbe Reaktion
  -- nimmt sie zurueck, ein zweiter Daumen desselben Autors entsteht nie.
  PRIMARY KEY (kommentar_id, autor_id, art)
);
