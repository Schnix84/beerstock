// ============================================================================
// Tafel — der Verteiler hinter der Bierseite.
//
// Ein einziges Durable Object fuer alle Besucher (`idFromName('tafel')`). Jede
// offene Seite haelt eine WebSocket hierher; jede Schreibroute im Worker ruft
// `melden([...])` und das Objekt schiebt die Marke an alle Leitungen.
//
// WAS UEBER DIE LEITUNG GEHT, SIND NUR MARKEN - keine Daten. Eine Marke ist
// 'tafel' (Bestenliste, Rad, Termine haben sich geaendert) oder ein Ziel wie
// 'user:5' / 'termin:12' (dessen Sterne, Kommentare oder Reaktionen). Was sich
// dahinter verbirgt, holt die Seite ueber dieselben GET-Routen wie sonst. Das
// ist Absicht: die Leitung ersetzt das *Nachfragen*, nicht das Laden. So gibt
// es keine zweite Fassung der Antwortlogik, die auseinanderlaufen koennte, und
// ueber die Leitung reist nichts, was ein Mitleser nicht ohnehin sehen darf -
// wer welche Sterne vergeben hat, steckt in `meins` und haengt am Token.
//
// HIBERNATION: die Sockets werden ueber `ctx.acceptWebSocket()` angenommen,
// nicht ueber `server.accept()`. Damit darf die Laufzeit das Objekt zwischen
// zwei Meldungen aus dem Speicher werfen, ohne die Verbindungen zu kappen -
// eine Seite, die einen Abend lang offen auf dem Tisch liegt, kostet dann
// nichts. Aus demselben Grund haelt diese Klasse KEINEN Zustand im Feld: nach
// dem Aufwachen waere er weg. `ctx.getWebSockets()` ist die einzige Wahrheit.
// ============================================================================

import { DurableObject } from 'cloudflare:workers';

export class Tafel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /* Den Herzschlag beantwortet die Laufzeit selbst. Ohne das weckt jedes
       'ping' das Objekt auf, und der Herzschlag - der nur die Leitung offen
       haelt - waere der teuerste Teil des ganzen Baus. */
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* Der Worker reicht die Upgrade-Anfrage unveraendert hierher durch; geprueft
     (Methode, Origin) hat er schon. */
  async fetch() {
    const paar = new WebSocketPair();
    this.ctx.acceptWebSocket(paar[1]);
    return new Response(null, { status: 101, webSocket: paar[0] });
  }

  /* Aufgerufen aus den Schreibrouten, per RPC. `von` ist die zufaellige Kennung
     des Tabs, der geschrieben hat - der bekommt die eigene Meldung nicht
     zurueck, er hat die Antwort seines POSTs schon. */
  async melden(marken, von) {
    const text = JSON.stringify({ marken, von: von || null });
    for (const ws of this.ctx.getWebSockets()) {
      // Eine Leitung, die im selben Moment abreisst, darf die anderen nicht
      // mitnehmen - deshalb einzeln und stumm.
      try { ws.send(text); } catch { /* weg ist weg */ }
    }
  }

  /* Die Seite schickt nur 'ping', und das beantwortet schon die Auto-Antwort
     oben. Der Handler muss trotzdem da sein: ohne ihn ist eine Nachricht an
     ein hibernierendes Objekt ein Fehler. */
  webSocketMessage() {}

  webSocketClose(ws, code, grund, sauber) {
    // 1006 ist der Abriss ohne Close-Frame (Tunnel zu, Handy im Aufzug) - der
    // darf nicht als Code zurueckgehen, den akzeptiert `close()` nicht.
    try { ws.close(code === 1006 ? 1000 : code, grund); } catch {}
  }

  webSocketError(ws) {
    try { ws.close(1011, 'Fehler'); } catch {}
  }
}
