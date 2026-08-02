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

**Bewertet** wird mit Sternen in vier Kategorien — einen *Gastgeber* dauerhaft
(Kaltstellen, Auswahl, Gastfreundschaft, Verlässlichkeit), einen *Abend* einmalig
(Versorgung, Location, Stimmung, Ausklang). Keine Kategorie ist Pflicht, ein
einzelner Tap genügt, und die Gesamtnote wird gerechnet statt extra gefragt: zwei
Zahlen, die auseinanderdriften, sind schlechter als eine. Termin-Noten zählen nicht
auf den Gastgeber ein, sonst zählte ein einziger Abend doppelt. Sich selbst bewertet
niemand.

Dazu **Kommentare** mit einer Antwortebene und Reaktionen (👍 👎 ❤️ 🍺) wie bei
WhatsApp. Wer beim Schreiben schon Sterne vergeben hat, trägt sie über seinem Text —
so liest man, worauf sich das Lob bezieht. Gelöscht wird weich, geantwortet nur eine
Ebene tief: bei Stufe drei ist die Spalte auf dem Handy vierzig Pixel breit.

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
index.html      eine einzelne, in sich geschlossene Seite ohne externe Ressourcen
status.json     der eigene Bestand — Rückfallebene, wenn die API nicht antwortet
worker/         Cloudflare Worker + D1: Registrierung, Meldungen, Bestenliste
```

Die Seite ist statisch und fragt nur. Geschrieben wird ausschließlich über den
Worker; die Wohnung selbst ist von außen nicht erreichbar und ruft dort an, statt
angerufen zu werden.

`status.json` bleibt, was es war — Anzahl, Temperatur und Zeitpunkt des letzten
Kühlschrankfotos, auf die volle Stunde gerundet. Antwortet die API nicht, zeigt
der Deckel wieder diesen einen Kühlschrank statt einer leeren Tabelle.

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
| `POST /api/los/antwort` | `{antwort:'ja'\|'nein', grund?, beginnt_am?}` — nur der Gezogene |
| `POST /api/termin` | `{gastgeber, beginnt_am, titel?}` → ein Abend von Hand |
| `POST /api/termin/aendern` | verschieben, umbenennen, absagen |
| `POST /api/bewerten` | `{ziel_art, ziel_id, sterne{}, text?}` — überschreibt |
| `GET /api/bewertungen` | `?ziel=user:5` — Schnitte, eigene Abgabe, Kommentarbaum |
| `POST /api/kommentar` | `{ziel_art, ziel_id, text, antwort_auf?}` |
| `POST /api/kommentar/aendern` | `{id, text}` oder `{id, loeschen:true}` |
| `POST /api/reaktion` | `{kommentar_id, art}` — Schalter, derselbe Druck nimmt zurück |
| `GET /api/leaderboard` | Rangliste, Bestmarke, 30 Tage Verlauf, Ziehung des Tages |
| `GET /api/health` | Bereitschaft, inklusive Datenbank und Mailversand |

Grenzen: 0–999 Biere, −30…+30 °C, eine Meldung pro Minute und Nutzer, ein
Absagegrund von höchstens 120 Zeichen. Ausgelost wird ab zwei Meldern mit etwas
Kaltem; nach einer Absage genügt einer, sonst sperrte ein einziges Nein den Abend.
Termine: höchstens 3 je Nutzer und Tag, 90 Tage im Voraus. Kommentare: 400 Zeichen,
30 am Tag, 200 je Ziel, 10 Sekunden Abstand — dieselbe Bremse wie bei den Meldungen,
gegen den Freund, der zehnmal drückt. Zeiten reisen als ISO-8601 mit Zone; der Worker
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

Die Seite selbst liegt auf GitHub Pages — ein Push auf `main` genügt. Sie darf
hinterherkommen: die alten Felder bleiben in den Antworten erhalten.

Direkt nach `wrangler deploy` antwortet die Edge kurz noch mit der alten Fassung.
Vor der Fehlersuche also schlicht eine halbe Minute später noch einmal abfragen.
