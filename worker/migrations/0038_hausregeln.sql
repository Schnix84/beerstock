-- ===========================================================================
-- Schema 38: Die Hausordnung — eigene Regeln je Gruppe, und Strafen danach.
--
-- Etappe 8 des Gruppen-Umbaus (ideas/plan-gruppen.md, Entscheidungen 45-56,
-- §4.1, §5.4, §6). Drei CREATE-Schritte und EIN Schalter. Kein Backfill: die
-- Hausordnung ist fuer jede Gruppe leer, bis jemand die erste Regel schreibt.
--
-- WARUM `regeln_an` AB WERK AUS STEHT — als einziger der sieben Schalter.
-- Die anderen sechs entstanden mit den Gruppen selbst (0032) und waren vom
-- ersten Tag an nuetzlich: eine Tafel zeigt Bestaende, eine Kasse bucht, ein
-- Rad dreht. Eine LEERE Hausordnung zeigt gar nichts. Stuende der Schalter auf
-- 1, bekaeme beim Ausrollen dieser Migration jede bestehende Gruppe eine tote
-- Zunge geschenkt, die niemand bestellt hat.
--
-- Diese EINE Vorgabe traegt zugleich den Bestand und jede kuenftige Gruppe:
-- `POST /api/gruppen` zaehlt die Schalter gar nicht auf
-- (`INSERT INTO gruppen (name, slug, beschreibung, sichtbar, erstellt_von)`),
-- eine neue Gruppe faellt also auf denselben Spaltenwert. Kein Worker-Eingriff,
-- kein zweiter Ort, an dem "aus" steht.
--
-- DAS IST EINE BEWUSSTE ABWAEGUNG, KEINE NACHLAESSIGKEIT — derselbe Satz wie
-- in §4.3 des Plans, und aus demselben Grund: wer hier "aufraeumt" und auf 1
-- dreht, damit es zu den anderen sechs passt, macht es kaputt.
--
-- WARUM EINE STRAFE KEINE BUCHUNG IST (Entscheidung 50). Die naheliegende
-- Abkuerzung waere eine Getraenkeart "Strafe" mit passendem Preis gewesen -
-- dann truege die Kasse aus 0034 alles von selbst. Sie ist an vier Stellen
-- zugleich falsch:
--   * `POST /api/kasse/buchung` schreibt zu jeder Buchung eine
--     `verbrauch`-Zeile in `bestand`. Eine Strafe verbraucht nichts; der
--     Bestand der Schein-Art liefe ins Minus und die Warnzeile aus
--     Entscheidung 34 ginge an.
--   * Der Bestandsverlauf (Etappe 6) zeichnet eine Linie je Getraenkeart. Eine
--     davon hiesse "Strafe" und fiele monoton ins Bodenlose.
--   * "Wer hat wieviel GETRUNKEN" zaehlt Mengen. Drei Strafen saehen aus wie
--     drei Bier.
--   * `buchung.grund` traegt seit Etappe 4 schon eine Sonderbedeutung
--     (Praefix `gegenbuchung:`); eine zweite waere die dritte Bedeutung
--     desselben Feldes.
-- Der Preis dafuer ist genau eine Stelle: der Monatsabschluss summiert aus
-- ZWEI Quellen. Diese Summe steht seit Etappe 4 in EINER Konstante
-- (`SALDO_SUMMEN_SQL` im Worker) - Etappe 8 erweitert sie und legt keine
-- zweite an.
--
-- WARUM `strafe` KEINE HISTORISIERUNG BRAUCHT wie `preis` aus 0034. Die
-- verhaengte Strafe friert Titel, Art und Betrag ein (Entscheidung 47) -
-- dieselbe Bauweise wie `buchung.cent`. Die Vergangenheit steht damit in den
-- Strafen, nicht in der Regel; die Regel darf sich frei aendern und wird nie
-- geloescht, nur `aktiv = 0`.
-- ===========================================================================

-- Der siebte Schalter (Entscheidung 45). `NOT NULL DEFAULT 0` traegt beim
-- ADD COLUMN, solange die Vorgabe konstant ist; CHECK darf mit (nur PRIMARY
-- KEY und UNIQUE sind beim ADD COLUMN verboten).
ALTER TABLE gruppen ADD COLUMN regeln_an INTEGER NOT NULL DEFAULT 0
  CHECK (regeln_an IN (0,1));

-- ---------------------------------------------------------------------------
-- Die Hausordnung einer Gruppe (Entscheidung 46).
-- ---------------------------------------------------------------------------
CREATE TABLE hausregel (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id    INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  titel        TEXT NOT NULL,          -- "Licht aus"
  text         TEXT,                   -- der ausgeschriebene Satz
  -- Genau EINE Strafe je Regel. Wer Geld UND Tat will, legt zwei Regeln an -
  -- eine Kombination waere ein zweiter Betragsbegriff und eine zweite
  -- Erledigungskette in derselben Zeile.
  art          TEXT NOT NULL CHECK (art IN ('geld','tat')),
  cent         INTEGER CHECK (cent IS NULL OR cent >= 0),  -- nur bei 'geld'
  tat          TEXT,                   -- nur bei 'tat': "bringt einen Kasten mit"
  aktiv        INTEGER NOT NULL DEFAULT 1 CHECK (aktiv IN (0,1)),
  reihenfolge  INTEGER NOT NULL DEFAULT 0,
  erstellt     TEXT NOT NULL DEFAULT (datetime('now')),
  erstellt_von INTEGER REFERENCES users(id)
);

/* PARTIELL, und das ist der Punkt: eine deaktivierte Regel bleibt fuer immer
   stehen (47). Ohne `WHERE aktiv = 1` koennte niemand je wieder eine Regel
   "Licht aus" anlegen, nachdem die alte einmal abgeschaltet wurde, und der
   einzige Ausweg waere, die gewuenschte Regel umzubenennen. Genau so steht es
   fuer `getraenk` in 0034 (`getraenk_name`, Zeile 59) - dieselbe Falle, schon
   einmal getreten. */
CREATE UNIQUE INDEX hausregel_titel ON hausregel(gruppe_id, titel) WHERE aktiv = 1;
CREATE INDEX hausregel_lauf ON hausregel(gruppe_id, aktiv, reihenfolge);

-- ---------------------------------------------------------------------------
-- Die verhaengte Strafe.
-- ---------------------------------------------------------------------------
CREATE TABLE strafe (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id       INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  -- NULL = freie Strafe ohne Regel (Entscheidung 49). Sonst muesste der Admin
  -- fuer jeden Einzelfall eine Regel erfinden, die danach in der Hausordnung
  -- stehen bleibt.
  regel_id        INTEGER REFERENCES hausregel(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  -- EINGEFROREN, redundant zu `hausregel` - und genau das ist gewollt (47),
  -- dieselbe Bauweise wie `buchung.cent`.
  titel           TEXT NOT NULL,
  art             TEXT NOT NULL CHECK (art IN ('geld','tat')),
  /* Der GANZE Betrag, kein Einzelpreis: eine Strafe hat keine Menge. Also
     `sum(cent)`, nicht `sum(menge * cent)` - der genaue Gegensatz zur
     `buchung`, wo die Verwechslung der vierte Blocker der Etappe-6-Abnahme
     war. Negativ erlaubt: so sieht die Gutschrift aus (Entscheidung 52). */
  cent            INTEGER,
  tat             TEXT,
  grund           TEXT,                -- was genau vorgefallen ist
  -- Bestimmt den Abrechnungsmonat (51), wie `buchung.gebucht_am`. Wird nie
  -- gebunden - immer Server-Jetzt, es gibt kein rueckdatiertes Verhaengen.
  verhaengt_am    TEXT NOT NULL DEFAULT (datetime('now')),
  verhaengt_von   INTEGER NOT NULL REFERENCES users(id),

  /* FUENF ZUSTAENDE IN ETAPPE 8 - dieselbe Zahl wie bei `saldo` aus 0035:
       geld: offen -> abgerechnet | erlassen
       tat:  offen -> gemeldet -> erledigt | erlassen
     Eine Geldstrafe kennt kein "erledigt": sie wandert in die Abrechnung, und
     bezahlt wird ueber `saldo`. Zwei Buchhaltungen fuer dasselbe Geld gibt es
     nicht (Entscheidung 55).

     DIE DREI UEBRIGEN WERTE SCHREIBT ERST ETAPPE 9 (Vorschlag durch ein
     Mitglied, Einspruch des Betroffenen). Sie stehen trotzdem schon hier, und
     das ist kein Versehen: SQLite kann eine CHECK-Klausel nicht nachtraeglich
     erweitern - das waere ein Tabellentausch, und wovor der in diesem Repo
     steht, sagt der Nachtrag zu §4.3 (Etappe 1: `PRAGMA foreign_keys = OFF`
     traegt in einer D1-Migration nicht, und der Tausch scheitert nur gegen
     eine BEFUELLTE Datenbank, lokal also nie). Drei ungenutzte Werte sind
     billiger als der sichere Tausch einer befuellten Tabelle. */
  status          TEXT NOT NULL DEFAULT 'offen'
                    CHECK (status IN ('offen','gemeldet','erledigt','abgerechnet',
                                      'erlassen','vorgeschlagen','verworfen','bestritten')),
  gemeldet_am     TEXT,
  erledigt_am     TEXT,
  erledigt_von    INTEGER REFERENCES users(id),

  -- Gesetzt vom Monatsabschluss: in welchen Saldo die Geldstrafe geflossen
  -- ist. Damit ist "schon abgerechnet" eine Tatsache und keine Rechnung ueber
  -- Daten - und der Guard gegen ein nachtraegliches Erlassen (52) braucht
  -- keine Datumsarithmetik.
  abrechnung_id   INTEGER REFERENCES abrechnung(id),
  -- Nur bei einer Gutschrift (52): worauf sie sich bezieht.
  bezug_strafe_id INTEGER REFERENCES strafe(id)
);

CREATE INDEX strafe_gruppe_zeit ON strafe(gruppe_id, verhaengt_am);
CREATE INDEX strafe_user_zeit   ON strafe(user_id, verhaengt_am);
CREATE INDEX strafe_offen       ON strafe(gruppe_id, status);

/* Wie `buchung_gegen` aus 0035: EINE Gutschrift je Strafe, sonst schriebe ein
   Doppelklick zwei und der Betrag waere zweimal gutgeschrieben. Und wie dort
   gibt eine ERLASSENE Gutschrift den Platz wieder frei - ohne diesen Zusatz
   waere nach einem einmaligen Erlassen fuer immer jede weitere Gutschrift zur
   selben Strafe gesperrt (genau die Falle, die in Etappe 4 erst die Abnahme
   fand). */
CREATE UNIQUE INDEX strafe_gutschrift ON strafe(bezug_strafe_id)
  WHERE bezug_strafe_id IS NOT NULL AND status <> 'erlassen';

-- ---------------------------------------------------------------------------
-- Jeder Statuswechsel, damit es keine Diskussion gibt - wortgleich zu
-- `saldo_log` aus 0035 (Entscheidung 22).
--
-- `admin_log` bekommt hiervon NICHTS ab: das traegt Instanz- und
-- Durchgriffshandlungen (Entscheidung 4, siehe `kasseAdminLog`), nicht den
-- Alltag eines Gruppenadmins in seiner eigenen Gruppe.
-- ---------------------------------------------------------------------------
CREATE TABLE strafe_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  strafe_id INTEGER NOT NULL REFERENCES strafe(id) ON DELETE CASCADE,
  alt       TEXT,
  neu       TEXT NOT NULL,
  von       INTEGER NOT NULL REFERENCES users(id),
  notiz     TEXT,
  erstellt  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX strafe_log_zeit ON strafe_log(strafe_id, erstellt);
