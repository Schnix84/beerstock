-- ===========================================================================
-- Schema 35: Die Abrechnung — Monatsabschluss, Salden, Gegenbuchung.
--
-- Etappe 4 des Gruppen-Umbaus (siehe ideas/plan-gruppen.md §4.1, §5.3, §6).
-- Reine CREATE-Schritte wie schon 0034 - kein Backfill, die Abrechnung ist
-- fuer jede Gruppe leer, bis der erste Monat abgeschlossen wird.
--
-- WARUM `abrechnung` NUR ALS 'abgeschlossen' ENTSTEHT, NIE ALS 'offen'. Ein
-- "offener" Monat ist in diesem Schema die ABWESENHEIT einer Zeile - der
-- UNIQUE-Index `abrechnung_monat` ist die ganze Sperre gegen einen doppelten
-- Abschluss (INSERT, Catch auf UNIQUE, 409). Gaebe es 'offen'-Zeilen, muesste
-- ein zweiter Abschluss entscheiden, ob er eine bestehende Zeile fortschreibt,
-- und zwei gleichzeitige Abschluesse koennten beide Salden erzeugen. Der
-- Worker legt darum bei `POST /api/abrechnung/abschluss` in einem Zug eine
-- ABGESCHLOSSENE Zeile an; der CHECK auf `status` bleibt trotzdem stehen, weil
-- eine Spalte mit genau einem moeglichen Wert eine spaetere Erweiterung
-- (Wiedereroeffnen?) nicht heimlich ausschliessen soll.
--
-- WARUM NUR EIN IN UTC VOLLSTAENDIG ABGELAUFENER MONAT ABSCHLIESSBAR IST (im
-- Worker geprueft, nicht hier im Schema). Schloesse man den laufenden Monat,
-- haette jede Buchung danach keinen Zeitraum mehr - `gebucht_am` ist stets
-- Server-Jetzt und faellt sofort in einen bereits abgeschlossenen Monat. Diese
-- Regel ist der Grund, warum die Aggregation ueber `buchung` rennfrei bleibt:
-- in einen abgelaufenen Monat kann keine neue Buchung mehr fallen.
--
-- WARUM `saldo.betrag_cent` AUCH 0 ODER NEGATIV SEIN DARF. Jede Person, die
-- die Monatsaggregation liefert, bekommt eine Zeile - auch bei einer
-- Gegenbuchung, die eine Buchung genau ausgleicht oder uebertrifft. Eine Zeile
-- ist der Nachweis, dass abgerechnet wurde; sie zu ueberspringen liesse einen
-- gegengebuchten Menschen aus der Abrechnung verschwinden. Bei `betrag_cent
-- <= 0` legt der Worker den Status gleich als 'bezahlt' an, mit
-- `gezahlt_cent = 0` - die Spalte traegt ausschliesslich von einem Admin
-- bestaetigtes Geld, ein Guthaben ist kein bestaetigter Zahlungseingang.
--
-- WARUM DER GEGENBUCHUNGS-INDEX HIER STEHT, OBWOHL ER `buchung` AUS 0034
-- BETRIFFT. Eine Gegenbuchung (Entscheidung 31) laeuft ueber
-- `POST /api/kasse/buchung` mit `gegen: <alte-id>` und traegt
-- `grund = 'gegenbuchung:<alte-id>'`; ohne Sperre wuerde ein Doppelklick zwei
-- Gegenbuchungen fuer dieselbe Original-Buchung erzeugen und den Betrag
-- doppelt gutschreiben. Der partielle UNIQUE-Index verhindert das, weil die
-- Original-Id im `grund` global eindeutig ist - keine neue Spalte noetig, kein
-- Tabellentausch, nur ein Index nachgezogen.
--
-- WARUM `AND storniert_am IS NULL` IM INDEX STEHT (Abnahmefund, live
-- nachgestellt). Eine Gegenbuchung selbst ist stornierbar (sie liegt im
-- laufenden Monat, das normale Fuenf-Minuten-/Admin-Fenster gilt). Ohne
-- diese Klausel bliebe der `grund`-Wert nach dem Storno stehen und der Index
-- sperrte fuer immer jede weitere Gegenbuchung zur selben Original-Buchung -
-- ein Tippfehler in der Gegenbuchung waere dann nicht mehr zu korrigieren.
-- Eine stornierte Gegenbuchung zaehlt darum nicht mehr als "es gibt schon
-- eine".
--
-- ZEIT: alles UTC im Format 'YYYY-MM-DD HH:MM:SS', wie im ganzen Schema.
-- ===========================================================================

CREATE UNIQUE INDEX buchung_gegen ON buchung(grund)
  WHERE grund LIKE 'gegenbuchung:%' AND storniert_am IS NULL;

-- Ein Kalendermonat je Gruppe (Entscheidung 12). Keine freien Grenzen, damit
-- weder Luecken noch Ueberlappungen entstehen koennen.
CREATE TABLE abrechnung (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id         INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  jahr              INTEGER NOT NULL,
  monat             INTEGER NOT NULL CHECK (monat BETWEEN 1 AND 12),
  status            TEXT NOT NULL DEFAULT 'offen'
                      CHECK (status IN ('offen','abgeschlossen')),
  abgeschlossen_am  TEXT,
  abgeschlossen_von INTEGER REFERENCES users(id)
);

CREATE UNIQUE INDEX abrechnung_monat ON abrechnung(gruppe_id, jahr, monat);

-- Was einer schuldet. Fuenf Zustaende (Entscheidungen 22 und 23): die Kette
-- sagt, WO im Ablauf man steht, die beiden Betraege sagen, WIEVIEL. Der offene
-- Rest wird gerechnet (`betrag_cent - gezahlt_cent`) und nirgends gespeichert.
CREATE TABLE saldo (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  abrechnung_id  INTEGER NOT NULL REFERENCES abrechnung(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  betrag_cent    INTEGER NOT NULL,
  gezahlt_cent   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'offen'
                   CHECK (status IN ('offen','gemeldet','teilbezahlt','bezahlt','abgelehnt')),
  gemeldet_am    TEXT,
  bestaetigt_am  TEXT,
  bestaetigt_von INTEGER REFERENCES users(id)
);

CREATE UNIQUE INDEX saldo_person ON saldo(abrechnung_id, user_id);

-- Jeder Statuswechsel, damit es keine Diskussion gibt (Entscheidung 22). Die
-- Entstehung einer `saldo`-Zeile beim Abschluss steht NICHT hier drin - das
-- ist kein Statuswechsel, `abrechnung.abgeschlossen_von`/`_am` sagt bereits,
-- wer und wann.
CREATE TABLE saldo_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  saldo_id INTEGER NOT NULL REFERENCES saldo(id) ON DELETE CASCADE,
  alt      TEXT,
  neu      TEXT NOT NULL,
  cent     INTEGER,        -- bestaetigter Betrag, wenn es um Geld ging
  von      INTEGER NOT NULL REFERENCES users(id),
  notiz    TEXT,
  erstellt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX saldo_log_zeit ON saldo_log(saldo_id, erstellt);
