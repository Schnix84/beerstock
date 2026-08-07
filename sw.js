/* ===========================================================================
   Der Service Worker der Tafel — und er kann genau eine Sache.

   ER FASST DIE AUSLIEFERUNG DER SEITE NICHT AN. Kein `fetch`-Zuhörer, kein
   Cache, kein Offline-Betrieb. Das ist keine Sparsamkeit, sondern die
   Bedingung, unter der es diese Datei überhaupt gibt: `index.html` ist eine
   geschlossene Datei, die bei jedem Aufruf frisch vom Server kommt. Ein
   Service Worker, der sie zwischenlagert, macht aus „der Deploy wirkt nicht"
   ein Rätsel mit zwei Ursachen — der Karenz an der Edge und einer alten Tafel,
   die hier klebt. Wer hier je einen Cache einbaut, hat den Grund für diese
   Datei nicht verstanden.

   WARUM ES SIE TROTZDEM GIBT: Push-Meldungen kann nur ein Service Worker
   entgegennehmen; einen anderen Weg sieht der Browser nicht vor. Die Tafel
   bleibt ohne ihn voll funktionsfähig — er ist eine Zugabe, kein Unterbau.

   Registriert wird er still aus `index.html`; scheitert das (alter Browser,
   kein HTTPS, Nutzer hat es verboten), merkt die Seite es nur daran, dass der
   Push-Schalter im Deckel nicht erscheint.
   =========================================================================== */

/* JEDE Zustellung zeigt eine Meldung — ausnahmslos. Beim Abonnieren
   verspricht die Seite `userVisibleOnly: true`, und das ist kein
   Höflichkeitswunsch: iOS beendet ein Abo nach drei „stillen" Zustellungen
   kommentarlos, Chrome zeigt dann von sich aus „Diese Seite wurde im
   Hintergrund aktualisiert". Ein Push, der nichts anzeigt, kostet also das
   Abo — deshalb steht hier kein `if` vor `showNotification`.

   Was der Worker schickt, ist ein kleines JSON: { titel, text, url, tag }.
   Kommt etwas anderes an (oder gar nichts), bleibt es bei den Vorgaben — eine
   leere Meldung ist immer noch besser als ein verlorenes Abo. */
/* ÜBERNIMM SOFORT. Ohne diese vier Zeilen lädt sich eine neue Fassung zwar
   herunter, bleibt dann aber im Wartestand, bis JEDE Instanz der App
   geschlossen wurde — und bis dahin beantwortet der alte Dienst die Meldungen.
   Genau darüber ist die erste Prüfung des Marken-Umbaus gestolpert: die neue
   `sw.js` lag längst auf dem Server, gearbeitet hat die alte. Von außen sieht
   das aus wie „der Umbau wirkt nicht".

   Für einen Dienst, der Seiten ausliefert, wäre das Vordrängen gefährlich —
   eine halb geladene Seite bekäme plötzlich einen anderen Unterbau. Dieser
   hier liefert nichts aus: kein `fetch`-Zuhörer, kein Cache. Er kann nur
   Meldungen anzeigen, und dabei ist die neuere Fassung immer die richtige.
   Deshalb ist hier richtig, was dort verboten wäre. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', ev => ev.waitUntil(self.clients.claim()));

/* WebKit nimmt die Marke entgegen und tut nichts damit. Das ist kein Verdacht,
   sondern ein offener Fehler: WebKit-Bug 258922, „Push notifications with same
   tag do not replace each other", angelegt im Juli 2023 und im Juli 2026 immer
   noch `NEW`. Auf dem iPhone stapeln sich damit drei Zettel zu einem dreimal
   verschobenen Abend — genau das, was die Marke verhindern soll.

   Das Gegenmittel steht im Bug-Thread selbst: die liegenden Meldungen mit
   dieser Marke suchen und schließen, bevor die neue kommt. `getNotifications`
   kann WebKit, nur das Zusammenfassen nicht.

   NUR AUF WEBKIT, und das ist der Grund für die hässliche Kennungsprüfung: wo
   die Marke funktioniert, ersetzt der Browser lautlos. Erst schließen und dann
   neu zeigen wäre dort eine NEUE Meldung — sie würde klingeln. Bei einem
   Notruf, dessen Kreis erweitert wird, bekämen alle, die ihn schon haben, ein
   zweites Mal Ton. Fällt der Bug irgendwann, kann diese ganze Funktion weg. */
const WEBKIT_STAPELT = /AppleWebKit/.test(self.navigator.userAgent)
  && !/Chrome|Chromium|Edg\//.test(self.navigator.userAgent);

async function marke_freiraeumen(marke) {
  if (!WEBKIT_STAPELT || !marke) return;
  try {
    const liegen = await self.registration.getNotifications({ tag: marke });
    liegen.forEach(n => n.close());
  } catch { /* dann liegt eben eine zu viel — besser als gar keine */ }
}

self.addEventListener('push', ev => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch { d = {}; }

  ev.waitUntil((async () => {
    await marke_freiraeumen(d.tag);
    await self.registration.showNotification(d.titel || 'Wer hat kalt', {
      body: d.text || '',
      /* Die Marke ersetzt eine liegende Meldung, statt sich danebenzustellen:
         wer einen Abend dreimal verschiebt, hinterlässt sonst drei Zettel, von
         denen zwei falsch sind. Vergeben wird sie im Worker (`stosse`) — und
         auf WebKit räumt `marke_freiraeumen` von Hand vor. */
      tag: d.tag || undefined,
      icon: 'icon.png?v=3',    // liegt neben dieser Datei; `?v=` siehe index.html
      /* Das Ziel reist an der Meldung mit und wird erst beim Antippen gebraucht.
         Es ist immer eine vollständige Adresse (der Worker baut sie aus `SEITE`)
         — eine relative würde sich gegen *diese Datei* auflösen und landete auf
         `sw.js#los=41`. */
      data: { url: d.url || self.registration.scope },
    });
  })());
});

/* Angetippt. Der übliche Fall auf dem Handy ist: die Tafel liegt schon
   irgendwo offen. Dann wird sie nach vorn geholt und auf die Sprungmarke
   geschickt — ein zweites Fenster derselben Seite wäre die schlechtere
   Antwort auf „zeig mir das".

   `navigate()` auf eine Adresse, die sich nur im Fragment unterscheidet, lädt
   die Seite nicht neu; sie meldet das mit `hashchange`. Genau dafür hört die
   Tafel darauf — die drei Sprungmarken (`#los=`, `#termin=`, `#notruf`)
   werden nicht nur beim Start gelesen. */
self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const ziel = (ev.notification.data && ev.notification.data.url) || self.registration.scope;

  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(fenster => {
      /* Gegen den eigenen Geltungsbereich geprüft, nicht gegen einen fest
         eingetippten Pfad: dieselbe Datei liegt lokal unter `/` und im Netz
         unter `/beerstock/`. */
      const offen = fenster.find(c => c.url.startsWith(self.registration.scope));
      if (!offen) return self.clients.openWindow(ziel);
      /* Erst nach vorn, dann hinschicken. Der `catch`: ältere WebKit-Stände
         kennen `WindowClient.navigate` nicht. Dann bleibt es beim Fokussieren
         — die Tafel steht dann eben da, wo sie stand, und das ist immer noch
         besser als ein Antippen, das gar nichts tut. */
      return offen.focus()
        .then(c => (c && c.navigate ? c.navigate(ziel) : null))
        .catch(() => {});
    }));
});
