-- ===========================================================================
-- Schema 9: die Sterne am Kommentar sind ein SCHNAPPSCHUSS.
--
-- Bisher holte der Baum sie ueber `bewertung_id` live aus `bewertungen` - und
-- das ist genau die Zeile, die beim naechsten Tap ueberschrieben wird. Wer
-- "super Abend" mit fuenf Sternen schrieb und die Note spaeter auf zwei senkte,
-- dessen alte Karte las sich rueckwirkend als "super Abend - Stimmung 2*".
--
-- Migration 0007 trennt Sterne und Kommentare in zwei Zeilen, damit eine
-- geaenderte Note den Kommentar nicht mitreisst. Beim ANZEIGEN waren sie
-- trotzdem wieder eine. Also steht der Stand des Absendens jetzt im Kommentar.
--
-- `bewertung_id` bleibt daneben stehen: sie sagt weiter, aus welcher Abgabe die
-- Karte entstanden ist - fuer die Anzeige gelesen wird sie nicht mehr.
-- ===========================================================================

ALTER TABLE kommentare ADD COLUMN sterne TEXT;

-- Der Altbestand bekommt den heutigen Stand seiner Bewertung. Genauer geht es
-- nicht, von der frueheren gibt es keine Spur - und fuer die allermeisten
-- Karten ist es derselbe Wert, den sie beim Schreiben getragen haben.
UPDATE kommentare
   SET sterne = (SELECT b.sterne FROM bewertungen b WHERE b.id = kommentare.bewertung_id)
 WHERE bewertung_id IS NOT NULL;
