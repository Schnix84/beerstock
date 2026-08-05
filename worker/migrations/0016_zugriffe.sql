-- ===========================================================================
-- Schema 16: Aktivitaet — eine Zeile je authentifiziertem Aufruf.
--
-- Anders als `tokens.zuletzt` (auf eine Stunde gedrosselt, ueberschrieben,
-- also nur "wann zuletzt") ist das hier ungedrosselt und historisch: Grundlage
-- fuer die Anzeige im Kontor "wie viele Aufrufe, insgesamt und je Tag, je
-- Nutzer und je Nutzer und Tag". Bei einer Handvoll Nutzern ist das keine
-- Zeilenflut - deshalb hier ohne die Drosselung, die `nutzer()` sonst braucht.
-- ===========================================================================

CREATE TABLE zugriffe (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  erstellt TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX zugriffe_user_zeit ON zugriffe(user_id, erstellt DESC);
CREATE INDEX zugriffe_zeit ON zugriffe(erstellt DESC);
