-- ===========================================================================
-- Schema 2: E-Mail statt Einladungscode, Magic Link statt Token-fuer-immer.
--
-- Warum der Umbau: der Zugang steckte in einem einzigen Token im localStorage
-- eines einzigen Browsers. Zweites Geraet = ausgesperrt, und Safari auf dem
-- iPhone raeumt script-beschreibbaren Speicher nach sieben Tagen ohne Besuch
-- ohnehin ab. Ein Freund, der alle zwei Wochen reinschaut, waere beim
-- uebernaechsten Mal draussen gewesen, ohne etwas falsch gemacht zu haben.
--
-- Jetzt ist die Mailadresse die Identitaet: eintippen, Link klicken, drin -
-- auf jedem Geraet, beliebig oft. Kein Passwort, also auch keines zu
-- vergessen, zu speichern oder zu stehlen.
-- ===========================================================================

-- ACHTUNG, teuer gelernt (2026-08-02): hier stand zuerst
-- `PRAGMA defer_foreign_keys = TRUE`. Das verschiebt nur die PRUEFUNG von
-- Fremdschluesseln ans Transaktionsende - die AKTION `ON DELETE CASCADE`
-- unterdrueckt es nicht. `DROP TABLE users` fuehrt intern ein DELETE aus, und
-- das hat prompt `reports` und `tokens` mit ausgeraeumt, obwohl beide gerade
-- erst befuellt worden waren. Nur `foreign_keys = OFF` haelt die Kaskade an.
PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------------------
-- Geraete-Token. Vorher eine Spalte an `users`, also genau eines je Nutzer -
-- Handy und Laptop haetten sich gegenseitig ausgeloggt.
-- ---------------------------------------------------------------------------
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  erstellt   TEXT NOT NULL DEFAULT (datetime('now')),
  zuletzt    TEXT
);
CREATE INDEX tokens_user ON tokens(user_id);

-- Die bestehenden Token retten, bevor die Spalte verschwindet (aktuell genau
-- eines: der Dienstnutzer, unter dem Home Assistant meldet).
INSERT INTO tokens (token_hash, user_id, erstellt)
  SELECT token_hash, id, erstellt FROM users;

-- ---------------------------------------------------------------------------
-- users neu bauen. `name` muss NULL sein duerfen: der Nutzer entsteht beim
-- Einloesen des Links, den Namen fuer die Liste waehlt er erst danach.
-- SQLite kann NOT NULL nicht nachtraeglich loesen, also Tabellentausch.
-- ---------------------------------------------------------------------------
CREATE TABLE users_neu (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL beim Dienstnutzer: Home Assistant hat kein Postfach und meldet sich
  -- auch nie an, es besitzt schlicht ein Token.
  email      TEXT UNIQUE,
  name       TEXT,
  name_klein TEXT UNIQUE,
  quelle     TEXT NOT NULL DEFAULT 'mensch',
  erstellt   TEXT NOT NULL DEFAULT (datetime('now')),
  zuletzt    TEXT
);

INSERT INTO users_neu (id, email, name, name_klein, quelle, erstellt, zuletzt)
  SELECT id, NULL, name, name_klein, quelle, erstellt, zuletzt FROM users;

DROP TABLE users;
ALTER TABLE users_neu RENAME TO users;

-- ---------------------------------------------------------------------------
-- Offene Magic Links. Kurzlebig und einmal einloesbar; auch hier steht nur
-- der Hash, damit ein Datenbankabzug keine offenen Tueren enthaelt.
-- ---------------------------------------------------------------------------
CREATE TABLE magic (
  token_hash    TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  erstellt      TEXT NOT NULL DEFAULT (datetime('now')),
  laeuft_ab     TEXT NOT NULL,
  verbraucht_am TEXT
);
-- Traegt die Missbrauchsbremse: "wie viele Links gingen an diese Adresse in
-- der letzten Stunde". Offener Zugang plus Mailversand heisst, dass sonst
-- jeder Fremde diesen Posteingang als Versandknopf benutzen koennte.
CREATE INDEX magic_email_zeit ON magic(email, erstellt DESC);
CREATE INDEX magic_zeit ON magic(erstellt DESC);

-- `invites` bleibt liegen, ungenutzt. Der Zugang ist jetzt offen; sollte das
-- eines Tages zurueckgenommen werden, ist die Tabelle noch da.
