# beerstock

Wer hat gerade am meisten kaltes Bier — live aus dem Kühlschrank.

Die Seite liegt auf <https://schnix84.github.io/beerstock/>.

## Was man sieht

Eine Kneipentafel, alles mit Kreide angeschrieben. Oben steht der **aktuelle
Erste** — nicht ein bestimmter Kühlschrank, sondern der Siegerplatz, und der
wechselt den Besitzer. Darunter das ganze Feld wie eine Speisekarte: Name,
Strichliste, Anzahl, Temperatur und wann zuletzt gemeldet wurde. Die Seite fasst
von selbst nach, solange man sie ansieht.

Der Bestand steht zweimal da, und das mit Absicht. Die Strichliste nennt die
genaue Zahl — Vierergruppe plus Querstrich, wie der Wirt anschreibt. Das Glas
daneben zeigt denselben Bestand als Füllstand und dazu die Temperatur als
Verhalten: kaltes Bier perlt schnell, trägt eine hohe Krone und beschlägt außen,
pisswarmes steht still und flach da. Die Striche zählt man aus der Nähe, das Glas
liest man von weitem.

Ab 24 Flaschen sind beide am Anschlag und sagen nur noch *voll* — die Liste nennt
die Zahl trotzdem. Vierundzwanzig, weil das ein Kasten ist.

Das erste Wort der Fußzeile ist die Ampel: sechs Stufen von *eiskalt* bis
*pisswarm*, und die Farben sind kein Thermometer, sondern ein Urteil. Die
Farbleiste darunter zeigt mit einer Nadel, wo der Kühlschrank gerade steht.

## Wo wird heute getrunken

Einmal am Tag darf die Flasche gedreht werden. Gezogen wird auf dem Worker, nicht
im Browser — sonst dreht jeder sein eigenes Rad und bekommt seine eigene Antwort.
Die Chance sitzt in der Länge des Bogens am Rand: wer mehr kalt hat, wird öfter
gezogen, gedeckelt bei einem Kasten.

Wen es trifft, der **sagt zu oder ab**. Erst die Zusage macht daraus den Abend —
vorher steht nur, worauf die Flasche zeigt. Eine Absage gibt den Tag sofort wieder
frei, und die Flasche darf erneut gedreht werden; wer abgesagt oder drei Stunden
lang nicht geantwortet hat, ist für heute raus und wird nicht noch einmal gezogen.
Der Bierabend-Tag endet dabei nicht um Mitternacht, sondern zwei Stunden später
in UTC — hier also um vier Uhr morgens, im Winter um drei. Wer um halb zwei dreht,
meint den Abend, der gerade läuft; die Stunde Sommerzeit-Drift ist an dieser Grenze
egal, eine ICU-Abhängigkeit wäre es nicht.

## Termine, Sterne, Gesagtes

Eine Zusage legt den **Termin** gleich mit an — heute 19 Uhr, verschiebbar. Abende,
die aus keiner Ziehung stammen, trägt man von Hand ein: Gastgeber, Tag, Uhrzeit.
Kommende stehen oben, Gewesenes darunter. Abgesagt wird weich: die Zeile bleibt
durchgestrichen stehen, damit die Kommentare darunter ihren Zusammenhang behalten.

Die Liste reicht zwei Wochen zurück, sonst wüchse sie mit jedem Abend, den es je
gab. Alles davor steht in der **Chronik** hinter dem Knopf am Kopf der Sektion:
nach Monaten geordnet, seitenweise nachgeladen, und ein Tap öffnet dasselbe Blatt
wie in der Liste — an einem drei Jahre alten Abend sind Sterne, Kommentare,
Reaktionen und Fotos dieselben. Geblättert wird per Zeiger auf den letzten
gezeigten Abend, nicht per Seitenzahl: kommt einer dazu, verschiebt sich sonst die
ganze Liste, und ein Eintrag erschiene doppelt.

Erreichbar ist über die Zeile **jeder** Abend, auch der abgesagte und der, der erst
kommt — geredet wird über beide ("schade" / "bring Chips mit"), nur bewertet nicht.
Warum das Sternfeld gerade stumm ist, sagt das Blatt selbst; die Regel dafür steht
im Worker und nicht zweimal.

**Bewertet** wird mit Sternen in vier Kategorien — einen *Gastgeber* dauerhaft
(Kaltstellen, Auswahl, Gastfreundschaft, Verlässlichkeit), einen *Abend* einmalig
(Versorgung, Location, Stimmung, Ausklang). Keine Kategorie ist Pflicht, ein
einzelner Tap genügt, und die Gesamtnote wird gerechnet statt extra gefragt: zwei
Zahlen, die auseinanderdriften, sind schlechter als eine. Termin-Noten zählen nicht
auf den Gastgeber ein, sonst zählte ein einziger Abend doppelt. Sich selbst bewertet
niemand.

Dazu **Kommentare** mit einer Antwortebene und Reaktionen (👍 👎 ❤️ 🍺) wie bei
WhatsApp. Die vier liegen hinter einem Knopf und kommen erst auf Tippen heraus; an
der Karte steht nur, was wirklich drangeklebt wurde. Ein Tap auf so eine Reaktion
fragt nicht „auch?", sondern „wer?" — darunter klappen die Namen auf, die sie
gesetzt haben. Zurückgenommen wird über denselben Knopf, mit dem sie kam.
Wer beim Schreiben schon Sterne vergeben hat, trägt sie über seinem Text —
so liest man, worauf sich das Lob bezieht. Es ist der Stand von damals, nicht der von
heute: hebt jemand später seine Note, bleibt die alte Karte, wie sie war. Gelöscht
wird weich, geantwortet nur eine Ebene tief: bei Stufe drei ist die Spalte auf dem
Handy vierzig Pixel breit.

## Von außen

Wer noch nicht mitschreibt, sieht ein Schaufenster: Siegerplatz, Glas und Ampel
stehen offen da — wer gerade führt, mit wie viel und wie kalt. Die Liste darunter
ist angeschrieben, aber nicht zu lesen. Das Rad und die Abende bleiben zu, das
Blatt mit Sternen und Gesagtem erst recht. Am Fuß steht dafür der ganze Weg
hinein, drei Zeilen lang, und das Adressfeld gleich darunter — ohne Knopf davor,
denn wer erst fragen muss, ob er fragen darf, tippt seine Adresse nicht ein.

**Die Tür ist nicht gemalt.** Ohne `Bearer` gibt `/api/leaderboard` nur den
Siegerplatz heraus — ohne Id, ohne Verlauf, ohne Sternschnitt, dazu `los: null`,
`termine: []`, `chronik: 0` und ein `draussen: true`, an dem die Seite erkennt,
dass die Antwort beschnitten ist. `/api/bewertungen` und `/api/chronik` antworten
dann 401. Verwischt wird deshalb ein *gezeichneter Platzhalter* und keine echte
Zeile: was nicht da ist, kann auch niemand scharfstellen.

Die Seite glaubt dabei dem Worker und nicht ihrem eigenen Speicher. Ein Token,
das der Worker nicht mehr kennt, liegt im Browser noch — ohne `draussen` zeichnete
sie das Bild eines Angemeldeten um eine Antwort herum, die keine ist.

Weil die Bestenliste jetzt je nach `Authorization` anders ausfällt, trägt sie
`Cache-Control: private` und `Vary: Origin, Authorization`. Mit dem alten
`public` hätte ein gemeinsamer Speicher die Antwort eines Angemeldeten an den
nächsten Fremden weiterreichen können.

Drei Nähte bleiben offen, mit Absicht:

- Der **Siegerplatz** nennt Namen, Bestand und Temperatur des Führenden. Das ist
  der Köder, ohne den niemand mitmacht.
- Die **Fotos** liegen weiter unter der öffentlichen R2-Adresse (siehe
  `BILDER_URL` in der `wrangler.jsonc`) — wer eine kennt, sieht sie ohne
  Anmeldung. Die Schlüssel sind zufällige UUIDs, also nicht zu erraten.
- `/api/strom` steht jedem offen. Über die Leitung reisen nur Marken, also
  bestenfalls die Beobachtung, *dass* gerade etwas passiert ist.

## Wie man mitmacht

Mailadresse eintippen, Link in der Mail klicken, drin. Beim ersten Mal fragt die
Seite noch, wie man in der Liste heißen soll — das war's. Kein Passwort, also
auch keines zu vergessen, und nichts zu speichern, was gestohlen werden könnte.

Derselbe Weg funktioniert auf jedem weiteren Gerät und beliebig oft. Wer sein
Handy wechselt, den Browserspeicher leert oder von Safari nach sieben Tagen
Untätigkeit ausgeräumt wird, tippt einfach wieder seine Adresse ein. Handy und
Laptop können gleichzeitig angemeldet sein.

**Jedes Einlösen legt dabei ein neues Token an — auch im selben Browser.** Alte
laufen nicht ab und verschwinden nicht von selbst; nach ein paar Wochen stehen
in „mein Deckel" mehr Geräte, als je benutzt wurden, und die überzähligen sind
die Reste geleerter Browserspeicher. Die Zahl dort ist deshalb höher als die
der benutzten Geräte; wer aufräumen will, meldet **alle** ab und kommt einmal
neu. Eine Liste der einzelnen Token stand hier kurzzeitig und ist wieder weg —
sie erklärte die Zahl, machte aber aus der unwichtigsten Auskunft des Blattes
sein größtes Feld.

Wann ein Token zuletzt benutzt wurde, steht in `tokens.zuletzt`. Geschrieben
wird es beim Abruf, aber höchstens einmal je Stunde — die offenen Seiten fragen
im Minutentakt nach, und ein Schreibvorgang je Abruf wären Tausende am Tag für
eine Angabe, die stundengenau genügt. Angezeigt wird sie nirgends; sie ist da,
damit sich per SQL beantworten lässt, welcher Zugang noch lebt.

Gemeldete Werte sind **ungeprüft**. Die einzige Ausnahme trägt die Marke
*gemessen*: dieser Bestand kommt aus einer Kühlschrank-Inventur in Home Assistant
(Kassenbon × Foto × KI), die Temperatur von einem Sensor im Kühlschrank.

## Post vom Wirt, mein Deckel, das Kontor

Wer eine Adresse hinterlegt hat, bekommt Mail — je Anlass abwählbar:

| Art | wann | Vorgabe |
|---|---|---|
| `gewonnen` | die Flasche hat einen getroffen | an |
| `termin_neu` | ein Abend steht fest | an |
| `termin_aendert` | ein Abend verschiebt sich, wird umbenannt oder fällt aus | an |
| `erinnerung` | am Morgen des Abendtags (der einzige Cron im Dienst, 09:00 UTC) | an |
| `echo` | jemand antwortet auf einen Beitrag oder gibt Sterne | **aus** |
| `rundmail` | gelegentlich, vom Wirt | an |

Zwei Regeln gelten für alle: Gesperrte und Entfernte bekommen gar keine (der
gemessene Melder hat kein Postfach und fällt damit von selbst heraus), und der
**Ein-Klick-Abmeldelink** in jeder Fußzeile schlägt jede Einzelwahl.

Der **Auslöser** bekommt bei `echo` nichts — wer selbst schreibt, weiß es schon.
Bei den beiden Terminarten bekommt er sehr wohl eine, nur mit anderem Text
(*„Für deinen Kalender"* statt einer Ankündigung): diese Mails tragen einen
Anhang, und ausgerechnet der Gastgeber hätte den Abend sonst in keinem Kalender
stehen. Gegen die doppelte Mail nach einer
abgebrochenen Verbindung steht ein `UNIQUE` auf `mail_ausgang`.

An `termin_neu` und `termin_aendert` hängt ein **Kalendereintrag** (`.ics`). Er
trägt eine feste `UID` (`termin-<id>@beerstock`) und eine steigende `SEQUENCE`
(Spalte `termine.fassung`) — damit *ersetzt* eine Verschiebung den vorhandenen
Eintrag, statt einen zweiten daneben zu legen, und eine Absage räumt ihn per
`METHOD:CANCEL` weg. Bewusst `METHOD:PUBLISH` und nicht `REQUEST`: `REQUEST` ist
eine Einladung und zeigt im Postfach Zusagen-/Absagen-Knöpfe, deren Antwort an
ein Postfach ginge, das niemand liest. Zugesagt wird auf der Tafel. Die
Erinnerung am Abendtag trägt keinen Anhang — der Eintrag steht dann längst.

Zwei Links kommen ohne Anmeldung aus: das Abmelden und die Antwort des
Gewinners. Beide tragen eine **HMAC-Signatur statt einer Zeile in der Datenbank**
— sie steht nirgends, sie wird gerechnet, und ein Rundumschlag ist ein neues
`MAIL_GEHEIM`. Beide führen auf die Seite und tun dort erst etwas, wenn man
klickt: Mailscanner laden Links vor, und ein `GET`, das zusagt, wäre binnen einer
Woche einmal von einem Virenscanner beantwortet worden.

**Mein Deckel** (Flyout auf der Tafel) ist die Selbstverwaltung: Name ändern,
Adresse wechseln, die sechs Schalter, alle Geräte abmelden. Der Adresswechsel ist
zweistufig — der Link geht an die neue Adresse, die alte bekommt eine Warnung und
gilt weiter, bis dort geklickt wurde.

**Das Kontor** (`admin.html`) gehört der Rolle `admin`: sperren, entsperren,
Rolle tauschen, entfernen, sechs Grafiken, Rundmail, Protokoll. Gleiche Herkunft
wie die Tafel, also dasselbe Token — kein zweiter Login und damit auch kein
zweiter Angriffsweg. Wer der erste Admin ist, sagt das Secret `ADMIN_MAIL`: wer
sich mit dieser Adresse anmeldet, wird beim Einlösen des Links zum Admin. Das ist
selbstheilend, sonst wäre ein Kontor ohne Admin nur noch per SQL zu öffnen.

Entfernt wird **weich**: Adresse, Name und Token verschwinden, die Beiträge
bleiben als *Ehemaliger* stehen. Hart geht nicht — `kommentare.autor_id` hat
`ON DELETE CASCADE` und risse ganze Threads mit, `termine.gastgeber_id` und
`los.user_id` haben keine und hinterließen Waisen. Gesperrte bleiben in der Liste
stehen (mit der stillen Marke *ruht*) und fallen aus dem Rad; sie dürfen weiter
lesen, aber nichts mehr schreiben, und bekommen auch keinen frischen Magic Link
mehr. Der gemessene Melder ist sperrbar, aber nicht entfernbar: das risse die
Anbindung der Wohnung ab.

## Aufbau

```
index.html           eine einzelne, in sich geschlossene Seite ohne externe Ressourcen
admin.html           das Kontor: Nutzerverwaltung, Statistik, Rundmail — nur fuer Admins
worker/              Cloudflare Worker + D1 + R2: Registrierung, Meldungen, Bestenliste
worker/src/tafel.js  Durable Object: verteilt an alle offenen Seiten, was sich geändert hat
worker/migrations/   das Schema, eine Datei je Schritt — die Reihenfolge ist die Geschichte
```

Die Seite ist statisch und fragt nur. Geschrieben wird ausschließlich über den
Worker; die Wohnung selbst ist von außen nicht erreichbar und ruft dort an, statt
angerufen zu werden.

Die Wohnung meldet ihren Bestand über dieselbe Route wie jeder andere
(`POST /api/report`) und steht in derselben Liste. Es gibt keinen zweiten Weg
mehr: bis August 2026 schrieb Home Assistant zusätzlich ein `status.json` über
die GitHub-Contents-API in dieses Repo, als Rückfallebene für den Fall, dass der
Worker nicht antwortet. Das ist abgeschafft. Jede Meldung war ein Commit, und
dessen Zeitstempel ist öffentlich und minutengenau — die Datei rundete den
Zeitpunkt des letzten Kühlschrankfotos absichtlich auf die volle Stunde, die
git-History daneben gab ihn dann doch preis, dazu den Verlauf des Bestands.
Antwortet der Worker nicht, zeigt der Deckel jetzt nichts.

### Die Seite bleibt von selbst aktuell

Wer die Seite offen hat, sieht neue Meldungen, Ziehungen, Kommentare, Sterne und
Reaktionen **ohne Reload** — auch bei geöffnetem Kommentarblatt und offener
Chronik. Dahinter steht
eine WebSocket (`GET /api/strom`) zu einem einzigen Durable Object, an das jede
Schreibroute meldet, was sie geändert hat.

Über die Leitung reisen dabei **nur Marken, keine Daten**: `tafel` (Liste, Rad,
Termine) oder ein Ziel wie `user:5`. Was dahintersteckt, holt die Seite über
dieselben GET-Routen wie beim ersten Aufbau. Damit gibt es keine zweite Fassung
der Antwortlogik, die auseinanderlaufen könnte, und niemand kann über die Leitung
etwas mitlesen, was er nicht ohnehin abrufen dürfte — geprüft wird beim Abruf.

Drei Dinge, die dazugehören:

- **Die Leitung ersetzt das Nachfragen, nicht das Laden.** Ein Zeitgeber fasst
  weiter nach, solange jemand hinsieht: alle drei Minuten mit stehender Leitung,
  jede Minute ohne sie (dann pollt auch das offene Blatt mit). Eine WebSocket geht
  verloren, ohne dass es jemand merkt — eine Seite, die dann nichts mehr täte, sähe
  aus wie eingefroren.
- **Der Absender lädt nicht doppelt.** Jeder Schreibvorgang trägt eine zufällige
  Tab-Kennung als `X-Tab` mit, die an der verteilten Meldung hängt; der eigene
  Tab überspringt sie, seine Antwort war früher da.
- **Nichts wird unter den Fingern weggezogen.** Gezeichnet wird nur, wenn die
  Antwort sich wirklich geändert hat; während einer Radanimation oder eines
  eigenen Schreibvorgangs wird der Anstoß gemerkt und danach nachgeholt. Beim
  Neuzeichnen des Blattes bleiben Scrollstand und getippter Text stehen.
- **Auch die Uhr läuft mit.** Ein Abend fängt an und hört auf, ohne dass jemand
  etwas schreibt — davon käme also nie eine Marke. Statt eines Tickers je
  Sekunde stellt sich ein einziger Wecker auf den nächsten Zeitpunkt, an dem
  sich überhaupt etwas ändern kann: Anfang und Ende jedes Abends, dazu die Frist
  der offenen Ziehung. Dort zeichnet die Seite die Terminliste neu und fragt
  einmal nach — an der Frist ist das mehr als Kosmetik, das Los ist dann
  verfallen und das Rad wieder frei. Dazwischen schläft sie, der Wechsel sitzt
  trotzdem auf der Sekunde. Was im Schlaf des Geräts liegen bleibt, holen der
  Blick auf die Uhr beim Aufwachen und das 20-Sekunden-Netz nach.

### API

| Route | Was |
|---|---|
| `POST /api/anmelden` | `{email}` → schickt einen Magic Link |
| `POST /api/magic` | `{token}` aus dem Link → Geräte-Token |
| `POST /api/name` | Name für die Liste setzen |
| `GET /api/me` 🔒 | wem das Token gehört: Name, Adresse, Rolle, Sperre, Mailschalter, Gerätezahl |
| `POST /api/report` | `{biere, temperatur}` mit `Bearer`-Token |
| `POST /api/abmelden` | wirft nur dieses eine Gerät raus |
| `POST /api/geraete/alle-abmelden` 🔒 | wirft **alle** raus, auch dieses — das verlorene Handy |
| `POST /api/einstellungen` 🔒 | `{mail:{art:bool}}` und/oder `{stumm:bool}`; unbekannte Arten → 400 |
| `POST /api/mail/aendern` 🔒 | neue Adresse; Link an die **neue**, Warnung an die **alte**, bis dahin gilt die alte |
| `POST /api/mail/stumm` | `{id, sig}` aus dem Ein-Klick-Abmeldelink — ohne Anmeldung, per HMAC |
| `POST /api/drehen` | die Flasche drehen; ein zweiter Ruf liefert dasselbe Los |
| `POST /api/los/antwort` | `{antwort:'ja'\|'nein', grund?, beginnt_am?, endet_am?}` — nur der Gezogene, per Token **oder** mit `{los, t}` aus der Gewinner-Mail |
| `POST /api/termin` | `{gastgeber, beginnt_am, endet_am?, titel?}` → ein Abend von Hand |
| `POST /api/termin/aendern` | verschieben, umbenennen, absagen; ohne `endet_am` wandert das Ende beim Verschieben mit |
| `POST /api/bewerten` | `{ziel_art, ziel_id, sterne{}, text?, bild?}` — überschreibt |
| `GET /api/bewertungen` 🔒 | `?ziel=user:5` — Schnitte, eigene Abgabe, Kommentarbaum |
| `POST /api/bild` | rohe Bytes im Rumpf, kein JSON → `{key, bild}`; der `key` gehört an den nächsten Kommentar |
| `POST /api/kommentar` | `{ziel_art, ziel_id, text?, bild?, antwort_auf?}` — eins von beiden muss da sein |
| `POST /api/kommentar/aendern` | `{id, text}` oder `{id, loeschen:true}` |
| `POST /api/reaktion` | `{kommentar_id, art}` — Schalter, derselbe Druck nimmt zurück; zurück kommen `anzahl` und die `namen` |
| `GET /api/chronik` 🔒 | `?vor=…&vor_id=…&anzahl=…` — gewesene Abende, seitenweise |
| `GET /api/leaderboard` | Rangliste, Bestmarke, 30 Tage Verlauf, Ziehung des Tages — ohne Token nur der Siegerplatz |
| `GET /api/strom` | WebSocket; verteilt Marken wie `{"marken":["tafel","user:5"]}` |
| `GET /api/admin/nutzer` 🔒 | die ganze Runde mit Adressen und Zahlen — nur Admin, sonst 403 |
| `POST /api/admin/nutzer` 🔒 | `{id, aktion:'sperren'\|'entsperren'\|'rolle'\|'entfernen', grund?}` — nur Admin |
| `GET /api/admin/statistik` 🔒 | die Zahlenreihen hinter den sechs Grafiken — nur Admin |
| `POST /api/admin/rundmail` 🔒 | `{betreff, text}` an alle, die sie wollen — nur Admin |
| `GET /api/admin/protokoll` 🔒 | die letzten 50 Adminhandlungen — nur Admin |
| `GET /api/health` | Bereitschaft: Datenbank, Mailversand, Bilderablage, Neu-Meldung, Verteiler, `ADMIN_MAIL`, `MAIL_GEHEIM` |

🔒 heißt: braucht den `Bearer`-Token, sonst 401. Für die `POST`-Routen gilt das
ohnehin — sie schreiben; die beiden Ausnahmen sind `/api/anmelden` und
`/api/magic`, denn das ist ja der Weg zum Token. `GET /api/leaderboard` antwortet
auch ohne, dann aber nur mit dem Siegerplatz (siehe *Von außen*).

Grenzen: 0–999 Biere, −30…+30 °C, eine Meldung pro Minute und Nutzer, ein
Absagegrund von höchstens 120 Zeichen. Ausgelost wird ab zwei Meldern mit etwas
Kaltem; nach einer Absage genügt einer, sonst sperrte ein einziges Nein den Abend.
Termine: höchstens 3 je Nutzer und Tag, 90 Tage im Voraus. Kommentare: 400 Zeichen,
30 am Tag, 200 je Ziel, 10 Sekunden Abstand — dieselbe Bremse wie bei den Meldungen,
gegen den Freund, der zehnmal drückt. Sie gelten auch für den Text neben den Sternen,
der ja derselbe Kommentar wird. Fotos: 2 MB, JPEG/PNG/WebP, ebenfalls 30 am Tag und
10 Sekunden Abstand — eine eigene Bremse, weil das Hochladen *vor* dem Abschicken
läuft und die Kommentarsperre hier noch nichts aufhält. Verkleinert wird schon im
Browser (lange Kante 1600 px, JPEG 0.8), aus 4 MB Handyfoto werden ~250 kB; der
Deckel steht trotzdem, denn der Worker redet nicht nur mit unserem Browser.
Weil das Hochladen vor dem Abschicken läuft, bleibt liegen, wer es sich anders
überlegt: solche Bilder ohne Kommentar räumt der tägliche Cron weg, aber erst
nach einem Tag — solange darf das Formular offen stehen bleiben.
Zeiten reisen als ISO-8601 mit Zone, und der Worker rechnet in den ANTWORTEN nie
um — die Seite kennt die Ortszeit ihres Betrachters, er nur die der Wohnung. In
den **Mails** tut er es doch, denn dort steht kein Browser dazwischen: die
Laufzeit hat volles ICU einschließlich Zeitzonen (gemessen 2026-08-03, Sommer-
und Winterzeit stimmen). Eine ältere Anmerkung im Quelltext behauptet das
Gegenteil; sie stammt aus einer Zeit, in der es so war.

Nutzerverwaltung: 3 Adresswechsel je Nutzer und Tag (dazu dieselben Bremsen wie
beim Magic Link, es ist dieselbe Tabelle), Sperrgrund 120 Zeichen, Rundmail 4000
Zeichen bei 120 im Betreff und höchstens eine je Stunde.

Magic Links gelten 15 Minuten und genau einmal, höchstens 3 pro Adresse und Stunde und 30
insgesamt — sonst wäre der Posteingang ein Versandknopf im Netz. CORS
ausschließlich für diese Seite. Geräte-Token und Magic Links liegen in der
Datenbank nur als SHA-256 — ein Abzug verrät, wer wie viel Bier hat, macht aber
niemanden handlungsfähig.

Der Link reist im Adressfragment (`#anmelden=…`), nicht als Suchparameter: ein
Fragment wird nie an einen Server geschickt und steht damit in keinem
Zugriffsprotokoll. Die Seite räumt es sofort nach dem Einlösen aus der Adresszeile.

Mails gehen über [AgentMail](https://agentmail.to) raus — reine HTTP-API, kein
SMTP. Der Schlüssel liegt als Worker-Secret `AGENTMAIL_KEY`.

Über dieselbe Leitung erfährt der Gastgeber von jedem Neuen: eine Mail an
`MELDE_AN`, sobald sich einer zum ersten Mal einen Namen gibt — mit Name,
Adresse und dem wievielten Melder. Genau einmal je Nutzer; wer sich später
umbenennt, löst nichts aus. Auch `MELDE_AN` ist ein Secret, hier aber nur, damit
die Adresse nicht im offenen Repo steht; fehlt sie, bleibt die Meldung aus. Sie
geht nach der Antwort raus (`waitUntil`) und ist in jedem Fehlerfall stumm — an
einer Meldung, die nicht ankommt, soll keine Anmeldung scheitern.

Meldungen werden nie überschrieben: der aktuelle Stand ist die jüngste Zeile je
Nutzer, der Verlauf fällt dabei von selbst an.

### Deployen

**Erst das Schema, dann der Worker** — die Reihenfolge ist zwingend. Ein Worker,
der eine Spalte abfragt, die es noch nicht gibt, macht jeden Aufruf der Bestenliste
zum 500er.

```bash
cd worker
npx wrangler d1 migrations apply beerstock --remote  # Schema
npx wrangler deploy                                  # Worker
```

Einmalig dazu die Secrets, sonst geht keine Mail raus und keine Meldung ein:

```bash
npx wrangler secret put AGENTMAIL_KEY   # der Schluessel fuer den Versand
npx wrangler secret put MELDE_AN        # wer von jedem Neuen erfaehrt
npx wrangler secret put ADMIN_MAIL      # wer sich damit anmeldet, wird Admin
npx wrangler secret put MAIL_GEHEIM     # zufaellig, 32+ Zeichen, fuer die HMAC-Links
```

`GET /api/health` sagt zu jedem, ob er anliegt — nie seinen Wert. Ohne
`ADMIN_MAIL` kommt niemand ins Kontor, ohne `MAIL_GEHEIM` trägt keine Mail einen
Abmeldelink; beides sähe von außen wie ein Fehler im Browser aus.

Zum Prüfen ohne echten Versand: eine `.dev.vars` mit `MAIL_ATTRAPPE=1` neben die
`wrangler.jsonc` legen (gitignored). `schickeMail()` schreibt dann in die Konsole,
statt AgentMail anzurufen — sonst ist jeder Testlauf eine echte Mail an eine echte
Adresse, und beim Durchspielen des Verteilers sind das schnell sechs auf einen
Schlag.

Ebenfalls einmalig der Eimer für die Fotos — und der ist zweiteilig:

```bash
npx wrangler r2 bucket create beerstock-bilder --location weur
```

Dazu im Dashboard unter *R2 > beerstock-bilder > Settings* die **Public
Development URL** einschalten und die entstandene `r2.dev`-Adresse als
`BILDER_URL` in die `wrangler.jsonc` eintragen, ohne Schrägstrich am Ende. Ohne
den Eimer antwortet `POST /api/bild` mit 503; steht er, fehlt aber die Adresse,
kommt jedes hochgeladene Bild als `bild: null` heraus und sieht von außen wie ein
Fehler im Browser aus. `GET /api/health` sagt unter `bilder`, an welchem von
beidem es liegt. Warum die öffentliche Adresse und keine geschützte Worker-Route:
`<img>` schickt keinen `Authorization`-Kopf (siehe *Von außen*).

Der Verteiler braucht kein eigenes Kommando: `Tafel` steht als Durable Object in
`wrangler.jsonc` und entsteht beim ersten Deploy mit. Er speichert nichts —
`new_sqlite_classes` steht dort trotzdem, weil nur SQLite-gestützte Klassen im
kostenlosen Tarif laufen.

Die Seite selbst liegt auf GitHub Pages — ein Push auf `main` genügt. Sie darf
hinterherkommen: die alten Felder bleiben in den Antworten erhalten. Umgekehrt
auch — eine Seite, die `/api/strom` noch nicht findet, fällt auf ihren
Zeitgeber zurück und arbeitet weiter wie vorher.

Direkt nach `wrangler deploy` antwortet die Edge kurz noch mit der alten Fassung.
Vor der Fehlersuche also schlicht eine halbe Minute später noch einmal abfragen.
