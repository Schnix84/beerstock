-- ===========================================================================
-- Schema 27: Wozu ein Token da ist.
--
-- Bisher waren alle Token gleich: eine Zeile je eingeloestem Anmeldelink,
-- ununterscheidbar. Fuer die Wohnung (Home Assistant) war das schon immer
-- eines davon - der Nutzer hat sich am Rechner angemeldet, das Token aus dem
-- `localStorage` per Entwicklerwerkzeug herausgeholt und in `secrets.yaml`
-- getragen (so steht es bis heute im README). Zwei Dinge folgen daraus, und
-- beide sind Fehler:
--
--   1. Das Token in der YAML IST das Token des Browsers. Wer es dort
--      widerruft, meldet damit den Rechner ab, von dem er es geholt hat.
--   2. Es gibt keinen Weg, die Anbindung allein abzuschalten. Der einzige
--      Knopf im Deckel heisst "alle Geraete abmelden" und nimmt Handy,
--      Laptop und Wohnung in einem Griff - ein Vorschlaghammer fuer die
--      Frage "die Wohnung soll nicht mehr melden".
--
-- EINE SPALTE, NULLBAR:
--
--   zweck   NULL = ein Geraet (Browser), 'ha' = der Hausanschluss
--
-- WARUM EINE SPALTE UND KEINE ZWEITE TABELLE. Ein HA-Token ist in allem, was
-- der Worker damit tut, ein gewoehnliches Token: `nutzer()` schlaegt es in
-- derselben Zeile nach, `zuletzt` wird gleich gedrosselt fortgeschrieben, die
-- Sperre trifft es gleich. Der Unterschied ist eine Auskunft ueber seine
-- Herkunft, kein anderer Mechanismus - und eine eigene Tabelle haette
-- `nutzer()` (der heisseste Pfad im Worker, jede einzelne Anfrage) um einen
-- zweiten Lookup verlaengert, damit an genau zwei Stellen ein Wort anders
-- dasteht.
--
-- WARUM NULL UND NICHT 'geraet'. SQLite kann eine Spalte nachtraeglich nicht
-- auf NOT NULL verschaerfen, ein Tabellentausch waere fuer diese Kleinigkeit
-- unverhaeltnismaessig (siehe den Kopf von 0011), und eine Vorgabe
-- 'geraet' wuerde die BESTEHENDEN Zeilen ohnehin nicht anfassen. Also ist
-- NULL der Normalfall und bleibt es: `WHERE zweck IS NULL` heisst Geraet,
-- `WHERE zweck = 'ha'` heisst Hausanschluss. Kein CHECK - ein Wert, den nur
-- der Worker schreibt und der nirgends verzweigt ausser in diesen beiden
-- Klauseln, braucht keinen Waechter in der Datenbank.
--
-- WAS MIT DEN ALTEN ZEILEN PASSIERT: nichts. Sie bleiben NULL und gelten
-- damit als Geraet - auch das eine, unter dem die Wohnung heute meldet. Das
-- ist hier bewusst NICHT geraten: dieses Token laesst sich von aussen nicht
-- an seinem Aussehen erkennen (gespeichert ist nur der Hash), sondern nur an
-- `erstellt` und `zuletzt`, und welche Zeile gemeint ist, weiss der Betreiber
-- der Instanz, nicht diese Datei. Wer seine Anbindung mitnehmen will, setzt
-- die Marke von Hand:
--
--   UPDATE tokens SET zweck = 'ha' WHERE token_hash = '<der richtige Hash>';
--
-- Wer das nicht tut, verliert nichts: die Wohnung meldet weiter wie bisher,
-- sie taucht auf der neuen Seite nur nicht auf. Ein Migrationsskript, das die
-- Zeile selbst sucht, waere eine Vermutung ueber fremde Instanzen - und die
-- falsche Zeile zu markieren hiesse, jemandem seinen Browser als
-- Hausanschluss auszuweisen und ihn per "widerrufen" auszusperren.
--
-- ZEIT: unveraendert UTC, 'YYYY-MM-DD HH:MM:SS'.
-- ===========================================================================

/* Reines ALTER TABLE ADD COLUMN - kein Tabellentausch, also auch kein
   `PRAGMA foreign_keys = OFF`. */
ALTER TABLE tokens ADD COLUMN zweck TEXT;

/* Der Index traegt genau eine Frage: "hat dieser Nutzer einen Hausanschluss,
   und seit wann". Sie wird bei JEDEM `GET /api/me` gestellt, also auf dem
   Weg, den jede offene Seite im Minutentakt geht.

   TEILINDEX auf `zweck = 'ha'`: die Bedingung schliesst die ueberwaeltigende
   Mehrheit der Zeilen aus, und ein voller Index ueber eine Spalte, die fast
   ueberall NULL ist, waere ein zweites Verzeichnis des ganzen Bestands fuer
   eine Handvoll Treffer. `tokens_user` bleibt daneben stehen - der beantwortet
   weiter "alle Token dieses Nutzers". */
CREATE INDEX tokens_ha ON tokens(user_id) WHERE zweck = 'ha';
