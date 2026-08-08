-- ===========================================================================
-- Schema 25: Was rausging, zaehlbar - auch das, was bisher niemand mitschrieb.
--
-- Zwei Luecken hatte das Kontor. Die eine war der Push: `stosse()` schickte
-- und vergass, es gab keine einzige Zeile darueber (der Kommentar dort nannte
-- eine Buchhaltung je Empfaenger "eine Buchhaltung ueber Rauch" - das galt
-- gegen die Doppel-Sperre, nicht gegen das Zaehlen). Die andere waren fuenf
-- Mails, die an `benachrichtige()` vorbeigehen und darum nie in
-- `mail_ausgang` landeten: der Anmeldelink, die beiden Haelften des
-- Adresswechsels, die Meldung an den Betreiber und die Testmail. Zusammen
-- waren das die einzigen Mails, die das Kontor nicht kannte - und der
-- Anmeldelink ist die haeufigste von allen.
--
-- WARUM EINE NEUE TABELLE UND NICHT `mail_ausgang` ERWEITERT. Naheliegend
-- waere gewesen, `user_id` dort NULL zuzulassen (der Anmeldelink geht an eine
-- Adresse, die noch kein Nutzer ist - die Zeile in `users` entsteht erst beim
-- Einloesen; die Betreibermeldung geht an MELDE_AN und damit an gar keinen).
-- SQLite kann ein NOT NULL aber nicht nachtraeglich fallen lassen: das waere
-- der Tabellentausch aus 0002/0014, samt `PRAGMA foreign_keys = OFF`, und
-- zwar ausgerechnet an der Tabelle, die den UNIQUE-Index `mail_einmal` traegt.
-- Diesen Index neu zu bauen ist die eine Stelle, an der ein Fehler dazu
-- fuehrt, dass Termin-Mails wieder doppelt rausgehen. Fuer eine Handvoll
-- Zeilen im Monat ist das der falsche Preis. `mail_ausgang` bleibt darum
-- unangetastet.
--
-- ZWEI WEGE IN EINER TABELLE, nicht zwei Tabellen. `weg` trennt Post von
-- Klopfen. Sie unterscheiden sich in nichts, was eine eigene Tabelle
-- rechtfertigte - dieselben Spalten, dieselbe Frage ("wie viele, wozu,
-- wann"), dieselbe Abfrage im Kontor. Zwei Tabellen waeren zwei Stellen, die
-- bei der naechsten Aenderung auseinanderlaufen.
--
-- KEINE `user_id` UND KEINE ADRESSE, und das ist Absicht, nicht Sparsamkeit.
-- Die Zeile beantwortet "wie viele, wozu" - genau das, wonach gefragt war -
-- und nicht "an wen". Damit steht im Kontor kuenftig, DASS um 14:03 jemand
-- einen Anmeldelink angefordert hat, aber nicht, unter welcher Adresse. Wer
-- hier je eine Adressspalte nachruestet, baut ein sichtbares Verzeichnis der
-- Anmeldeversuche von Leuten, die nie beigetreten sind - dieselbe Sorte Spur,
-- wegen der 0013 den Notruf vergessen laesst und 0017 nur "wie oft" zaehlt
-- und nie "wann" oder "wo".
--
-- EINE ZEILE JE VORGANG, nicht je Empfaenger. Ein Notruf-Push an sechs
-- Geraete ist EINE Zeile mit `anzahl = 6`. Das ist der ganze Unterschied zu
-- `mail_ausgang`, und er folgt daraus, dass hier keine Doppel-Sperre haengt:
-- die braucht eine Zeile je Empfaenger, ein Zaehler nicht.
--
-- Reines CREATE, kein Tabellentausch - darum kein `PRAGMA foreign_keys = OFF`
-- (siehe den Kopf von 0011, warum das sonst dastehen muesste).
--
-- ZEIT: ueberall UTC, 'YYYY-MM-DD HH:MM:SS', wie im ganzen Schema.
-- ===========================================================================

CREATE TABLE versand_ausgang (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Post oder Klopfen. CHECK statt blossem TEXT: die Statistik teilt danach,
  -- und ein Tippfehler ergaebe eine dritte, stille Kategorie.
  weg      TEXT    NOT NULL CHECK (weg IN ('mail','push')),
  /* Der Anlass, in derselben Schreibweise wie `mail_ausgang.art`, damit die
     Balken im Kontor aus beiden Quellen zusammenpassen: 'notruf', 'gewonnen',
     'termin_neu', 'termin_aendert', 'echo' beim Push - 'anmeldelink',
     'mailwechsel', 'mailwechsel_warnung', 'neuer_melder', 'testmail' bei den
     fuenf Mails, die es hierher verschlagen hat.

     DEUTSCH, auch wo der Code englisch heisst: die Art steht im Protokoll und
     unter den Balken, wo sie ein Mensch liest ("Post -> anmeldelink"). Der
     Magic Link heisst darum hier 'anmeldelink' und nicht 'magic' - er waere
     sonst das einzige englische Wort in einer deutschen Liste.

     Kein CHECK: die Liste waechst mit jeder neuen Meldung, und ein CHECK
     darauf waere ein Tabellentausch je Meldungsart. */
  art      TEXT    NOT NULL,
  /* Woran es hing, wenn es an etwas hing - beim Push die `tag`-Marke
     ('notruf-15'), bei den fuenf Mails NULL. Nur zum Wiedererkennen im
     Protokoll, kein Fremdschluessel: der Notruf dahinter wird geloescht
     (0013), und eine Zeile, die auf ihn zeigte, muesste dann mitgehen. */
  bezug    TEXT,
  -- Wie viele Empfaenger bzw. Geraete angestossen wurden.
  anzahl   INTEGER NOT NULL,
  -- Wie viele davon nicht ankamen. Beim Push: 404/410 vom Dienst, also
  -- abgemeldete Geraete; die Zeile in `push_abos` faellt dabei ohnehin weg.
  kaputt   INTEGER NOT NULL DEFAULT 0,
  erstellt TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Beide Abfragen gehen ueber die Zeit: das Protokoll liest die letzten
-- fuenfzig, die Statistik ein Fenster von 30 bis 90 Tagen.
CREATE INDEX versand_zeit ON versand_ausgang(erstellt DESC);
