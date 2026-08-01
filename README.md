# beerstock

How many cold beers are currently in the fridge — live from Home Assistant.

Die Seite liegt auf <https://schnix84.github.io/beerstock/>.

## Wie sie funktioniert

`index.html` ist eine einzelne, in sich geschlossene Seite ohne externe
Ressourcen. Sie liest beim Laden `status.json` daneben:

```json
{
  "biere": 7,
  "temperatur": 4.7,
  "stand": "2026-08-02"
}
```

| Feld | Bedeutung |
|---|---|
| `biere` | Anzahl der 0,33-l-Flaschen im Kühlschrank |
| `temperatur` | Kühlschranktemperatur in °C |
| `stand` | Datum der letzten Messung, `YYYY-MM-DD` |

Das Glas füllt sich anteilig: **12 Flaschen = randvoll**. Mehr wird nicht
überlaufend dargestellt, sondern bei voll gedeckelt.

`stand` wird im Browser zu "heute" / "gestern" / "vor N Tagen" umgerechnet.
Bewusst nur auf Tage genau — eine Uhrzeit würde verraten, wann jemand am
Kühlschrank war.

## Wer schreibt die Daten

Eine Home-Assistant-Automation aktualisiert `status.json` nach jeder
Kühlschrank-Inventur über die GitHub-Contents-API. Die Seite selbst ist statisch
und fragt nichts bei der Wohnung an — es geht nur in eine Richtung.
