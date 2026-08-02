-- ===========================================================================
-- Schema 5: Termine.
--
-- Eine Zusage am Gluecksrad legt von selbst einen Termin an - erst dadurch
-- wird aus "die Flasche zeigt auf Maike" ein Abend, der irgendwann anfaengt.
-- Von Hand eintragen geht auch, denn nicht jeder Bierabend faellt aus einer
-- Ziehung.
--
-- Angelegt wird der Termin bei der ZUSAGE, nicht bei der Ziehung: bei einer
-- Absage staende sonst eine Leiche im Kalender.
--
-- ZEIT: alles absolut in UTC, wie `reports.gemeldet_am` und `los.gedreht_am`.
-- Der Browser rechnet um und schickt fertig. Der Worker hat kein ICU und soll
-- keins bekommen; ein naiver Ortszeit-String haette sich ausserdem an
-- `datetime('now')` gestossen - 19:00 Ortszeit gegen 17:30 UTC verglichen
-- heisst "hat noch nicht angefangen", obwohl der Abend laeuft.
-- ===========================================================================

CREATE TABLE termine (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gastgeber_id INTEGER NOT NULL REFERENCES users(id),
  beginnt_am   TEXT    NOT NULL,          -- UTC, 'YYYY-MM-DD HH:MM:SS'
  titel        TEXT,                      -- NULL => "Bierabend bei <Name>"

  -- Aus welcher Ziehung er entstanden ist. NULL = von Hand eingetragen.
  -- UNIQUE, damit eine Zusage nicht zwei Termine erzeugen kann - die Route
  -- schreibt beides in einem batch, aber ein Wiederholungsversuch nach einem
  -- abgebrochenen Ruf soll hier auflaufen und nicht durchrutschen.
  los_id       INTEGER UNIQUE REFERENCES los(id),

  erstellt_von INTEGER NOT NULL REFERENCES users(id),
  erstellt     TEXT NOT NULL DEFAULT (datetime('now')),

  -- Weich abgesagt: die Karte bleibt stehen, Kommentare darunter bleiben
  -- lesbar. Ein hartes DELETE riesse den Zusammenhang mit weg.
  abgesagt_am  TEXT
);

-- Die Liste laeuft immer ueber die Zeit: kommende zuerst, ein paar Tage
-- rueckwaerts fuer die Bewertung des letzten Abends.
CREATE INDEX termine_zeit ON termine(beginnt_am DESC);
