-- ===========================================================================
-- Schema 3: das Gluecksrad.
--
-- Gezogen wird EINMAL AM TAG, und zwar hier auf dem Worker - nicht im
-- Browser. Sonst dreht jeder sein eigenes Rad und bekommt seine eigene
-- Antwort; dann ist es kein "wo trinken wir heute", sondern fuenf
-- verschiedene Meinungen. Die erste Drehung des Tages zieht fuer alle, jeder
-- Spaetere sieht dasselbe Ergebnis. Nebenbei faellt damit weg, dass jemand so
-- lange neu laedt, bis er selbst gewinnt.
-- ===========================================================================

CREATE TABLE los (
  -- 'YYYY-MM-DD' des Bierabend-Tags. PRIMARY KEY ist hier die ganze Logik:
  -- zwei gleichzeitige Dreher entscheidet SQLite mit ON CONFLICT DO NOTHING,
  -- ohne Sperre und ohne Transaktion ueber zwei Anfragen. Wer nichts
  -- geschrieben hat, liest das fremde Ergebnis zurueck und zeigt es an.
  tag         TEXT PRIMARY KEY,

  user_id     INTEGER NOT NULL REFERENCES users(id),
  -- Der Bestand im Moment der Ziehung. Steht hier fest, weil der Gewinner bis
  -- zum Abend noch melden kann und der Anschrieb sonst rueckwirkend anders
  -- aussaehe, als er gezogen wurde.
  biere       INTEGER NOT NULL,

  -- Das Feld als JSON: [{ name, gewicht, gemessen }, ...] in Segmentreihen-
  -- folge. Muss mit weg, sonst hat das Rad um 23 Uhr andere Felder als um 19
  -- Uhr - und die Animation landet auf einem Segment, das es nicht mehr gibt.
  feld        TEXT    NOT NULL,

  -- Wer gedreht hat. Nicht noetig fuer die Logik, aber "gedreht von Basti"
  -- ist die Zeile, die den Anschrieb zu einer Handlung macht.
  gedreht_von INTEGER REFERENCES users(id),
  gedreht_am  TEXT NOT NULL DEFAULT (datetime('now'))
);
