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
Der Bierabend-Tag endet dabei nicht um Mitternacht, sondern sechs Stunden später.

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

## Wie man mitmacht

Mailadresse eintippen, Link in der Mail klicken, drin. Beim ersten Mal fragt die
Seite noch, wie man in der Liste heißen soll — das war's. Kein Passwort, also
auch keines zu vergessen, und nichts zu speichern, was gestohlen werden könnte.

Derselbe Weg funktioniert auf jedem weiteren Gerät und beliebig oft. Wer sein
Handy wechselt, den Browserspeicher leert oder von Safari nach sieben Tagen
Untätigkeit ausgeräumt wird, tippt einfach wieder seine Adresse ein. Handy und
Laptop können gleichzeitig angemeldet sein.

Gemeldete Werte sind **ungeprüft**. Die einzige Ausnahme trägt die Marke
*gemessen*: dieser Bestand kommt aus einer Kühlschrank-Inventur in Home Assistant
(Kassenbon × Foto × KI), die Temperatur von einem Sensor im Kühlschrank.

## Aufbau

```
index.html          eine einzelne, in sich geschlossene Seite ohne externe Ressourcen
status.json         der eigene Bestand — Rückfallebene, wenn die API nicht antwortet
worker/             Cloudflare Worker + D1: Registrierung, Meldungen, Bestenliste
worker/src/tafel.js Durable Object: verteilt an alle offenen Seiten, was sich geändert hat
```

Die Seite ist statisch und fragt nur. Geschrieben wird ausschließlich über den
Worker; die Wohnung selbst ist von außen nicht erreichbar und ruft dort an, statt
angerufen zu werden.

`status.json` bleibt, was es war — Anzahl, Temperatur und Zeitpunkt des letzten
Kühlschrankfotos, auf die volle Stunde gerundet. Antwortet die API nicht, zeigt
der Deckel wieder diesen einen Kühlschrank statt einer leeren Tabelle.

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
| `GET /api/me` | wem das Token gehört |
| `POST /api/report` | `{biere, temperatur}` mit `Bearer`-Token |
| `POST /api/abmelden` | wirft nur dieses eine Gerät raus |
| `POST /api/drehen` | die Flasche drehen; ein zweiter Ruf liefert dasselbe Los |
| `POST /api/los/antwort` | `{antwort:'ja'\|'nein', grund?, beginnt_am?, endet_am?}` — nur der Gezogene |
| `POST /api/termin` | `{gastgeber, beginnt_am, endet_am?, titel?}` → ein Abend von Hand |
| `POST /api/termin/aendern` | verschieben, umbenennen, absagen; ohne `endet_am` wandert das Ende beim Verschieben mit |
| `POST /api/bewerten` | `{ziel_art, ziel_id, sterne{}, text?}` — überschreibt |
| `GET /api/bewertungen` | `?ziel=user:5` — Schnitte, eigene Abgabe, Kommentarbaum |
| `POST /api/kommentar` | `{ziel_art, ziel_id, text, antwort_auf?}` |
| `POST /api/kommentar/aendern` | `{id, text}` oder `{id, loeschen:true}` |
| `POST /api/reaktion` | `{kommentar_id, art}` — Schalter, derselbe Druck nimmt zurück; zurück kommen `anzahl` und die `namen` |
| `GET /api/chronik` | `?vor=…&vor_id=…&anzahl=…` — gewesene Abende, seitenweise |
| `GET /api/leaderboard` | Rangliste, Bestmarke, 30 Tage Verlauf, Ziehung des Tages |
| `GET /api/strom` | WebSocket; verteilt Marken wie `{"marken":["tafel","user:5"]}` |
| `GET /api/health` | Bereitschaft, inklusive Datenbank, Mailversand und Verteiler |

Grenzen: 0–999 Biere, −30…+30 °C, eine Meldung pro Minute und Nutzer, ein
Absagegrund von höchstens 120 Zeichen. Ausgelost wird ab zwei Meldern mit etwas
Kaltem; nach einer Absage genügt einer, sonst sperrte ein einziges Nein den Abend.
Termine: höchstens 3 je Nutzer und Tag, 90 Tage im Voraus. Kommentare: 400 Zeichen,
30 am Tag, 200 je Ziel, 10 Sekunden Abstand — dieselbe Bremse wie bei den Meldungen,
gegen den Freund, der zehnmal drückt. Sie gelten auch für den Text neben den Sternen,
der ja derselbe Kommentar wird. Zeiten reisen als ISO-8601 mit Zone; der Worker
hat kein ICU und rechnet nie um.

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
