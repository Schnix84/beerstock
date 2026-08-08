-- ===========================================================================
-- Schema 26: Wer es ausgeloest hat, und wer es bekommen hat.
--
-- Das Protokoll beantwortete seit 0025 "wie viele, wozu, wann". Zwei Fragen
-- blieben offen, und beide stellt ein Mensch sofort, wenn er die Zeile sieht:
--
--   "PUSH  NOTRUF  3 Geraete"   -> von wem? an wen?
--
-- Bisher stand die Antwort nirgends. Bei einem Notruf um drei Uhr nachts ist
-- "wer hat den losgetreten" die erste Frage, und das Kontor konnte sie nicht
-- beantworten - obwohl der Worker den Ausloeser im selben Aufruf in der Hand
-- hielt und ihn nur wegwarf.
--
-- ZWEI SPALTEN, BEIDE OPTIONAL:
--
--   ausloeser_id  wer es angestossen hat, als Fremdschluessel auf users
--   empfaenger    wer es bekommen hat, als NAMEN in einer Zeichenkette
--
-- WARUM DER AUSLOESER EIN SCHLUESSEL IST UND DIE EMPFAENGER NICHT. Der
-- Ausloeser ist EINER und er ist ein Konto - `ON DELETE SET NULL` laesst die
-- Zeile stehen, wenn er spaeter geht, und aus 'Ehemaliger' wird im Protokoll
-- ein sauberes Wort. Die Empfaenger sind SECHS, sie aendern sich nie mehr
-- rueckwirkend, und eine Verknuepfungstabelle fuer eine Liste, die nur
-- angezeigt wird, waere ein Gelenk ohne Bewegung: sechs Zeilen je Vorgang,
-- ein JOIN mehr in jeder Abfrage, und am Ende steht doch nur der Satz
-- "Micha, Basti und Jan" da.
--
-- DIE NAMEN WERDEN EINGEFROREN, und das ist eine Entscheidung, keine
-- Nachlaessigkeit: im Protokoll steht, wer die Mail DAMALS bekommen hat.
-- Benennt sich jemand um, aendert das nicht, an wen im Maerz etwas ging.
-- Genau anders herum als beim Ausloeser, wo der aktuelle Name richtig ist -
-- dort steht ein Mensch, hier ein Vorgang.
--
-- KEINE ADRESSEN. Der Kopf von 0025 verbietet sie, und dieser Schritt haelt
-- sich daran: Namen sind das, wonach gefragt war ("die empfaenger namen
-- (nicht die adressen)"). Damit bleibt der Anmeldelink weiter anonym - er
-- geht an jemanden, der noch kein Konto hat, also gibt es dort auch keinen
-- Namen; die Spalte bleibt NULL, und das eingebaute Verzeichnis der
-- Anmeldeversuche, vor dem 0025 warnt, entsteht nicht.
--
-- WAS ALTE ZEILEN ANGEHT: sie bleiben NULL. Nachtragen kann man den Ausloeser
-- eines Notrufs von gestern nicht - die Auskunft ist nie gespeichert worden.
-- Das Kontor laesst die Stelle dann einfach leer, es behauptet nichts.
--
-- Reines ALTER TABLE ADD COLUMN, zweimal - kein Tabellentausch, also auch
-- kein `PRAGMA foreign_keys = OFF` (siehe den Kopf von 0011). SQLite kann
-- Spalten anhaengen, es kann sie nur nicht wegnehmen oder verschaerfen; beide
-- sind darum ohne NOT NULL und ohne Vorgabe.
--
-- ZEIT: unveraendert UTC, 'YYYY-MM-DD HH:MM:SS'.
-- ===========================================================================

/* Wer den Vorgang angestossen hat. NULL, wo es niemanden gibt: das
   Flaschendrehen zieht der Cron, die Termin-Erinnerung faellt an, und der
   Anmeldelink wird von jemandem angefordert, den es als Konto noch nicht
   gibt.

   `ON DELETE SET NULL` und nicht CASCADE: verlaesst jemand die Runde, soll
   sein Notruf von damals im Protokoll stehen bleiben. Er heisst dort dann
   'Ehemaliger', wie ueberall sonst im Kontor auch. */
ALTER TABLE versand_ausgang
  ADD COLUMN ausloeser_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

/* Wer es bekommen hat, als Namen und durch ', ' getrennt: 'Micha, Basti, Jan'.
   NULL heisst "nicht festgehalten" (alte Zeilen, und der Anmeldelink, der an
   niemanden mit Namen geht).

   Warum die Laenge nicht begrenzt ist: die Runde ist einstellig, und selbst
   bei dreissig Leuten sind das ein paar hundert Zeichen einmal je Vorgang.
   Der Worker kuerzt trotzdem - siehe `empfaengerListe()` dort, das bei einer
   grossen Runde auf "Micha, Basti und 12 weitere" umschaltet. Diese Grenze
   gehoert dorthin und nicht ins Schema: sie ist eine Frage der Lesbarkeit
   einer Protokollzeile, keine der Datenhaltung. */
ALTER TABLE versand_ausgang
  ADD COLUMN empfaenger TEXT;

-- ---------------------------------------------------------------------------
-- Und dasselbe fuer die andere Haelfte des Protokolls.
--
-- `mail_ausgang` braucht nur den Ausloeser: die Empfaenger stehen dort laengst
-- da, eine Zeile je Kopf mit `user_id` (das Gatter gegen die Doppelmail
-- braucht sie so). Das Protokoll buendelt sie ohnehin schon zu einem Vorgang -
-- es holt sich die Namen im selben Griff per JOIN und `group_concat`, ohne
-- dass hier eine zweite, eingefrorene Liste danebenstehen muesste.
--
-- Der Unterschied zu `versand_ausgang` ist also kein Widerspruch, sondern
-- folgt aus dem Zuschnitt der beiden Tabellen: dort EINE Zeile je Vorgang
-- (die Namen muessen hinein), hier EINE je Empfaenger (die Namen sind schon
-- da). Zwei Wege zur selben Auskunft, jeder in seiner Tabelle der billigere.
--
-- Und ein Vorteil, der beim Schreiben nicht geplant war, aber bleibt: die
-- Namen der Mailempfaenger sind damit NICHT eingefroren. Wer sich umbenennt,
-- heisst rueckwirkend auch im Protokoll neu. Fuer `versand_ausgang` waere das
-- ohne Verknuepfungstabelle nicht zu haben - dort steht die eingefrorene
-- Fassung, hier die lebende, und beides ist an seiner Stelle vertretbar.
-- ---------------------------------------------------------------------------
ALTER TABLE mail_ausgang
  ADD COLUMN ausloeser_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
