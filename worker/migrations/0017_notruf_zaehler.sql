-- ===========================================================================
-- Schema 17: Ein Zaehler fuer abgesetzte Notrufe.
--
-- Die Zeile in `notrufe` selbst taugt dafuer nicht: sie erlischt nach
-- NOTRUF_MINUTEN und der Cron raeumt sie spaetestens einen Tag spaeter weg
-- (siehe `waisenWegraeumen` und die Begruendung im Projektgedaechtnis) - eine
-- Rangliste "wer wie oft" daraus waere fast immer fast leer. Ein Zaehler auf
-- `users` bleibt dagegen stehen, OHNE dass er Ort oder Zeitpunkt eines
-- einzelnen Notrufs mitschleppt: er sagt nur "wie oft", nicht "wann" oder
-- "wo" - genau die Grenze, an der die Entscheidung von damals eine Karte der
-- Abende eines Menschen verhindern wollte.
-- ===========================================================================

ALTER TABLE users ADD COLUMN notrufe_insgesamt INTEGER NOT NULL DEFAULT 0;
