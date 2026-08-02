-- ===========================================================================
-- Schema 6: Sterne.
--
-- Bewertet wird in Teilkategorien, nicht mit einer Gesamtnote - die Gesamtnote
-- wird daraus GERECHNET und nie extra gefragt. Wer beides abfragt, bekommt
-- zwei Zahlen, die auseinanderdriften, und dann gilt keine von beiden.
-- Pflicht ist keine Kategorie: ein einzelner Tap ist eine gueltige Bewertung.
--
-- Zwei Ziele, eine Tabelle: ein NUTZER wird dauerhaft bewertet (haelt er kalt,
-- ist er ein guter Gastgeber), ein TERMIN einmalig (wie war der Abend). Termin-
-- Bewertungen zaehlen bewusst NICHT auf den Schnitt des Gastgebers ein, sonst
-- zaehlt ein einziger Abend doppelt.
-- ===========================================================================

CREATE TABLE bewertungen (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  autor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  ziel_art TEXT    NOT NULL CHECK (ziel_art IN ('user','termin')),
  -- Polymorph, deshalb bewusst OHNE Fremdschluessel: einer koennte nur auf
  -- eine der beiden Tabellen zeigen. Dass das Ziel existiert, prueft der
  -- Worker, bevor er schreibt.
  ziel_id  INTEGER NOT NULL,

  -- JSON, ein Schluessel je Kategorie. Nicht bewertete Kategorien stehen als
  -- `null` drin und fallen aus jedem Schnitt heraus. Welche Schluessel es
  -- gibt, steht im Worker (KATEGORIEN) - unbekannte weist er ab. Eine eigene
  -- Tabelle dafuer waere vier Zeilen Stammdaten und ein Join pro Abruf.
  sterne   TEXT    NOT NULL,

  erstellt  TEXT NOT NULL DEFAULT (datetime('now')),
  geaendert TEXT,

  -- Eine Bewertung je Autor und Ziel: neu bewerten heisst ueberschreiben.
  -- Das traegt das UPSERT in POST /api/bewerten.
  UNIQUE (autor_id, ziel_art, ziel_id)
);

CREATE INDEX bewertungen_ziel ON bewertungen(ziel_art, ziel_id);
