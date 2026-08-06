-- ===========================================================================
-- Schema 21: Der Notruf darf sich aussuchen, wer ihn sieht.
--
-- Bis hierher war ein Notruf eine Rundumnachricht: Post an jeden mit Namen
-- (`WHERE id <> ? AND name IS NOT NULL`), und die Karte stand auf JEDER
-- angemeldeten Tafel. Wer nur den Nachbarn meinte, hat trotzdem die ganze
-- Runde angeschrieben und seinen Aufenthaltsort allen gezeigt.
--
-- KEINE ZEILE HEISST "AN ALLE", und das ist die ganze Migration.
--
-- Die Alternative waere eine Spalte `nur_ausgewaehlte` an `notrufe` plus diese
-- Tabelle gewesen - ein Flag, das dasselbe noch einmal sagt, und zwei Stellen,
-- die sich widersprechen koennen (Flag gesetzt, Kreis leer: was gilt dann?).
-- Mit der Abwesenheit von Zeilen als Aussage gibt es diesen Zustand nicht.
--
-- Und es macht die Migration rueckwaertskompatibel, ohne dass jemand etwas
-- nachtragen muss: jeder Notruf, der beim Einspielen offen ist, hat null
-- Zeilen hier und gilt damit weiter fuer alle - genau wie er abgesetzt wurde.
--
-- WER HIER DRINSTEHEN KANN, ist bewusst enger als "alle": der Kreis wird aus
-- der Auswahl auf der Seite gefuellt, und die zeigt (wie `benachrichtige()`)
-- keine Gesperrten und keine Entfernten. Ein Gesperrter sieht einen Notruf an
-- ALLE weiterhin auf seiner Tafel - er ist angemeldet, nur stumm gestellt -,
-- aber er laesst sich nicht einzeln anwaehlen. Das ist Absicht: einen
-- Gesperrten gezielt zu rufen, waere ein Widerspruch in sich.
--
-- Kein `weg_am`, kein Verlauf, wer wann dazukam: der Kreis ist ein Zustand,
-- keine Geschichte. Aus demselben Grund, aus dem es kein Notruf-Archiv gibt
-- (siehe 0013 und 0017) - hier haengt ein Aufenthaltsort dran.
--
-- Das Aufraeumen: `ON DELETE CASCADE` nimmt die Zeilen mit, wenn der Cron den
-- Notruf loescht. Der Cron kehrt zusaetzlich Waisen aus - D1 fuehrt
-- Fremdschluessel zwar durch, aber ein Kreis, der einen geloeschten Notruf
-- ueberlebt, waere die eine Sorte Rest, die hier niemand liegen lassen will.
-- ===========================================================================

CREATE TABLE notruf_kreis (
  notruf_id INTEGER NOT NULL REFERENCES notrufe(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  PRIMARY KEY (notruf_id, user_id)
);

-- Der Lesepfad fragt "sieht DIESER Mensch DIESEN Notruf?" - einmal je offener
-- Seite und Minute, mitten im `batch` der Bestenliste. Der Primaerschluessel
-- traegt die Richtung (notruf_id, user_id) schon; dieser Index traegt die
-- andere, fuer den Fall, dass jemand nach den Notrufen EINES Nutzers fragt.
CREATE INDEX notruf_kreis_user ON notruf_kreis(user_id);
