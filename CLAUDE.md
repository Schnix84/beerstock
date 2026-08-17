# beerstock

Die öffentliche Bierseite: <https://schnix84.github.io/beerstock/>. Wer kalt hat, trägt es
ein; einmal am Tag lost ein Flaschendrehen aus, wo getrunken wird.

**`README.md` ist die Anleitung** — was die Seite kann, wie man mitmacht, die API-Tabelle,
das Datenmodell. Diese Datei hier sagt nur, was ein Agent beim *Arbeiten* am Repo wissen muss.

## Aufbau

| Was | Wo |
|---|---|
| Die Seite | `index.html` — **eine** geschlossene Datei, kein Build, keine externen Ressourcen |
| Die Bilder | `statistik.html` („Statistiken", für jeden Angemeldeten) |
| Der Schlüssel für die Wohnung | `homeassistant.html` (Anleitung + Token, für jeden Angemeldeten) |
| Nutzerverwaltung | `admin.html` (das „Kontor") |
| Grafiken + Tooltip | `bilder.js` — **geteilt** von `statistik.html` und `admin.html`, nie von der Tafel |
| Worker | `worker/src/index.js` |
| Verteiler | `worker/src/tafel.js` — Durable Object `Tafel`, hält die WebSockets |
| Schema | `worker/migrations/` — **eine Datei je Schritt, die Reihenfolge ist die Geschichte** |
| Konfiguration | `worker/wrangler.jsonc` |

Der Abschnitt *Aufbau* im `README.md` beschreibt dasselbe ausführlicher, samt Tabellen und
Routen.

**Große Dateien nie ganz lesen.** `index.html` ≈ 15.650 Zeilen, `worker/src/index.js`
≈ 12.100 (Stand nach Etappe 9 des Gruppen-Umbaus, 14.08.2026 — vorher ≈ 4.100/3.500,
der Umbau hat beide mehr als verdreifacht). Erst `grep -n` für den Umriss, dann `Read`
mit `offset`/`limit`.

**`bilder.js` ist die einzige geteilte Datei.** Wer eine Grafik ändert, ändert sie für
*beide* Seiten — Kontor und Verlauf. Farben stehen dort nirgends fest: jede Seite reicht
beim Start eine Palette in `Bilder.aufsetzen({…})`, die eine in Tinte, die andere in Kreide.
Die Tafel lädt die Datei **nicht** und darf es auch nicht, sonst ist sie keine geschlossene
Datei mehr; sie zeigt nur einen Knopf nach `statistik.html`.

## Ausrollen

Die Reihenfolge ist zwingend:

```
Migration  →  Worker-Deploy  →  Push der Seite
```

Ein Worker, der eine Tabelle abfragt, die es noch nicht gibt, macht jeden Aufruf zum 500er.

Die Befehle dazu — Wrangler läuft hier ohne `node_modules` über `npx`:

```
cd worker && npx wrangler d1 migrations apply beerstock --remote
cd worker && npx wrangler deploy --var GIT_SHA:$(git rev-parse --short HEAD)$([ -n "$(git status --porcelain -- src)" ] && echo '+') --var DEPLOYED_AT:$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

Die beiden `--var` stehen absichtlich nicht in `wrangler.jsonc` — sie ändern sich bei jedem
Deploy, eine feste Eintragung wäre am nächsten Tag schon falsch. Sie landen in
`GET /api/health` (`version`, `deployed_at`) und stehen im Kontor unter der Ampel. Ohne sie
— zum Beispiel bei `wrangler dev` lokal — bleibt die Zeile dort einfach leer, kein Fehler.

**`wrangler deploy` rollt den Arbeitsbaum aus, nicht `HEAD`** — bei ungestagten Änderungen
in `worker/src` würde ein nackter `git rev-parse HEAD` einen sauberen Hash zeigen und lügen.
Das `$([ -n ... ] && echo '+')` hängt darum ein `+` an den Hash, sobald `worker/src` schmutzig
ist (Prüfung bewusst auf diesen Pfad beschränkt, sonst zeigt jede parallele Arbeit an
`index.html` ständig „+", ohne dass der Worker selbst betroffen wäre).

Der Agent führt sie aus, sobald er den Auftrag hat (siehe *Am Ende fragen*), und prüft danach
gegen die Live-API. Ungefragt rollt er nicht aus.

**Nach dem Deploy eine halbe Minute Karenz.** Die Edge antwortet kurz noch mit der alten
Fassung — auch mit Cache-Buster. Das sieht aus wie ein wirkungsloser Deploy und ist keiner.

## Lokal prüfen

```
cd worker && npx --yes wrangler dev --local     # D1 und R2 kommen aus Miniflare
python3 -m http.server 8788                     # die Seite von hier ausliefern
```

**`localhost:8788`, nicht `127.0.0.1`** — nur `localhost` steht in `ERLAUBTE_HERKUNFT`, und
der CORS-Fehler sieht auf der Seite aus wie „kein Netz". Die `API`-Konstante der Seite biegt
sich selbst auf `http://localhost:8787`, sobald sie von `localhost` geladen wird.

Für Mails `worker/.dev.vars` mit `MAIL_ATTRAPPE=1` anlegen (gitignored), sonst geht bei jedem
Lauf des Verteilers echte Post raus.

## Die Wohnung meldet von außen

Eine Home-Assistant-Instanz meldet Bierbestand und Kühlschranktemperatur über dieselbe Route
wie jeder andere Melder (`POST /api/report`); `users.quelle = 'ha'` erzeugt daraus die Marke
*gemessen*. Die Antwort auf das Glücksrad kommt über `POST /api/los/antwort`. **Die andere
Seite dieser Verdrahtung liegt in einem privaten Repo und ist hier nicht einsehbar** — der
Worker sieht davon nichts als einen Bearer-Token.

Der Token dafür ist seit Schema 27 ein **eigener**: `tokens.zweck = 'ha'`, angelegt über
`POST /api/ha/zugang` und einmalig auf `homeassistant.html` sichtbar. `users.quelle` und
`tokens.zweck` sind zwei verschiedene Dinge und dürfen nicht verwechselt werden — die Quelle
sagt „dieses **Konto** misst" (und vergibt die Marke), der Zweck sagt „dieses **Token** sitzt
in einer Automation" (und ist getrennt widerrufbar). Wer eine Regel an eines von beiden hängt,
muss sagen können, welches gemeint ist.

## `ideas/PROJECT-MEMORY.md`

Dort steht das Langzeitgedächtnis dieses Projekts: verworfene Alternativen mit Begründung,
Messwerte, die Fallen des Glücksrads, die lokale Testinstanz, die offenen Punkte. **Zu Beginn
jeder Session lesen — aber abschnittsweise, nie ganz:**

```
grep -n "^#\{2,3\} " ideas/PROJECT-MEMORY.md
```

dann `Read` mit `offset`/`limit` auf die passenden Bereiche. Am Ende einer Session, in der
etwas gelernt wurde, dorthin zurückschreiben.

**`ideas/` ist gitignored** — das Repo ist öffentlich, die Notizen nennen Kontodetails und
lokale Testtoken. In einem frischen Klon ist das Verzeichnis deshalb schlicht nicht da; dann
ist `README.md` alles, was es gibt.

## Opus dazuholen

Die Sitzung läuft auf **Sonnet**. Das trägt den Bau; an drei Stellen holt der Agent aber
einen **Opus-Unteragenten** dazu, statt allein weiterzumachen:

1. **Vor der Festlegung** — bevor ein Bauweg gewählt wird, der später teuer
   zurückzunehmen wäre: Datenmodell, neue Route, Umbau am Verteiler.
2. **Beim zweiten Mal** — kommt derselbe Fehler ein zweites Mal, wird nicht ein drittes
   Mal geraten.
3. **Zur Abnahme** — bevor „fertig" gesagt wird, sieht Opus die Änderung durch.

Technisch ist das schlicht das Agent-Werkzeug mit `model: 'opus'`. Ein eigener Agententyp
existiert nicht und wird auch nicht gebraucht.

**Der Unteragent sieht die Unterhaltung nicht.** Er bekommt nur, was man ihm mitgibt —
also: die Frage, die betroffenen Dateien mit Zeilennummern, was schon versucht wurde und
woran es hängt. Ein „schau mal drüber" ohne Kontext ist verschenktes Geld.

Läuft die Sitzung ohnehin schon auf Opus, entfällt das.

## Am Ende fragen

Ist die Arbeit getan, sagt der Agent **nicht** „committen und deployen machst du". Er fragt —
kurz, mit dem, was anstünde:

> Fertig. Soll ich committen, pushen und ausrollen?

Ohne Antwort passiert nichts: kein Commit, kein Push, kein Deploy. Ein einzelner Schritt geht
auch einzeln („nur committen", „nur den Worker").

### „go live"

Sagt der Nutzer **go live**, ist damit immer die ganze Kette gemeint, ohne Rückfrage, in
dieser Reihenfolge:

1. **Commit** — alles, was zur Arbeit gehört, mit ordentlicher Nachricht
2. **Migration**, falls `worker/migrations/` gewachsen ist
3. **Worker-Deploy**
4. **Push** der Seite nach `main` (GitHub Pages zieht sich den Rest)
5. **HA-Seite**, falls die Änderung sie berührt: dort `git pull` und neu laden

Die Reihenfolge aus *Ausrollen* gilt weiter — Schema vor Worker vor Seite. Danach die halbe
Minute Karenz abwarten und gegen die Live-API prüfen, dann melden, was durchgelaufen ist.
