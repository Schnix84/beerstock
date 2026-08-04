-- ===========================================================================
-- Schema 13: Der Notruf.
--
-- Wer Bier braucht oder jemanden zum Trinken, drueckt einen Knopf und legt
-- seinen Standort dazu. Die anderen sehen ihn auf einer Karte und koennen
-- hinfahren. Das ist die erste Stelle im ganzen Schema, an der ein ORT eines
-- Menschen steht - und darum die einzige, die von sich aus vergisst.
--
-- WARUM DIE ZEILE VERSCHWINDET STATT ZU BLEIBEN. Ueberall sonst hier gilt:
-- nichts wird ueberschrieben, der Verlauf faellt von selbst an (`reports`).
-- Genau das darf hier NICHT passieren. Ein Jahr Notrufe waere eine Karte der
-- Abende eines Menschen, minutengenau - dieselbe Spur, wegen der `status.json`
-- 2026-08-03 abgeschafft wurde, nur praeziser. Ein abgelaufener Notruf wird
-- deshalb im Cron GELOESCHT, nicht archiviert, und er taucht weder in der
-- Chronik noch im Kontor noch in einer Statistik auf. Wer hier je ein
-- `ORDER BY erstellt` ueber alte Zeilen schreiben will, baut genau das, was
-- diese Tabelle nicht sein soll.
--
-- Reines CREATE, kein Tabellentausch - darum kein `PRAGMA foreign_keys = OFF`
-- (siehe den Kopf von 0011, warum das sonst dastehen muesste).
--
-- ZEIT: ueberall UTC, 'YYYY-MM-DD HH:MM:SS', wie im ganzen Schema.
-- ===========================================================================

CREATE TABLE notrufe (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE wie bei `reports`: wer entfernt wird, hinterlaesst keinen Ort.
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Zwei Noete, mehr nicht. Ein Freitextfeld waere ein Chat, und dafuer gibt
  -- es die Kommentare an jeder Zeile.
  art      TEXT NOT NULL CHECK (art IN ('bier','kamerad')),

  -- Grad, wie der Browser sie liefert. REAL und nicht TEXT: es wird damit
  -- gerechnet (Kachelnummern), nicht nur angezeigt.
  lat      REAL NOT NULL CHECK (lat BETWEEN  -90 AND  90),
  lon      REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  /* Was der Browser selbst ueber seine Genauigkeit sagt, in Metern. Steht hier,
     weil es auf der Karte gezeigt wird: eine WLAN-Ortung liegt gern 2 km
     daneben, und ein Punkt ohne diesen Radius behauptet eine Schaerfe, die er
     nicht hat. NULL, wenn der Browser nichts dazu sagt. */
  genau    INTEGER,

  erstellt TEXT NOT NULL DEFAULT (datetime('now')),
  /* Wann er von selbst erlischt. Als Zeitpunkt und nicht als Dauer, damit ein
     Blick in die Tabelle genuegt: `bis > datetime('now')` ist die ganze
     Wahrheit darueber, was gerade gilt. Die Frist setzt der Worker. */
  bis      TEXT NOT NULL,
  /* Zurueckgenommen. Bleibt bis zum naechsten Aufraeumen stehen, damit die
     offenen Seiten die Zeile noch einmal verschwinden sehen, statt sie
     wortlos zu verlieren. */
  weg_am   TEXT
);

/* Die einzige Abfrage, die es haeufig gibt: was gilt gerade. Sie laeuft in
   jedem `GET /api/leaderboard` eines Angemeldeten mit, also im Minutentakt je
   offener Seite. */
CREATE INDEX idx_notrufe_offen ON notrufe (bis, weg_am);
