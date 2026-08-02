-- ===========================================================================
-- Schema 10: Das Ende eines Abends.
--
-- Bis hierher hatte ein Termin nur einen Anfang. Ab `beginnt_am` galt er als
-- gewesen - die Liste schob ihn in derselben Minute unter "gewesen", in der er
-- anfing. Ein laufender Abend war damit gar nicht darstellbar.
--
-- Die Vorgabe ist `beginnt_am` + TERMIN_DAUER_STD (4 Stunden) und wird im
-- Worker gerechnet, nicht hier: SQLite laesst `datetime(beginnt_am,'+4 hours')`
-- als DEFAULT ohnehin nicht zu, und zwei Fassungen derselben Zahl laufen
-- frueher oder spaeter auseinander.
--
-- Es bleibt bei einer ANZEIGE. Die Aenderungssperre (409 "Der Abend hat schon
-- angefangen") und die Freigabe zum Bewerten haengen weiter am Anfang - was
-- gelaufen ist, bleibt stehen, und bewerten darf man ab dem ersten Bier.
--
-- NULL ist erlaubt, obwohl der Worker die Spalte immer fuellt: ein
-- ALTER TABLE ... NOT NULL braucht in SQLite einen konstanten DEFAULT, und ein
-- konstanter Zeitpunkt waere hier schlicht falsch. Wer liest, faellt bei NULL
-- auf das alte Verhalten zurueck ("kein Ende bekannt").
--
-- ZEIT: absolut in UTC, wie `beginnt_am`.
-- ===========================================================================

ALTER TABLE termine ADD COLUMN endet_am TEXT;   -- UTC, 'YYYY-MM-DD HH:MM:SS'

-- Die Abende, die es schon gibt, bekommen dieselbe Vorgabe rueckwirkend -
-- sonst stuende die ganze bisherige Chronik ohne Ende da, und die Liste
-- traefe fuer alte und neue Zeilen verschiedene Entscheidungen.
UPDATE termine SET endet_am = datetime(beginnt_am, '+4 hours') WHERE endet_am IS NULL;
