-- ===========================================================================
-- Schema 23: Push aufs Geraet.
--
-- Bis hierher war die Mail der einzige Weg nach draussen. Fuer den Notruf und
-- fuer das Los taugt sie nicht: die Antwortfrist des Gewinners ist drei
-- Stunden, ein Notruf gilt neunzig Minuten, und eine Mail liegt so lange
-- ungelesen im Postfach, wie es dem Postfach gefaellt. Push geht ZUSAETZLICH
-- zur Mail raus, nie statt ihrer - wer keine Geraete angemeldet hat, merkt von
-- dieser Tabelle nichts.
--
-- EIN ABO IST EIN GERAET, nicht ein Mensch. Dasselbe Konto auf Handy, Tablet
-- und Rechner hat drei Zeilen; jede traegt ihre eigenen Schluessel.
--
-- DER ENDPOINT IST PRAKTISCH EIN GEHEIMNIS: wer ihn hat, kann diesem Geraet
-- Meldungen zustellen (die Verschluesselung schuetzt den INHALT, nicht das
-- Zustellrecht). Er steht deshalb nur hier und geht in keiner API-Antwort
-- heraus - auch nicht im Kontor, auch nicht an den Besitzer selbst.
--
-- `UNIQUE` auf `endpoint`, nicht auf `(user_id, endpoint)`: ein Geraet gehoert
-- zu genau einem Konto. Meldet sich auf dem Familientablet jemand anderes an,
-- wandert die Zeile per UPSERT zum neuen Nutzer, statt dass die Meldungen des
-- Vorgaengers dort weiterlaufen.
--
-- KEIN `zuletzt`, KEIN FEHLERZAEHLER, KEIN CRON. Ein totes Abo (App
-- geloescht, Browser zurueckgesetzt, Endpoint rotiert) antwortet mit 404 oder
-- 410, und der Versand loescht die Zeile im selben Atemzug. Die Tabelle raeumt
-- sich damit beim Benutzen auf; eine Spalte, die nur ein Aufraeumjob liest,
-- waere Buchhaltung ueber Buchhaltung.
--
-- Aufgeraeumt wird sonst an drei Stellen, alle im Worker: "alle Geraete
-- abmelden" nimmt die Abos mit, das Kontor loescht sie beim Sperren und beim
-- Entfernen, und `ON DELETE CASCADE` faengt den harten Fall ab, falls je
-- jemand eine Nutzerzeile per SQL loescht.
-- ===========================================================================

CREATE TABLE push_abos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint  TEXT    NOT NULL UNIQUE,
  p256dh    TEXT    NOT NULL,   -- base64url, oeffentlicher Schluessel des Geraets (65 Byte roh)
  auth      TEXT    NOT NULL,   -- base64url, 16 Byte Auth-Geheimnis
  erstellt  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Der einzige Lesepfad: "alle Geraete dieser Empfaenger" - einmal je Anlass,
-- direkt hinter derselben Empfaengerliste, die auch die Mail bekommt.
CREATE INDEX push_abos_user ON push_abos(user_id);
