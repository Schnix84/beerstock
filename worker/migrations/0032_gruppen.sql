-- ===========================================================================
-- Schema 32: Es gibt Gruppen.
--
-- Bis hierher war diese Anwendung EINE Runde. Jede Tabelle beschrieb dieselbe
-- Wirtschaft, jeder Angemeldete sah dieselbe Tafel, und die Frage "welche?"
-- stellte sich nie. Ab hier ist sie eine Wirtschaft mit mehreren Tischen:
-- ein Freundeskreis, ein Buero, eine WG - jede mit eigenem Rad, eigenem
-- Notruf, eigener Kasse, und alle in derselben Datenbank.
--
-- Diese Datei legt NUR die Gruppe und die Zugehoerigkeit an. Die Ereignisse
-- (Los, Notruf, Termin, Kommentar, Bewertung) bekommen ihre Gruppe in 0033.
-- BEIDE MUESSEN ZUSAMMEN AUSGEROLLT WERDEN: ein Worker, der zwischen den
-- beiden Staenden laeuft, sieht Ereignisse ohne Gruppe.
--
-- WARUM DIE SCHALTERLEISTE IN DIESER TABELLE STEHT und nicht in einer eigenen.
-- Sechs Flags, die immer gemeinsam gelesen werden - jede Route, die eine
-- Gruppe aufloest, will sie mit demselben SELECT haben, mit dem sie die
-- Mitgliedschaft prueft. Eine Nebentabelle waere ein zweiter Join fuer eine
-- Zeile, die es nur einmal je Gruppe gibt. Und ein JSON-Feld waere die
-- CHECK-Pruefung los, die hier den ganzen Wert ausmacht: ein Schalter kann
-- nur 0 oder 1 sein.
--
-- WAS EIN AUSGESCHALTETER SCHALTER TUT: nichts loeschen. Er blendet aus und
-- weist die Route ab; beim Wiedereinschalten steht alles unveraendert da.
-- Deshalb gibt es hier auch kein Feld "seit wann aus" - das waere eine
-- Geschichte ueber eine Sichtbarkeit, und die interessiert niemanden.
--
-- WARUM `gruppen_mitglied` KEIN `verlassen_am` HAT. Die Statistik filtert
-- nach der HEUTIGEN Mitgliedschaft ("die Runde, wie sie heute ist"), ein
-- Austritt loescht die Zeile also wirklich. Was der Ausgetretene schuldet,
-- ueberlebt das trotzdem: Buchungen und Salden zeigen auf `users`, nicht auf
-- diese Tabelle. Wer geht, nimmt seine Schulden nicht mit.
--
-- WARUM DIE EINLADUNG NUR DEN HASH TRAEGT. Grundsatz aus 0001 und 0027: ein
-- Abzug der Datenbank macht niemanden handlungsfaehig. Der Klartext wird beim
-- Anlegen genau einmal gezeigt und danach nirgends mehr - wer ihn verliert,
-- macht einen neuen Link, statt einen alten nachzuschlagen.
--
-- WARUM `push_stumm` SCHON HIER LIEGT und nicht bei der Post ganz am Ende.
-- Sobald jemand seine zweite Gruppe gruendet - und das ist ab dieser Datei
-- moeglich -, kommen Rad und Notruf aus mehreren Gruppen aufs selbe Telefon.
-- Ohne diese Tabelle gaebe es bis dahin keinen Weg, eine davon leiser zu
-- stellen. Eine ZEILE HEISST STUMM: kein Eintrag ist der Normalfall, und ein
-- neuer Beitritt ist damit von selbst laut, ohne dass jemand etwas anlegen
-- muss.
--
-- WARUM `admin_log.gruppe_id` HIER DAZUKOMMT, aus demselben Grund: der
-- Austritt des letzten Admins laesst das dienstaelteste Mitglied nachruecken,
-- und das wird protokolliert. Eine fehlende Spalte waere dort kein NULL,
-- sondern ein SQL-Fehler am ersten Tag. NULL heisst weiterhin "instanzweit",
-- also der Wirt.
--
-- ZEIT: alles UTC im Format 'YYYY-MM-DD HH:MM:SS', wie im ganzen Schema.
-- ===========================================================================

-- Reine CREATE- und ADD-COLUMN-Schritte, kein Tabellentausch - also auch kein
-- `PRAGMA foreign_keys = OFF`.

CREATE TABLE gruppen (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,                    -- Anzeigename, "Am Tresen"
  slug         TEXT NOT NULL UNIQUE,             -- kleingeschrieben, fuer Adressen
  beschreibung TEXT,                             -- was die Gruppensuche zeigt

  -- 'oeffentlich' heisst NUR: die Gruppe taucht in der Suche auf, mit Name,
  -- Beschreibung und Mitgliederzahl. Nie mit Namen, nie mit Bestaenden. Rein
  -- kommt man auch dann nur ueber einen Antrag, den der Gruppenadmin
  -- bescheidet - eine Gruppe zum Direkteintreten gibt es nicht.
  sichtbar     TEXT NOT NULL DEFAULT 'privat'
                 CHECK (sichtbar IN ('privat','oeffentlich')),

  -- Die Schalterleiste. Vorgabe: alles an, wie es die Tafel heute kennt. Ein
  -- Buero nimmt Kasse und Termine und laesst Tafel, Rad und Notruf aus.
  -- `tafel_an` und `rad_an` sind AUSDRUECKLICH entkoppelt: eine Gruppe ohne
  -- Tafel darf trotzdem drehen, dann gleichverteilt statt nach Bestand
  -- gewichtet. Zwei Ziehungswege, beide erklaerbar.
  tafel_an     INTEGER NOT NULL DEFAULT 1 CHECK (tafel_an     IN (0,1)),
  rad_an       INTEGER NOT NULL DEFAULT 1 CHECK (rad_an       IN (0,1)),
  notruf_an    INTEGER NOT NULL DEFAULT 1 CHECK (notruf_an    IN (0,1)),
  termine_an   INTEGER NOT NULL DEFAULT 1 CHECK (termine_an   IN (0,1)),
  kasse_an     INTEGER NOT NULL DEFAULT 1 CHECK (kasse_an     IN (0,1)),
  statistik_an INTEGER NOT NULL DEFAULT 1 CHECK (statistik_an IN (0,1)),

  erstellt_von INTEGER REFERENCES users(id),
  erstellt     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Die Suche liest genau in dieser Richtung: die oeffentlichen, nach Namen.
CREATE INDEX gruppen_suche ON gruppen(sichtbar, name);

CREATE TABLE gruppen_mitglied (
  gruppe_id   INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  rolle       TEXT NOT NULL DEFAULT 'member' CHECK (rolle IN ('member','admin')),
  -- Traegt das Nachruecken: verliert eine Gruppe ihren letzten Admin, wird das
  -- dienstaelteste verbliebene Mitglied ernannt. Deshalb ist dieses Feld kein
  -- Schmuck, sondern eine Entscheidungsgrundlage.
  beigetreten TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (gruppe_id, user_id)
);

-- Der Primaerschluessel traegt die Richtung (gruppe_id, user_id); dieser Index
-- traegt die andere, und die ist die haeufigere: "in welchen Gruppen bin ich?"
-- fragt jede Anmeldung, jeder Verteileranstoss und `start.html`.
CREATE INDEX gruppen_mitglied_user ON gruppen_mitglied(user_id);

CREATE TABLE gruppen_anfrage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id      INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'offen'
                   CHECK (status IN ('offen','angenommen','abgelehnt')),
  gestellt       TEXT NOT NULL DEFAULT (datetime('now')),
  beschieden     TEXT,
  beschieden_von INTEGER REFERENCES users(id)
);

-- Partiell, nach dem Muster von `mail_einmal` (0011) und `los_gueltig` (0004):
-- EIN offener Antrag je Mensch und Gruppe, sonst stapelt ein Ungeduldiger dem
-- Admin zwanzig gleiche Zeilen ins Kontor. Nach einer Ablehnung darf man es
-- spaeter noch einmal versuchen - deshalb partiell und nicht rundheraus.
CREATE UNIQUE INDEX gruppen_anfrage_offen
  ON gruppen_anfrage(gruppe_id, user_id) WHERE status = 'offen';

CREATE TABLE gruppen_einladung (
  token_hash    TEXT PRIMARY KEY,
  gruppe_id     INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  erstellt_von  INTEGER REFERENCES users(id),
  erstellt      TEXT NOT NULL DEFAULT (datetime('now')),
  laeuft_ab     TEXT,                  -- NULL = laeuft nie ab
  max_nutzung   INTEGER,               -- NULL = beliebig oft
  genutzt       INTEGER NOT NULL DEFAULT 0,
  -- Widerrufen statt geloescht: der Admin soll sehen, dass es den Link gab.
  widerrufen_am TEXT
);

CREATE INDEX gruppen_einladung_gruppe ON gruppen_einladung(gruppe_id);

CREATE TABLE push_stumm (
  user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  gruppe_id INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, gruppe_id)
);

ALTER TABLE admin_log ADD COLUMN gruppe_id INTEGER REFERENCES gruppen(id);

-- ---------------------------------------------------------------------------
-- Die Auffanggruppe.
--
-- Alles, was es heute gibt, ist EINE Runde, und die heisst ab jetzt "Am
-- Tresen": privat, alle sechs Schalter an, so wie sich die Anwendung bis
-- hierher angefuehlt hat. Fuer den Nutzer aendert sich damit nichts - er
-- bekommt nur einen Namen fuer das, was er ohnehin benutzt.
--
-- IDEMPOTENT ueber den SLUG, nicht ueber die Id: `WHERE NOT EXISTS` steht an
-- jedem der drei Schritte, ein zweiter Lauf verdoppelt nichts. Die Id 1 wird
-- trotzdem ausdruecklich gesetzt, damit sie in jeder Instanz dieselbe ist -
-- ABER der Worker darf sich nie auf sie verlassen: er sucht ueber den Slug.
-- Eine feste Id in Code waere genau die Sorte Annahme, die in einer frisch
-- migrierten Testinstanz stillschweigend danebengreift.
-- ---------------------------------------------------------------------------
INSERT INTO gruppen (id, name, slug, beschreibung, sichtbar, erstellt_von)
  SELECT 1, 'Am Tresen', 'am-tresen',
         'Die Runde, mit der alles angefangen hat.', 'privat',
         (SELECT id FROM users WHERE rolle = 'admin' AND entfernt_am IS NULL
            ORDER BY id LIMIT 1)
  WHERE NOT EXISTS (SELECT 1 FROM gruppen WHERE slug = 'am-tresen');

-- Jeder lebende Nutzer wird Mitglied; wer Wirt ist (`users.rolle = 'admin'`),
-- wird zusaetzlich Gruppenadmin. Die beiden Rollen sind zwei verschiedene
-- Dinge und bleiben es: `users.rolle` sagt "dem gehoert der Laden",
-- `gruppen_mitglied.rolle` sagt "der fuehrt DIESEN Tisch".
--
-- ENTFERNTE bleiben draussen (`entfernt_am IS NULL`), Gesperrte kommen mit:
-- ein Gesperrter darf weiter lesen, er ist nur stumm gestellt.
--
-- `beigetreten` bekommt den Anmeldezeitpunkt aus `users.erstellt` und nicht
-- `now`. Sonst traeten beim Einspielen alle in derselben Sekunde bei, und das
-- Nachruecken haette bei einem verwaisten Tisch keine Rangfolge, sondern ein
-- Wuerfeln zwischen sieben gleichen Zeitstempeln.
INSERT INTO gruppen_mitglied (gruppe_id, user_id, rolle, beigetreten)
  SELECT (SELECT id FROM gruppen WHERE slug = 'am-tresen'),
         u.id,
         CASE WHEN u.rolle = 'admin' THEN 'admin' ELSE 'member' END,
         u.erstellt
    FROM users u
   WHERE u.entfernt_am IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM gruppen_mitglied m
            WHERE m.user_id = u.id
              AND m.gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen'));

-- ---------------------------------------------------------------------------
-- Pruefsaetze. Beide von Hand nachfahren (`wrangler d1 execute … --command`),
-- die Migration selbst kann an ihnen nicht scheitern - SQLite kennt kein
-- RAISE ausserhalb eines Triggers.
--
--   Muss 1 ergeben:
--     SELECT count(*) FROM gruppen WHERE slug = 'am-tresen';
--
--   Muessen dieselbe Zahl ergeben (jeder lebende Nutzer ist Mitglied):
--     SELECT count(*) FROM gruppen_mitglied
--       WHERE gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen');
--     SELECT count(*) FROM users WHERE entfernt_am IS NULL;
--
--   Muss mindestens 1 ergeben, solange es einen Wirt gibt:
--     SELECT count(*) FROM gruppen_mitglied
--       WHERE rolle = 'admin'
--         AND gruppe_id = (SELECT id FROM gruppen WHERE slug = 'am-tresen');
-- ---------------------------------------------------------------------------
