-- ===========================================================================
-- Schema 4: der Gewinner sagt zu oder ab.
--
-- Bisher war die Ziehung das letzte Wort: `los.tag` war PRIMARY KEY, also gab
-- es genau eine je Tag, und wen sie traf, der war Gastgeber - auch wenn er
-- Spaetschicht hatte. Jetzt antwortet er, und eine Absage gibt den Tag wieder
-- frei.
--
-- Damit muessen mehrere Lose je Tag nebeneinander liegen koennen, aber immer
-- nur EINES davon gelten. Genau das leistet der partielle Unique-Index unten:
-- er ersetzt den bisherigen PRIMARY KEY als Traeger der Nebenlaeufigkeit -
-- zwei gleichzeitige Dreher entscheidet weiter SQLite per ON CONFLICT DO
-- NOTHING, ohne Sperre und ohne Transaktion ueber zwei Anfragen.
--
-- SQLite kann einen PRIMARY KEY nicht nachtraeglich loesen, also Tabellen-
-- tausch wie in Migration 0002.
-- ===========================================================================

-- Wie in 0002, und aus demselben teuer gelernten Grund: `defer_foreign_keys`
-- verschiebt nur die PRUEFUNG, nicht die AKTION. `DROP TABLE` fuehrt intern
-- ein DELETE aus, und ein `ON DELETE CASCADE` raeumt dabei froehlich mit ab.
-- Nur `foreign_keys = OFF` haelt die Kaskade an.
PRAGMA foreign_keys = OFF;

CREATE TABLE los_neu (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 'YYYY-MM-DD' des Bierabend-Tags. Nicht mehr eindeutig: nach einer Absage
  -- wird am selben Tag erneut gezogen, und beide Ziehungen bleiben stehen.
  tag         TEXT    NOT NULL,

  user_id     INTEGER NOT NULL REFERENCES users(id),
  -- Der Bestand im Moment der Ziehung, eingefroren - der Gewinner kann bis
  -- zum Abend noch melden.
  biere       INTEGER NOT NULL,
  -- Das Feld als JSON, je Drehung ein eigener Schnappschuss: die zweite
  -- Drehung des Tages hat den Absager nicht mehr im Topf.
  feld        TEXT    NOT NULL,

  gedreht_von INTEGER REFERENCES users(id),
  gedreht_am  TEXT    NOT NULL DEFAULT (datetime('now')),

  -- offen -> zugesagt | abgelehnt | verfallen.
  -- 'offen' und 'zugesagt' BELEGEN den Tag, die anderen beiden geben ihn frei.
  -- 'verfallen' setzt kein Cron, sondern der naechste Dreher: wer nach der
  -- Frist nichts geantwortet hat, wird beim naechsten Griff zur Flasche
  -- nachgetragen (siehe LOS_FRIST im Worker).
  status         TEXT NOT NULL DEFAULT 'offen'
                 CHECK (status IN ('offen','zugesagt','abgelehnt','verfallen')),
  entschieden_am TEXT,
  grund          TEXT    -- optional, nur bei Absage, im Worker auf 120 Zeichen begrenzt
);

-- Der Altbestand gilt als zugesagt: diese Abende haben stattgefunden.
-- Rueckwirkend Termine daraus zu bauen waere falsch, es hat sie nie gegeben.
INSERT INTO los_neu (tag,user_id,biere,feld,gedreht_von,gedreht_am,status,entschieden_am)
  SELECT tag,user_id,biere,feld,gedreht_von,gedreht_am,'zugesagt',gedreht_am FROM los;

DROP TABLE los;
ALTER TABLE los_neu RENAME TO los;

-- Hier steckt die ganze Nebenlaeufigkeit drin: hoechstens ein GUELTIGES Los je
-- Tag. Die WHERE-Klausel am ON CONFLICT im Worker muss wortwoertlich dieser
-- Bedingung entsprechen, sonst findet SQLite den Index nicht und der Konflikt
-- laeuft ins Leere.
CREATE UNIQUE INDEX los_gueltig ON los(tag) WHERE status IN ('offen','zugesagt');

-- Fuer den Blick auf den ganzen Tag: alle Lose eines Tages, auch die erledigten.
CREATE INDEX los_tag ON los(tag);
