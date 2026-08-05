-- ===========================================================================
-- Schema 14: Der Notruf kennt jetzt auch "alles".
--
-- Bier ODER Gesellschaft war die Wahl - wer beides braucht, musste sich fuer
-- eines entscheiden oder zweimal druecken und sich damit selbst ersetzen,
-- und die Mail sprach dann nur vom zweiten. "Alles" ist eine dritte ART,
-- kein zweites Ankreuzfeld neben den beiden anderen: es ist ein eigener
-- Zustand ("ich brauche beides"), keine Kombination aus zweien.
--
-- SQLite kann einen CHECK nicht nachtraeglich erweitern - Tabellentausch, wie
-- in 0002 begruendet und dort auch mit dem Grund fuer `foreign_keys = OFF`:
-- ein blosses DROP TABLE fuehrt intern ein DELETE aus, und das risse ueber
-- die Kaskade auf `notrufe.user_id` in eine Richtung, die hier niemanden
-- angeht.
-- ===========================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE notrufe_neu (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  art      TEXT NOT NULL CHECK (art IN ('bier','kamerad','alles')),
  lat      REAL NOT NULL CHECK (lat BETWEEN  -90 AND  90),
  lon      REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  genau    INTEGER,
  erstellt TEXT NOT NULL DEFAULT (datetime('now')),
  bis      TEXT NOT NULL,
  weg_am   TEXT
);

INSERT INTO notrufe_neu (id, user_id, art, lat, lon, genau, erstellt, bis, weg_am)
  SELECT id, user_id, art, lat, lon, genau, erstellt, bis, weg_am FROM notrufe;

DROP TABLE notrufe;
ALTER TABLE notrufe_neu RENAME TO notrufe;

CREATE INDEX idx_notrufe_offen ON notrufe (bis, weg_am);
