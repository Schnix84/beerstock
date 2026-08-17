-- ===========================================================================
-- Schema 34: Die Kasse — Getraenke, Preise, Buchungen, Bestand.
--
-- Etappe 3 des Gruppen-Umbaus (siehe ideas/plan-gruppen.md §4.1, §5.2, §6).
-- Reine CREATE-Schritte, kein Tabellentausch, kein Backfill - die Kasse ist
-- fuer jede Gruppe leer, bis ihr Admin das erste Getraenk anlegt. Deshalb
-- auch kein `PRAGMA foreign_keys = OFF` und keine Pruefsaetze am Ende: es
-- gibt nichts umzurechnen.
--
-- WARUM `bestand` AUCH DIE VERBRAUCHSZEILE TRAEGT, nicht nur Lieferung und
-- Korrektur. Der Plan sieht in Etappe 6 (Entscheidung 26) den Bestandsverlauf
-- als EINE Fensterfunktion ueber EINE Tabelle (`sum(menge) OVER (PARTITION BY
-- getraenk_id ORDER BY erstellt)`) - zwei Quellen, die man dafuer erst
-- zusammenfuehren muesste, waeren eine zweite Wahrheit, die auseinanderlaufen
-- kann. Jede Buchung erzeugt darum NEBEN der `buchung`-Zeile eine
-- `bestand`-Zeile mit `art='verbrauch'`, negativem `menge` und gesetztem
-- `buchung_id`; ein Storno erzeugt eine ausgleichende `art='korrektur'`-Zeile
-- statt die alte zu loeschen - der Verlauf luegt sonst rueckwirkend.
--
-- WARUM `getraenk_name` NUR AKTIVE GETRAENKE SPERRT (WHERE aktiv = 1). Sonst
-- verhindert ein deaktiviertes "Augustiner" fuer immer ein neues Getraenk
-- desselben Namens - Entscheidung 10 will umbenennen und deaktivieren, kein
-- Namensfriedhof.
--
-- WARUM `preis_lauf` MIT `id DESC` ALS ZWEITEM SCHLUESSEL. Der geltende Preis
-- ist die juengste Zeile mit `gueltig_ab <= Buchungszeitpunkt`
-- (`ORDER BY gueltig_ab DESC, id DESC LIMIT 1`). Ohne den zweiten Schluessel
-- ist das Ergebnis nicht definiert, sobald zwei Zeilen dieselbe Sekunde
-- tragen - und genau das passiert, wenn ein Admin sich vertippt und den
-- Preis "sofort" ein zweites Mal setzt.
--
-- WARUM `gueltig_ab` KEINE VORGABE HAT. Der Worker schreibt sie beim
-- Einfuegen selbst (`datetime('now')` fuer "sofort"), damit die Spalte immer
-- dieselbe Normalform traegt wie jedes andere Zeitfeld im Schema - eine
-- clientseitige Vorgabe koennte ein nacktes Datum ohne Uhrzeit schicken, und
-- dann stuende 'YYYY-MM-DD' neben 'YYYY-MM-DD HH:MM:SS' in derselben Spalte,
-- die nur als Zeichenkette verglichen wird.
--
-- ZEIT: alles UTC im Format 'YYYY-MM-DD HH:MM:SS', wie im ganzen Schema.
-- ===========================================================================

CREATE TABLE getraenk (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  aktiv     INTEGER NOT NULL DEFAULT 1 CHECK (aktiv IN (0,1)),

  -- NULL = keine Mindestbestandswarnung (Entscheidung 34).
  mindest   INTEGER,
  -- Laufende Nummer der Unterschreitung - der `bezug` der Warnmail
  -- (`bestand:<id>:<warn_lauf>`) und damit die Sperre gegen Wiederholung:
  -- solange der Bestand unter `mindest` bleibt, aendert sie sich nicht.
  -- Steigt er darueber, zaehlt der Worker sie hoch.
  warn_lauf INTEGER NOT NULL DEFAULT 0,

  erstellt  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX getraenk_name ON getraenk(gruppe_id, name) WHERE aktiv = 1;

CREATE TABLE preis (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  getraenk_id INTEGER NOT NULL REFERENCES getraenk(id) ON DELETE CASCADE,
  cent        INTEGER NOT NULL CHECK (cent >= 0),
  -- Entscheidung 38: Vorgabe ist "sofort", ein Datum in der Zukunft ist
  -- erlaubt. Eine vorgemerkte Zeile gilt schlicht noch nicht.
  gueltig_ab  TEXT NOT NULL,
  gesetzt_von INTEGER REFERENCES users(id),
  erstellt    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX preis_lauf ON preis(getraenk_id, gueltig_ab DESC, id DESC);

-- `cent` ist der EINGEFRORENE Einzelpreis (§2.4) - redundant zu `preis`, und
-- genau das ist gewollt: eine Preisaenderung darf keine alte Buchung
-- verschieben.
CREATE TABLE buchung (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id     INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  getraenk_id   INTEGER NOT NULL REFERENCES getraenk(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  -- Negativ erlaubt: so sieht die Gegenbuchung aus (Entscheidung 31, Etappe 4).
  menge         INTEGER NOT NULL CHECK (menge <> 0),
  cent          INTEGER NOT NULL,
  gebucht_am    TEXT NOT NULL DEFAULT (datetime('now')),
  gebucht_von   INTEGER NOT NULL REFERENCES users(id),  -- Admin bucht fuer andere
  grund         TEXT,          -- bei Gegenbuchung: worauf sie sich bezieht
  -- Nie hart loeschen (Entscheidung 15).
  storniert_am  TEXT,
  storniert_von INTEGER REFERENCES users(id)
);

CREATE INDEX buchung_gruppe_zeit ON buchung(gruppe_id, gebucht_am);
CREATE INDEX buchung_user_zeit   ON buchung(user_id, gebucht_am);

-- Warenbewegung. Eine Zeile je Ereignis, der Bestand ist ihre Summe - dieselbe
-- Bauweise wie `reports`: nie ueberschreiben, der Verlauf ergibt sich von
-- selbst.
CREATE TABLE bestand (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id    INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  getraenk_id  INTEGER NOT NULL REFERENCES getraenk(id),
  menge        INTEGER NOT NULL,        -- + Lieferung/Storno, − Verbrauch/Schwund
  art          TEXT NOT NULL CHECK (art IN ('lieferung','verbrauch','korrektur')),
  -- Nur bei 'lieferung': was die Lieferung INSGESAMT gekostet hat.
  einkauf_cent INTEGER,
  grund        TEXT,                    -- Pflicht bei 'korrektur'
  buchung_id   INTEGER REFERENCES buchung(id),   -- gesetzt bei 'verbrauch' und beim Storno-Ausgleich
  erfasst_von  INTEGER REFERENCES users(id),
  erstellt     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bestand_lauf     ON bestand(gruppe_id, getraenk_id, erstellt);
CREATE INDEX bestand_buchung  ON bestand(buchung_id);
