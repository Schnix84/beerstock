# beerstock

Wer hat gerade am meisten kaltes Bier — live aus dem Kühlschrank.

Die Seite liegt auf <https://schnix84.github.io/beerstock/>.

## Was man sieht

Ein Bierdeckel, darunter der Rechnungsblock des Wirts. Der Deckel gehört dem
**aktuellen Ersten**, nicht einem bestimmten Kühlschrank — er ist der Siegerplatz
und wechselt den Besitzer. Darunter steht das ganze Feld: Name, Strichliste,
Anzahl, Temperatur und wann zuletzt gemeldet wurde.

Das Glas zeigt den Bestand als Füllstand und die Temperatur als Verhalten:
kaltes Bier perlt schnell, trägt eine hohe Krone und beschlägt außen, pisswarmes
steht still und flach da. Die Strichliste daneben zeigt die genaue Zahl. Ab 24
Flaschen sind beide am Anschlag und sagen nur noch *voll* — die Liste nennt die
Zahl trotzdem.

## Wie man mitmacht

Mit einem Einladungscode. Man wählt einen Namen, bekommt ein Token in den Browser
gelegt und kann von da an melden, wie viele kalte Biere bei wie viel Grad stehen.
Kein Passwort, keine Mailadresse — es gibt nichts zu speichern, was wehtun würde,
wenn es abhandenkommt.

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
| `POST /api/register` | `{code, name}` → `{token}` |
| `GET /api/me` | wem das Token gehört |
| `POST /api/report` | `{biere, temperatur}` mit `Bearer`-Token |
| `GET /api/leaderboard` | Rangliste, Bestmarke, 30 Tage Verlauf |
| `GET /api/health` | Bereitschaft, inklusive Datenbank |

Grenzen: 0–999 Biere, −30…+30 °C, eine Meldung pro Minute und Nutzer. CORS
ausschließlich für diese Seite. Token und Einladungscodes liegen in der Datenbank
nur als SHA-256 — ein Abzug verrät, wer wie viel Bier hat, macht aber niemanden
handlungsfähig.

Meldungen werden nie überschrieben: der aktuelle Stand ist die jüngste Zeile je
Nutzer, der Verlauf fällt dabei von selbst an.

### Deployen

```bash
cd worker
npx wrangler deploy                                  # Worker
npx wrangler d1 migrations apply beerstock --remote  # Schema
```

Die Seite selbst liegt auf GitHub Pages — ein Push auf `main` genügt.
