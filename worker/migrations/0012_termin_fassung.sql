-- ===========================================================================
-- Schema 12: Die wievielte Fassung eines Abends.
--
-- Kommt allein wegen der Kalendereintraege in den Mails. Ein iCalendar-Eintrag
-- traegt eine feste UID (`termin-<id>@beerstock`) und eine SEQUENCE; nur wenn
-- die SEQUENCE STEIGT, ersetzt ein Kalenderprogramm den vorhandenen Eintrag,
-- statt einen zweiten daneben anzulegen. Ohne diese Spalte stuende nach drei
-- Verschiebungen viermal derselbe Abend im Kalender.
--
-- Warum eine Spalte und nicht `strftime('%s','now')` als SEQUENCE: eine
-- Unix-Sekunde ist zwar auch monoton, laeuft aber 2038 aus dem Wertebereich
-- (SEQUENCE ist ein 32-Bit-Integer), und sie sagt nichts. `fassung` ist
-- lesbar: 0 ist der Abend, wie er entstand, 3 der dreimal geaenderte.
--
-- Hochgezaehlt wird ausschliesslich in `POST /api/termin/aendern` - einmal je
-- Aenderung, Absage eingeschlossen. Wer die Spalte anderswo anfasst, erzeugt
-- Kalendereintraege, die sich gegenseitig ueberschreiben.
-- ===========================================================================

ALTER TABLE termine ADD COLUMN fassung INTEGER NOT NULL DEFAULT 0;
