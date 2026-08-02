-- ===========================================================================
-- beerstock, Schema 1: Nutzer, Einladungen, Meldungen.
--
-- Grundsatz: in dieser Datenbank steht nichts, was jemanden handlungsfaehig
-- macht. Token und Einladungscodes liegen ausschliesslich als SHA-256-Hex.
-- Ein Abzug der Datenbank verraet damit, WER mitspielt und WIE VIEL Bier er
-- hat - aber niemand kann sich damit als jemand anderes ausgeben.
-- ===========================================================================

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- So, wie er sich schreibt (Grossbuchstaben bleiben erhalten).
  name          TEXT    NOT NULL,
  -- Kleingeschrieben, nur fuer die Eindeutigkeit: sonst sitzen "Basti" und
  -- "basti" nebeneinander in der Liste und niemand weiss, wer wer ist.
  name_klein    TEXT    NOT NULL UNIQUE,
  token_hash    TEXT    NOT NULL UNIQUE,
  -- 'mensch' tippt seine Werte, 'ha' meldet gemessen aus dem Kuehlschrank.
  -- Die Seite zeichnet danach die Marke "gemessen".
  quelle        TEXT    NOT NULL DEFAULT 'mensch',
  erstellt      TEXT    NOT NULL DEFAULT (datetime('now')),
  zuletzt       TEXT
);

CREATE TABLE invites (
  code_hash      TEXT PRIMARY KEY,
  erstellt       TEXT NOT NULL DEFAULT (datetime('now')),
  -- NULL = laeuft nie ab. Ein Code fuer einen Freund, der ihn ein halbes Jahr
  -- im Chat liegen laesst, soll noch funktionieren.
  laeuft_ab      TEXT,
  verbraucht_von INTEGER REFERENCES users(id),
  verbraucht_am  TEXT
);

CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  biere       INTEGER NOT NULL,
  temperatur  REAL    NOT NULL,
  gemeldet_am TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Meldungen werden NIE ueberschrieben. Der aktuelle Stand ist die juengste
-- Zeile je Nutzer, der Verlauf ergibt sich dadurch von selbst - eine zweite
-- Tabelle fuer die Historie waere dieselbe Information ein zweites Mal.
-- Dieser Index traegt beide Abfragen.
CREATE INDEX reports_user_zeit ON reports(user_id, gemeldet_am DESC);
