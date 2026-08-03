-- ===========================================================================
-- Schema 11: Rollen, Sperre, Benachrichtigungen.
--
-- Drei Dinge auf einmal, weil sie zusammengehoeren: wer verwalten darf, wen
-- man aus dem Topf nimmt, und wer welche Post bekommen will.
--
-- KEIN Tabellentausch, anders als 0002 und 0004 - alles sind reine
-- ADD COLUMN. Darum steht hier auch kein `PRAGMA foreign_keys = OFF`: das
-- gehoert an den Kopf jeder Migration, die eine Tabelle TAUSCHT (0002
-- erklaert, warum `defer_foreign_keys` dafuer nicht genuegt). Wer aus dieser
-- Migration doch einmal einen Tausch macht, muss es wieder hinschreiben.
--
-- ZEIT: ueberall UTC, 'YYYY-MM-DD HH:MM:SS', wie im ganzen Schema.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Rolle und Sperre.
--
-- Zwei Rollen, mehr nicht: ein feingranulares Rechtesystem (darf_sperren,
-- darf_rundmail ...) waere Verwaltung von Verwaltung fuer eine Runde von
-- sechs Freunden. Eine Spalte, ein CHECK, eine Pruefung im Gate.
--
-- Die Rolle steht NICHT im Token. Das Token ist ein Zufallswert ohne Inhalt,
-- die Rolle wird bei jeder Anfrage gelesen - sonst wirkte eine Degradierung
-- erst beim naechsten Anmelden.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN rolle TEXT NOT NULL DEFAULT 'user'
     CHECK (rolle IN ('user','admin'));

-- Gesperrt heisst: lesen ja, schreiben nein, und raus aus dem Topf. Die Zeile
-- bleibt in der Bestenliste stehen - das ist Historie. Wer GANZ weg soll,
-- wird entfernt, nicht gesperrt.
ALTER TABLE users ADD COLUMN gesperrt_am    TEXT;
-- Fremdschluessel ohne Vorgabewert: bei eingeschalteten `foreign_keys` MUSS
-- die Vorgabe NULL sein, und genau das ist sie.
ALTER TABLE users ADD COLUMN gesperrt_von   INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN gesperrt_grund TEXT;      -- im Worker auf GRUND_MAX begrenzt

-- Weiche Loeschung. Hart geht nicht: `kommentare.autor_id` hat
-- ON DELETE CASCADE (ein DELETE risse Kommentare UND deren Antworten mit),
-- `termine.gastgeber_id` und `los.user_id` haben keine (dort liefe es in
-- einen Fremdschluesselfehler oder hinterliesse Waisen). Also: Adresse und
-- Name weg, Token weg, aus Liste und Topf raus - Beitraege bleiben als
-- "Ehemaliger" stehen.
ALTER TABLE users ADD COLUMN entfernt_am    TEXT;

-- ---------------------------------------------------------------------------
-- Benachrichtigungen.
--
-- `mail_prefs` ist JSON, die Schluessel stehen im Worker (MAIL_ARTEN) - genau
-- wie `bewertungen.sterne` und aus demselben Grund: eine eigene Tabelle waere
-- sechs Zeilen Stammdaten plus ein JOIN je Abruf. NULL = alles auf Vorgabe,
-- fehlende Schluessel ebenso, unbekannte weist der Worker ab.
--
-- `mail_stumm_am` ist der Hauptschalter aus dem Ein-Klick-Abmeldelink und
-- schlaegt jede Einzelwahl, auch die Rundmail.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN mail_prefs     TEXT;
ALTER TABLE users ADD COLUMN mail_stumm_am  TEXT;

-- ---------------------------------------------------------------------------
-- Der Magic Link kann jetzt zweierlei: anmelden oder eine Adresse bestaetigen.
-- Beim Mailwechsel geht der Link an die NEUE Adresse und traegt, zu wem er
-- gehoert - die alte gilt weiter, bis dort geklickt wurde.
-- ---------------------------------------------------------------------------
ALTER TABLE magic ADD COLUMN zweck   TEXT NOT NULL DEFAULT 'anmelden';
ALTER TABLE magic ADD COLUMN user_id INTEGER;          -- nur bei 'mailwechsel'

-- ---------------------------------------------------------------------------
-- Was rausging. Traegt zweierlei: die Doppel-Sperre (ein wiederholter Aufruf
-- nach abgebrochener Verbindung schickt sonst dieselbe Termin-Mail zweimal)
-- und die Datenquelle der Mail-Statistik im Kontor.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_ausgang (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  art         TEXT    NOT NULL,
  bezug       TEXT,                 -- 'los:12', 'termin:7'; NULL bei Rundmail
  gesendet_am TEXT    NOT NULL DEFAULT (datetime('now')),
  fehler      TEXT                  -- gesetzt = ging nicht raus
);
-- Partiell, damit Rundmails (bezug NULL) beliebig oft gehen duerfen.
CREATE UNIQUE INDEX mail_einmal ON mail_ausgang(user_id, art, bezug) WHERE bezug IS NOT NULL;
CREATE INDEX mail_zeit ON mail_ausgang(gesendet_am DESC);

-- ---------------------------------------------------------------------------
-- Wer was mit wem gemacht hat. Kein Audit-System, eine Liste: fuenf Leute,
-- vier moegliche Handlungen, und im Kontor stehen die letzten fuenfzig.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  aktion   TEXT    NOT NULL,        -- 'sperren'|'entsperren'|'rolle'|'entfernen'|'rundmail'
  ziel_id  INTEGER,
  detail   TEXT,
  erstellt TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX admin_log_zeit ON admin_log(erstellt DESC);
