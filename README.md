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
| `GET /api/leaderboard` | Rangliste, Bestmarke, 30 Tage Verlauf |
| `GET /api/health` | Bereitschaft, inklusive Datenbank und Mailversand |

Grenzen: 0–999 Biere, −30…+30 °C, eine Meldung pro Minute und Nutzer. Magic Links
gelten 15 Minuten und genau einmal, höchstens 3 pro Adresse und Stunde und 30
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

```bash
cd worker
npx wrangler deploy                                  # Worker
npx wrangler d1 migrations apply beerstock --remote  # Schema
```

Die Seite selbst liegt auf GitHub Pages — ein Push auf `main` genügt.
