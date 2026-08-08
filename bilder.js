/* ===========================================================================
   DIE BILDER

   Sechs Grafiken, ein Tooltip, kein Fremdcode — und seit es zwei Seiten gibt,
   die sie zeigen (das Kontor und die „Statistiken"), liegen sie hier statt in
   einer der beiden. Der Grund ist kein Aufwand, sondern die Erfahrung: an
   einem Tooltip, der zweimal dasteht, ändert man beim zweiten Mal nichts mehr.

   Warum das die Regel „eine geschlossene Datei, keine externen Ressourcen"
   nicht bricht: die Regel gilt der TAFEL (`index.html`), und die lädt hiervon
   nichts. Sie zeigt einen Knopf, mehr nicht.

   Bedient wird die Datei über eine Palette. Dieselben Bilder sitzen einmal
   auf Papier (Kontor: Tinte auf Sand) und einmal auf Schiefer (Verlauf:
   Kreide auf Dunkel) — die FORMEN sind gleich, die Farben nicht, und keine
   von beiden darf im Code stehen. Aufgerufen wird immer zuerst:

       Bilder.aufsetzen({ reihe: [...], linie: '#…', … })

   Danach liefert jede `Bilder.*`-Funktion ein fertiges `<div class="bild">`,
   das man irgendwo hineinhängt.

   Die Farben gehen zweimal ein: als JS-Werte in die SVG-Attribute (dort gilt
   `var(--x)` nicht überall zuverlässig) und als CSS-Variablen für den Stil,
   den diese Datei selbst mitbringt. Deshalb bringt sie ihn mit und verlangt
   ihn nicht von der Seite: ein Bild, dessen Rahmen woanders steht, ist beim
   nächsten Umzug halb da.
   =========================================================================== */
window.Bilder = (function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* Eigene Kopien der drei Winzlinge statt eines Zugriffs auf die Seite: die
     Datei soll nichts voraussetzen, was zufällig gleich heißt. */
  const el = (tag, klasse, text) => {
    const n = document.createElement(tag);
    if (klasse) n.className = klasse;
    if (text != null) n.textContent = text;
    return n;
  };
  const s_el = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const zahl = n => (n ?? 0).toLocaleString('de-DE');
  const nurTag = iso => iso
    ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
    : '—';

  /* Die Palette. Die Vorgabe ist das Kontor — nicht aus Vorliebe, sondern
     weil die Bilder dort geboren wurden und ein vergessenes `aufsetzen`
     dadurch aussieht wie ein Kontor und nicht wie ein Fehler. */
  const P = {
    linie:      '#d9cfb8',   // Achsen, Hilfslinien, Rahmen der Kärtchen
    text:       '#47544d',   // Beschriftung im Bild
    textWeg:    '#6f6653',   // die blasse Beschriftung
    grund:      '#f4efe3',   // der Untergrund — Marker werden damit ausgestanzt
    stark:      '#1d2a24',   // Tinte: Umriss und Wisch beim Überfahren
    karteGrund: '#ffffff66',
    karteRand:  '#d9cfb8',
    titel:      '#47544d',   // die Überschrift über einem Bild
    tippGrund:  '#1d2a24',
    tippText:   '#ded7c8',
    tippKopf:   '#ffffff',
    tippStrich: '#ffffff26',  // der Trennstrich über der Fußzeile im Tooltip
    ring:       '#2f5d4a',   // der Fokusrahmen
    hand:       'inherit',   // die Schrift der Tooltip-Überschrift
  };

  const STIL = `
  .bild {
    min-width: 0; background: var(--bild-karte-grund);
    border: 1px solid var(--bild-karte-rand); border-radius: 3px;
    padding: 11px 12px 12px;
  }
  .bild .b-kopf { display: flex; align-items: baseline; gap: 8px; }
  .bild h3 {
    font-size: 13px; font-weight: 600; margin: 0; color: var(--bild-titel); flex: 1;
  }
  /* Der Umschalter. Bewusst unter .bild .b-kopf gehaengt und nicht als
     nackter button: beide Seiten, die diese Datei laden, geben button selbst
     eine Form, und die eine war Tinte, die andere Kreide. (Ohne Akzente im
     Kommentar - dieser Block ist ein Template-String, ein Backtick darin
     schloesse ihn.) */
  .bild .b-kopf button {
    font: inherit; font-size: 10.5px; cursor: pointer; white-space: nowrap;
    padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--bild-karte-rand);
    background: transparent; color: var(--bild-text-weg);
  }
  .bild .b-kopf button:hover { color: var(--bild-titel); }
  .bild .b-kopf button:focus-visible {
    outline: 2px solid var(--bild-ring); outline-offset: 2px;
  }
  .bild svg { display: block; width: 100%; height: auto; margin-top: 7px; }
  .bild svg:focus { outline: none; }
  .bild svg:focus-visible {
    outline: 2px solid var(--bild-ring); outline-offset: 3px; border-radius: 2px;
  }
  .bild .leer {
    font-size: 12px; color: var(--bild-text-weg); font-style: italic; padding: 18px 0;
  }
  /* Die Tabelle zum Bild. Zahlen rechtsbuendig und mit tabular-nums, damit
     die Stellen untereinander stehen - das ist der halbe Zweck einer Tabelle.
     Die erste Spalte ist die Beschriftung und bleibt links. */
  .bild .tab-rolle { overflow-x: auto; margin-top: 7px; }
  .bild table {
    width: 100%; border-collapse: collapse;
    font-size: 12px; font-variant-numeric: tabular-nums;
  }
  .bild th, .bild td {
    text-align: right; padding: 3px 6px;
    border-bottom: 1px solid var(--bild-karte-rand); white-space: nowrap;
  }
  .bild th:first-child, .bild td:first-child { text-align: left; white-space: normal; }
  .bild th {
    font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
    font-weight: 600; color: var(--bild-text-weg);
  }
  .bild tr:last-child td { border-bottom: none; }

  .legende { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 11px; }
  /* Ohne diese Zeile bliebe die Legende in der Tabellen-Ansicht stehen: das
     display oben schlaegt das hidden-Attribut, dessen Vorgabe nur
     display:none ist. */
  .legende[hidden] { display: none; }
  .legende span {
    display: inline-flex; align-items: center; gap: 4px; color: var(--bild-text-weg);
  }
  .legende i { width: 9px; height: 9px; border-radius: 2px; display: block; }
  .legende span[data-heb] { cursor: default; }
  .legende span.matt { opacity: .35; }

  .tip {
    position: fixed; top: 0; left: 0; z-index: 30;
    pointer-events: none;
    max-width: 240px; padding: 7px 10px;
    background: var(--bild-tipp-grund); color: var(--bild-tipp-text);
    border-radius: 3px; font-size: 12px; line-height: 1.45;
    box-shadow: 0 8px 22px #00000038;
    opacity: 0; transition: opacity .12s;
  }
  .tip[data-an] { opacity: 1; }
  .tip .t-kopf {
    font-family: var(--bild-hand); font-size: 14px;
    color: var(--bild-tipp-kopf); margin-bottom: 3px;
  }
  .tip .t-z {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  }
  /* Fortgeschrieben, nicht gemeldet. Blass genug, um sich abzuheben, kräftig
     genug zum Lesen — der Wert ist ja nicht weniger wahr, er ist nur älter. */
  .tip .t-z.matt { opacity: .5; }
  .tip .t-z > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .tip .t-z i { width: 7px; height: 7px; border-radius: 2px; display: block; flex: none; }
  .tip .t-z b {
    color: var(--bild-tipp-kopf); font-weight: 600; text-align: right; overflow-wrap: anywhere;
  }
  .tip .t-fuss {
    margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--bild-tipp-strich);
  }
  @media (prefers-reduced-motion: reduce) { .tip { transition: none; } }
  `;

  let aufgesetzt = false;

  /* Einmal je Seite, vor dem ersten Bild. Ein zweiter Aufruf tauscht nur die
     Farben — der Stil hängt schon, und ein zweites `<style>` mit demselben
     Inhalt gewinnt nur, wer es zuletzt einhängt. */
  function aufsetzen(palette) {
    Object.assign(P, palette || {});
    if (palette && palette.reihe) REIHE = palette.reihe;
    if (palette && palette.menschen) MENSCHEN = palette.menschen;
    losFarbenSetzen();

    const wurzel = document.documentElement.style;
    wurzel.setProperty('--bild-karte-grund', P.karteGrund);
    wurzel.setProperty('--bild-karte-rand', P.karteRand);
    wurzel.setProperty('--bild-text-weg', P.textWeg);
    wurzel.setProperty('--bild-titel', P.titel);
    wurzel.setProperty('--bild-tipp-strich', P.tippStrich);
    wurzel.setProperty('--bild-ring', P.ring);
    wurzel.setProperty('--bild-tipp-grund', P.tippGrund);
    wurzel.setProperty('--bild-tipp-text', P.tippText);
    wurzel.setProperty('--bild-tipp-kopf', P.tippKopf);
    wurzel.setProperty('--bild-hand', P.hand);

    if (aufgesetzt) return;
    aufgesetzt = true;
    const stil = document.createElement('style');
    stil.textContent = STIL;
    document.head.appendChild(stil);
    TIP = el('div', 'tip');
    document.body.appendChild(TIP);
  }

  // ==========================================================================
  // Der Tooltip
  //
  // Die Bilder beantworten Fragen nach der FORM; den konkreten Wert eines
  // Punktes las man vorher nirgends ab. Genau dafür ist das hier — und für
  // nichts sonst: es gibt EINEN Kasten für die ganze Seite, den sich alle
  // sechs Grafiken teilen. Sechs eigene Lösungen wären sechsmal derselbe
  // Fehler zu beheben.
  //
  // Er hängt an `body` und nicht im SVG: dort wäre er auf die Zeichenfläche
  // beschnitten und vom Nachbarbild verdeckt. Deshalb wird er in
  // Fenster-Koordinaten gesetzt (`clientX/clientY`) — das erspart auch jedes
  // Umrechnen aus dem viewBox-System, das ja auf die Spaltenbreite skaliert.
  // ==========================================================================
  let TIP = null;   // wird in `aufsetzen` gehaengt, siehe dort

  /* Am Finger bleibt der Kasten stehen, bis woanders hingetippt wird: `touch`
     schickt `pointerleave` schon beim Abheben, und ein Tooltip, der genau
     dann verschwindet, wenn man ihn lesen will, ist keiner. */
  let tipFest = false;

  function tipAn(quelle, inhalt) {
    if (!inhalt || !TIP) return;
    TIP.textContent = '';
    if (inhalt.titel) TIP.appendChild(el('div', 't-kopf', inhalt.titel));
    (inhalt.zeilen || []).forEach(z => {
      // `matt`: der Wert steht da, stammt aber nicht von diesem Tag — die
      // Kurvenschar schreibt stumme Tage fort. Siehe `bildSchar`.
      const zeile = el('div', z.matt ? 't-z matt' : 't-z');
      const links = el('span');
      if (z.farbe) {
        const punkt = el('i');
        punkt.style.background = z.farbe;
        links.appendChild(punkt);
      }
      links.appendChild(document.createTextNode(z.was));
      zeile.appendChild(links);
      zeile.appendChild(el('b', null, z.wert));
      TIP.appendChild(zeile);
    });
    if (inhalt.fuss) TIP.appendChild(el('div', 't-fuss', inhalt.fuss));

    /* Woher die Koordinaten kommen: vom Zeiger, wenn es einen gibt, sonst vom
       Element selbst — beim Weiterschalten mit der Tastatur gibt es keinen. */
    let x, y;
    if (quelle.clientX !== undefined) {
      x = quelle.clientX + 14; y = quelle.clientY + 16;
    } else {
      const r = quelle.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.bottom + 8;
    }
    TIP.dataset.an = '1';
    // Erst sichtbar machen, dann messen: ein `hidden` Kasten hat keine Breite.
    const b = TIP.getBoundingClientRect();
    if (x + b.width > innerWidth - 8) x = Math.max(8, innerWidth - b.width - 8);
    if (y + b.height > innerHeight - 8) y = Math.max(8, y - b.height - 30);
    TIP.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  const tipAus = () => { if (TIP) delete TIP.dataset.an; };

  /* Die Trefferflächen eines Bildes. Jede Grafik übergibt eine Liste von
     Punkten; was ein „Punkt" ist, entscheidet sie selbst — ein Tag, eine
     Zeile, ein Segment.

     `flaeche` ist ein unsichtbares Rechteck, das groß genug zum Treffen ist:
     auf eine 1,6 px dünne Kurve zielt niemand, und ein Segment von vier
     Pixeln trifft man auch mit der Maus nicht. `inhalt()` liefert den Text,
     `hervor(an)` darf im Bild etwas hervorheben.

     Die ganze Reihe hängt zusätzlich an der Tastatur: das SVG ist ein einziger
     Tabstop, links/rechts wandert durch die Punkte. Jeden Punkt einzeln
     anspringbar zu machen wäre bei 60 Tagen ein Tabstop-Feld. */
  function treffer(svg, punkte) {
    if (!punkte.length) return;
    let offen = -1;

    const zeigen = (i, quelle) => {
      if (offen !== i && offen >= 0 && punkte[offen].hervor) punkte[offen].hervor(false);
      offen = i;
      if (punkte[i].hervor) punkte[i].hervor(true);
      tipAn(quelle || punkte[i].flaeche, punkte[i].inhalt());
    };
    const schliessen = () => {
      if (offen >= 0 && punkte[offen].hervor) punkte[offen].hervor(false);
      offen = -1;
      tipAus();
    };

    punkte.forEach((p, i) => {
      // `transparent`, nicht `none`: eine Fläche ohne Füllung fängt keinen
      // Zeiger. `pointer-events` sagt dasselbe noch einmal ausdrücklich.
      p.flaeche.setAttribute('fill', 'transparent');
      p.flaeche.setAttribute('pointer-events', 'all');
      p.flaeche.dataset.treffer = '1';
      p.flaeche.addEventListener('pointerenter', ev => zeigen(i, ev));
      p.flaeche.addEventListener('pointermove', ev => zeigen(i, ev));
      p.flaeche.addEventListener('pointerleave', () => { if (!tipFest) schliessen(); });
      p.flaeche.addEventListener('pointerdown', ev => {
        if (ev.pointerType === 'touch') { tipFest = true; zeigen(i, ev); }
      });
      svg.appendChild(p.flaeche);
    });

    svg.setAttribute('tabindex', '0');
    svg.addEventListener('keydown', ev => {
      const schritt = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
      if (schritt) {
        ev.preventDefault();
        const i = offen < 0
          ? (schritt > 0 ? 0 : punkte.length - 1)
          : Math.min(punkte.length - 1, Math.max(0, offen + schritt));
        zeigen(i, null);
      } else if (ev.key === 'Escape') {
        schliessen();
      }
    });
    svg.addEventListener('blur', schliessen);
  }

  /* Dasselbe für ein gewöhnliches HTML-Element — die Ampel benutzt es. */
  function tippAm(node, inhalt) {
    node.addEventListener('pointerenter', ev => tipAn(ev, inhalt));
    node.addEventListener('pointerleave', () => { if (!tipFest) tipAus(); });
    node.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'touch') { tipFest = true; tipAn(ev, inhalt); }
    });
  }

  // Wer den festgehaltenen Kasten wieder loswerden will, tippt daneben,
  // scrollt oder drückt Esc.
  document.addEventListener('pointerdown', ev => {
    if (tipFest && !(ev.target.closest && ev.target.closest('[data-treffer]'))) {
      tipFest = false;
      tipAus();
    }
  }, true);
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { tipFest = false; tipAus(); }
  });
  addEventListener('scroll', () => { if (!tipFest) tipAus(); }, true);

  // ==========================================================================
  // Die Grafiken. Alles von Hand, kein Fremdcode.
  //
  // Alle rechnen in einem festen viewBox-Koordinatensystem und lassen das SVG
  // per CSS auf die Spaltenbreite skalieren — damit muss keine einzige davon
  // wissen, wie breit sie am Ende wirklich ist, und ein Umbruch des Rasters
  // zeichnet nichts neu.
  // ==========================================================================
  const W = 300, H = 120, PAD = { l: 26, r: 6, o: 8, u: 18 };
  const IX = W - PAD.l - PAD.r;      // Innenbreite
  const IY = H - PAD.o - PAD.u;      // Innenhöhe

  /* Die Farben der Reihen. Aus den beiden Familien der Tafel abgeleitet und
     bewusst wenige: mehr als sechs Linien in einem Bild liest ohnehin
     niemand mehr auseinander. */
  let REIHE = ['#2f5d4a', '#b8901f', '#b04a38', '#4a6f8a', '#7a5c8f', '#6f6653'];

  /* ZWEI REIHEN, ZWEI AUFGABEN, und sie dürfen nicht dieselbe sein.

     `REIHE` färbt ROLLEN: den Ausgang einer Ziehung, den Balken einer
     Rangliste, die Anteile einer Säule. Was Platz 3 bedeutet, hängt am Bild.

     `MENSCHEN` färbt IDENTITÄT: eine Kreide je Melder, dieselbe an seiner
     Kurve hier, an seinem Bogen im Rad und an seiner Karte im Kontor. Welchen
     Platz jemand hat, sagt der Worker (`farbe` an der Kurve, siehe
     migrations/0028) — diese Datei zählt nichts durch.

     Die Vorgabe hier ist die Kreidereihe; wer auf Papier zeichnet, reicht
     ihre Tintenfassung über `aufsetzen({ menschen: [...] })` herein. Dieselben
     sieben in derselben Ordnung stehen als `MENSCHEN` in `index.html` — warum
     sieben und nicht acht, steht dort. */
  let MENSCHEN = ['#d153a2', '#be4523', '#c18705', '#017a16',
                  '#39ac6f', '#1d9af0', '#6956c2'];
  /* Die Farbe eines Melders. `ersatz` ist die Stellung im Bild und greift nur
     bei Daten ohne Platz — ein Worker von vor Schema 28, oder ein
     eingefrorenes Feld von damals. */
  const menschenFarbe = (platz, ersatz = 0) =>
    MENSCHEN[(platz == null ? ersatz : platz) % MENSCHEN.length];

  function rahmen(titel) {
    const box = el('div', 'bild');
    const kopf = el('div', 'b-kopf');
    kopf.appendChild(el('h3', null, titel));
    box.appendChild(kopf);
    return box;
  }
  const leer = (box, was) => { box.appendChild(el('p', 'leer', was)); return box; };

  /* --- Die Tabelle zum Bild ------------------------------------------------
     Jedes Bild beantwortet eine Frage nach der FORM. Die nach dem genauen Wert
     beantwortet der Tooltip, aber immer nur für einen Punkt und nur, solange
     der Finger draufliegt — abschreiben, vergleichen oder vorlesen lassen kann
     man ihn nicht. Dafür ist die Tabelle da: dieselben Zahlen, aus denen die
     Grafik gemalt wurde, als Text.

     Sie tritt an die STELLE des Bildes, nicht darunter. Beides gleichzeitig
     wäre zweimal dasselbe untereinander, und die Karte doppelt so hoch.

     Die Zeilen kommt jedes Bild selbst mit — aus dem fertigen SVG sind sie
     nicht mehr zu holen, und aus derselben Quelle gebaut können sie gar nicht
     erst auseinanderlaufen.
     --------------------------------------------------------------------- */
  function tabelleAn(box, koepfe, zeilen) {
    const svg = box.querySelector('svg');
    if (!svg || !zeilen.length) return box;

    const rolle = el('div', 'tab-rolle');
    rolle.hidden = true;
    const t = el('table');
    const kz = el('tr');
    koepfe.forEach(k => kz.appendChild(el('th', null, k)));
    t.appendChild(kz);
    zeilen.forEach(z => {
      const r = el('tr');
      z.forEach(v => r.appendChild(el('td', null, v == null ? '—' : String(v))));
      t.appendChild(r);
    });
    rolle.appendChild(t);
    box.appendChild(rolle);

    const legende = box.querySelector('.legende');
    const knopf = el('button', null, 'Tabelle');
    knopf.type = 'button';
    knopf.setAttribute('aria-pressed', 'false');
    knopf.addEventListener('click', () => {
      const zeigen = rolle.hidden;
      rolle.hidden = !zeigen;
      svg.style.display = zeigen ? 'none' : '';
      // Die Legende ist der Schlüssel zu den Farben im Bild. Ohne Bild ist sie
      // eine Farbtabelle zu nichts.
      if (legende) legende.hidden = zeigen;
      knopf.textContent = zeigen ? 'Bild' : 'Tabelle';
      knopf.setAttribute('aria-pressed', String(zeigen));
      // Ein festgehaltener Kasten zeigte sonst auf einen Punkt, der gerade
      // weggeklappt ist.
      tipFest = false;
      tipAus();
    });
    box.querySelector('.b-kopf').appendChild(knopf);
    return box;
  }

  /* Die Grundlinie, zwei gestrichelte Hilfslinien und die Beschriftung links.
     Die Hilfslinien sind der Unterschied zwischen „die Kurve ist oben" und
     „das waren etwa neun": man braucht eine Marke auf halber Höhe, um zu
     schätzen. Gestrichelt und in der Farbe der Kontorlinien, damit sie hinter
     den Daten bleiben. */
  /* `tief` ist der Fuß der Skala und fast immer 0 — bei Anzahlen ist alles
     andere eine Lüge, weil ein abgeschnittener Balken doppelt so hoch aussieht
     wie er ist. Bei GRAD ist 0 dagegen willkürlich: zwischen 4 °C und 7 °C
     liegt der ganze Unterschied zwischen kalt und lauwarm, und über einer
     Nulllinie wären beide derselbe Strich ganz oben. Nur dafür gibt es das
     zweite Argument, und nur die Gradkurve setzt es. */
  function achse(svg, max, beschriften = true, tief = 0) {
    const spanne = max - tief;
    [.5, 1].forEach(anteil => {
      svg.appendChild(s_el('line', {
        x1: PAD.l, y1: PAD.o + IY - anteil * IY, x2: PAD.l + IX, y2: PAD.o + IY - anteil * IY,
        stroke: P.linie, 'stroke-width': .6, 'stroke-dasharray': '1.5 3',
      }));
    });
    svg.appendChild(s_el('line', {
      x1: PAD.l, y1: PAD.o + IY, x2: PAD.l + IX, y2: PAD.o + IY,
      stroke: P.linie, 'stroke-width': 1,
    }));
    if (!beschriften) return;
    [tief, max].forEach(v => {
      const y = PAD.o + IY - (spanne ? (v - tief) / spanne : 0) * IY;
      const t = s_el('text', {
        x: PAD.l - 5, y: y + 3.5, 'text-anchor': 'end',
        'font-size': 8, fill: P.textWeg,
      });
      t.textContent = zahl(v);
      svg.appendChild(t);
    });
  }

  const beschriftung = (svg, x, y, text, anker = 'middle') => {
    const t = s_el('text', { x, y, 'text-anchor': anker, 'font-size': 8, fill: P.textWeg });
    t.textContent = text;
    svg.appendChild(t);
  };

  const svgNeu = () => s_el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  /* Der Zeiger eines Bildes: die Gruppe, in der beim Überfahren die
     Führungslinie und die Punkte liegen. Eine je Bild, sie wird umgehängt
     statt neu gebaut. Sie kommt ans Ende der Zeichnung, aber vor die
     Trefferflächen — sonst läge sie unter der Kurve. */
  const zeigerNeu = svg => {
    const g = s_el('g', { opacity: 0, 'pointer-events': 'none' });
    svg.appendChild(g);
    return g;
  };

  /* Die Funke: die kleine Linie unter einer Kopfzahl. Keine Achse, keine
     Beschriftung, kein Tooltip — sie beantwortet nur „steigt oder fällt das",
     und alles weitere steht in den Bildern darunter. Eigene Maße, weil sie
     22 px hoch ist und die Ränder der großen Bilder darin lächerlich wären. */
  function funke(werte, farbe) {
    const w = 100, h = 22, luft = 2.5;
    const svg = s_el('svg',
      { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    if (werte.length < 2) return svg;
    const tief = Math.min(...werte), hoch = Math.max(...werte);
    const spanne = hoch - tief || 1;
    const px = werte.map((v, i) => [
      (i / (werte.length - 1)) * w,
      h - luft - ((v - tief) / spanne) * (h - luft * 2),
    ]);
    svg.appendChild(s_el('path', {
      d: `M0,${h} ` + px.map(p => `L${p[0]},${p[1]}`).join(' ') + ` L${w},${h} Z`,
      fill: verlauf(svg, farbe),
    }));
    svg.appendChild(s_el('polyline', {
      points: px.map(p => p.join(',')).join(' '), fill: 'none',
      stroke: farbe, 'stroke-width': 1.2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      // Ohne das würde der Strich mit der Fläche in die Breite gezogen und
      // wäre am Ende an einer Stelle dick und an der anderen dünn.
      'vector-effect': 'non-scaling-stroke',
    }));
    return svg;
  }

  /* Verläufe brauchen eine ID, und IDs sind auf der ganzen Seite eindeutig —
     zwei Bilder mit demselben `id` teilen sich sonst still den Verlauf des
     ersten. Deshalb ein Zähler. */
  let verlaufNr = 0;
  function verlauf(svg, farbe) {
    const id = 'v' + (++verlaufNr);
    const defs = s_el('defs');
    const g = s_el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(s_el('stop', { offset: '0%', 'stop-color': farbe, 'stop-opacity': .28 }));
    g.appendChild(s_el('stop', { offset: '100%', 'stop-color': farbe, 'stop-opacity': .02 }));
    defs.appendChild(g);
    svg.appendChild(defs);
    return `url(#${id})`;
  }

  /* 1 — Meldungen je Tag. Flächenkurve: die Frage ist, ob überhaupt gemeldet
     wird, nicht wie oft genau an einem bestimmten Dienstag — und für den
     einen bestimmten Dienstag gibt es jetzt den Tooltip. */
  function bildFlaeche(titel, punkte, wertVon, markeVon, was) {
    const box = rahmen(titel);
    if (!punkte.length) return leer(box, 'Noch nichts eingetragen.');
    const svg = svgNeu();
    const werte = punkte.map(wertVon);
    const max = Math.max(...werte, 1);
    const x = i => PAD.l + (punkte.length > 1 ? i / (punkte.length - 1) : .5) * IX;
    const y = v => PAD.o + IY - (v / max) * IY;

    achse(svg, max);
    const px = werte.map((v, i) => [x(i), y(v)]);
    svg.appendChild(s_el('path', {
      d: `M${px[0][0]},${PAD.o + IY} ` + px.map(p => `L${p[0]},${p[1]}`).join(' ')
         + ` L${px[px.length - 1][0]},${PAD.o + IY} Z`,
      fill: verlauf(svg, REIHE[0]),
    }));
    svg.appendChild(s_el('polyline', {
      points: px.map(p => p.join(',')).join(' '), fill: 'none',
      stroke: REIHE[0], 'stroke-width': 1.6,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    // Punkte an den Datenstellen, aber nur solange man sie auseinanderhält:
    // bei sechzig Tagen wird daraus eine dicke Linie.
    if (punkte.length <= 20) {
      px.forEach(p => svg.appendChild(
        s_el('circle', { cx: p[0], cy: p[1], r: 1.7, fill: REIHE[0] })));
    }
    beschriftung(svg, PAD.l, H - 4, markeVon(punkte[0]), 'start');
    if (punkte.length > 1) {
      beschriftung(svg, PAD.l + IX, H - 4, markeVon(punkte[punkte.length - 1]), 'end');
    }

    /* Der Zeiger: senkrechte Führungslinie plus ein Ring auf dem Punkt. Ohne
       die Linie weiß man beim Lesen des Kastens nicht mehr, welche Stelle
       gemeint war. */
    const zeiger = zeigerNeu(svg);
    const linie = s_el('line',
      { y1: PAD.o, y2: PAD.o + IY, stroke: REIHE[0], 'stroke-width': .7, 'stroke-dasharray': '2 2' });
    // Der Ring in Papierfarbe, nicht durchsichtig: sonst schimmert die Fläche
    // durch und der Punkt sieht schmutzig aus. (Als Attribut ausgeschrieben —
    // `var(--papier)` gilt in einem Präsentationsattribut nicht überall.)
    const ring = s_el('circle',
      { r: 3, fill: P.grund, stroke: REIHE[0], 'stroke-width': 1.6 });
    zeiger.appendChild(linie);
    zeiger.appendChild(ring);

    /* Die Trefferbänder: je Punkt ein Streifen über die volle Höhe, halb bis
       zum Nachbarn nach beiden Seiten. Auf die Kurve selbst zu zielen ist bei
       1,6 px Strichstärke eine Geduldsprobe. */
    const halb = punkte.length > 1 ? IX / (punkte.length - 1) / 2 : IX / 2;
    treffer(svg, punkte.map((p, i) => ({
      flaeche: s_el('rect', {
        x: Math.max(PAD.l, x(i) - halb), y: PAD.o,
        width: Math.min(halb * 2, IX), height: IY,
      }),
      hervor: an => {
        zeiger.setAttribute('opacity', an ? 1 : 0);
        linie.setAttribute('x1', x(i)); linie.setAttribute('x2', x(i));
        ring.setAttribute('cx', x(i)); ring.setAttribute('cy', y(werte[i]));
      },
      inhalt: () => ({
        titel: markeVon(p),
        zeilen: [{ farbe: REIHE[0], was: was || 'Anzahl', wert: zahl(werte[i]) }],
      }),
    })));

    box.appendChild(svg);
    return tabelleAn(box, ['', was || 'Anzahl'],
      punkte.map((p, i) => [markeVon(p), zahl(werte[i])]));
  }

  /* 2 — Bestand je Melder. Eine Linie je Mensch, über eine gemeinsame
     Zeitachse: nur so sieht man, wer wann nachgelegt hat. Die Achse kommt aus
     der Vereinigung aller Tage, nicht aus der längsten Reihe — sonst säßen
     zwei Kurven mit verschiedenen Startpunkten übereinander und logen.

     **Stumme Tage werden FORTGESCHRIEBEN.** Wer eine Woche lang nichts meldet,
     hat deshalb nicht weniger im Kühlschrank — er hat nichts gesagt. Vorher zog
     die Kurve quer von der einen Meldung zur nächsten, und diese Schräge war
     eine Behauptung über sieben Tage, für die es keine einzige Zahl gab. Jetzt
     läuft der letzte bekannte Stand waagerecht weiter, bis eine neue Zahl
     kommt; erst dort steigt oder fällt die Linie.

     Drei Dinge, die daran hängen:

       - **Fortgeschrieben wird nur GEZEICHNET, nicht gezählt.** „Meldungen je
         Tag" bleibt unberührt — das Bild zählt Meldungen, und eine
         fortgeschriebene ist keine. Die Daten vom Worker sind unverändert: er
         gibt weiter nur die Tage heraus, an denen wirklich gemeldet wurde.
       - **Vor der ersten Meldung wird nichts fortgeschrieben.** Rückwärts gäbe
         es nichts zu wissen; die Linie beginnt, wo der Mensch beginnt.
       - Im Kasten steht der fortgeschriebene Wert **blass**, der frisch
         gemeldete normal. Sonst läse man ihn als heutige Meldung, und das wäre
         genau die Lüge, die die Schräge vorher erzählt hat. */
  function bildSchar(titel, kurven, o = {}) {
    const box = rahmen(titel);
    const mitWerten = kurven.filter(k => k.werte.length);
    if (!mitWerten.length) return leer(box, 'Noch nichts eingetragen.');

    const tage = [...new Set(mitWerten.flatMap(k => k.tage))].sort();
    const alle = mitWerten.flatMap(k => k.werte);
    /* `abNull` ist die Vorgabe. Wo sie fällt, wird die Skala um die Werte
       herum gelegt und auf ganze Schritte gerundet — sonst klebt eine Reihe,
       die den ganzen Zeitraum über bei 5,0 stand, als Strich auf der
       Grundlinie und sähe aus wie „nichts". */
    const tief = o.abNull === false ? Math.floor(Math.min(...alle) - .5) : 0;
    const max = o.abNull === false
      ? Math.max(Math.ceil(Math.max(...alle) + .5), tief + 1)
      : Math.max(...alle, 1);
    const spanne = max - tief || 1;
    // Wie ein Wert im Kasten steht. Nur die Grad brauchen mehr als die Zahl.
    const text = o.text || ((k, j) => zahl(k.werte[j]));
    // Über den Index statt über den Tag: seit fortgeschrieben wird, wird für
    // JEDEN Tag der Achse gerechnet, und ein `indexOf` je Tag und Melder wäre
    // dieselbe Suche neunzigmal.
    const x = d => PAD.l + (tage.length > 1 ? d / (tage.length - 1) : .5) * IX;
    const y = v => PAD.o + IY - ((v - tief) / spanne) * IY;

    /* Der Stand je Melder an jedem Tag der Achse: `j` zeigt auf die Meldung,
       aus der der Wert stammt, `frisch` sagt, ob sie von diesem Tag ist. Vor
       der ersten Meldung steht `null` — da gibt es nichts fortzuschreiben.

       Ein Durchlauf, kein Suchen: `k.tage` ist aufsteigend und die Achse ist
       die sortierte Vereinigung, also kommt jeder Tag eines Melders in
       derselben Reihenfolge vorbei. */
    const stand = mitWerten.map(k => {
      let j = -1, naechste = 0;
      return tage.map(tag => {
        const frisch = k.tage[naechste] === tag;
        if (frisch) j = naechste++;
        return j < 0 ? null : { j, frisch };
      });
    });

    const svg = svgNeu();
    achse(svg, max, true, tief);
    const striche = [];      // je Kurve ihr gezeichnetes Element, für das Hervorheben
    mitWerten.forEach((k, i) => {
      const px = [];
      stand[i].forEach((s, d) => { if (s) px.push([x(d), y(k.werte[s.j])]); });
      /* Die Farbe gehört dem MELDER, nicht seiner Stellung in der Schar:
         `k.farbe` ist sein Platz in der Kreidereihe. Vorher lief das über `i`,
         und damit wechselte eine Kurve die Farbe, sobald jemand anderes
         dazukam oder das Fenster einen Melder herausfiltert. */
      const farbe = menschenFarbe(k.farbe, i);
      const strich = px.length === 1
        ? s_el('circle', { cx: px[0][0], cy: px[0][1], r: 2.2, fill: farbe })
        : s_el('polyline', {
            points: px.map(p => p.join(',')).join(' '), fill: 'none',
            stroke: farbe, 'stroke-width': 1.5,
            'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          });
      svg.appendChild(strich);
      striche.push(strich);
    });
    beschriftung(svg, PAD.l, H - 4, nurTag(tage[0]), 'start');
    if (tage.length > 1) beschriftung(svg, PAD.l + IX, H - 4, nurTag(tage[tage.length - 1]), 'end');

    /* Ein Band je Tag, und im Kasten steht, wer an diesem Tag wie stand — auch
       der, der geschwiegen hat, aber blass und mit dem Tag seiner Meldung
       dahinter. Der Ring im Bild wird bei ihm kleiner und schwächer: die Linie
       läuft dort durch, sie hat dort keinen Halt. */
    const zeiger = zeigerNeu(svg);
    const linie = s_el('line',
      { y1: PAD.o, y2: PAD.o + IY, stroke: P.textWeg, 'stroke-width': .7, 'stroke-dasharray': '2 2' });
    zeiger.appendChild(linie);

    const halb = tage.length > 1 ? IX / (tage.length - 1) / 2 : IX / 2;
    treffer(svg, tage.map((tag, d) => {
      const da = mitWerten
        .map((k, i) => {
          const s = stand[i][d];
          return !s ? null : {
            farbe: menschenFarbe(k.farbe, i), was: k.name,
            wert: k.werte[s.j], zeigt: text(k, s.j),
            frisch: s.frisch, seit: k.tage[s.j],
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.wert - a.wert);
      const stumm = da.filter(z => !z.frisch).length;
      return {
        flaeche: s_el('rect', {
          x: Math.max(PAD.l, x(d) - halb), y: PAD.o,
          width: Math.min(halb * 2, IX), height: IY,
        }),
        hervor: an => {
          zeiger.setAttribute('opacity', an ? 1 : 0);
          linie.setAttribute('x1', x(d)); linie.setAttribute('x2', x(d));
          // Die Ringe wechseln mit dem Tag die Zahl — deshalb neu gesetzt
          // statt vorgehalten.
          [...zeiger.querySelectorAll('circle')].forEach(c => c.remove());
          if (!an) return;
          da.forEach(z => zeiger.appendChild(s_el('circle', {
            cx: x(d), cy: y(z.wert), r: z.frisch ? 2.6 : 1.7,
            fill: P.grund, stroke: z.farbe, 'stroke-width': z.frisch ? 1.4 : 1,
            opacity: z.frisch ? 1 : .55,
          })));
        },
        inhalt: () => ({
          titel: nurTag(tag),
          /* Der fortgeschriebene Wert trägt SEIN Datum, nicht der Fuß: bei drei
             Schweigern sind es drei verschiedene, und eines davon unten
             hinzuschreiben hieße, für die anderen beiden zu raten. */
          zeilen: da.map(z => ({
            farbe: z.farbe, was: z.was, matt: !z.frisch,
            wert: z.frisch ? z.zeigt : z.zeigt + ' · ' + nurTag(z.seit),
          })),
          fuss: !da.length
            ? o.fussLeer || 'Niemand hat gemeldet.'
            : stumm
              ? 'Blass: nicht gemeldet, Stand läuft weiter'
              : null,
        }),
      };
    }));
    box.appendChild(svg);

    /* Die Legende hebt hervor: bei fünf Meldern liegen die Linien
       übereinander, und „welche ist meine" beantwortet keine Farbtabelle,
       wenn zwei Grüntöne nebeneinander stehen. */
    const leg = el('div', 'legende');
    mitWerten.forEach((k, i) => {
      const s = el('span');
      s.dataset.heb = '1';
      const punkt = el('i');
      punkt.style.background = menschenFarbe(k.farbe, i);
      s.appendChild(punkt);
      s.appendChild(document.createTextNode(k.name));
      const heben = an => {
        striche.forEach((st, j) => st.setAttribute('opacity', !an || j === i ? 1 : .15));
        [...leg.children].forEach((c, j) => c.classList.toggle('matt', an && j !== i));
      };
      s.addEventListener('pointerenter', () => heben(true));
      s.addEventListener('pointerleave', () => heben(false));
      leg.appendChild(s);
    });
    box.appendChild(leg);

    /* Ein fortgeschriebener Wert trägt sein Datum dahinter, genau wie im
       Kasten: „blass" gibt es in einer Tabelle nicht, und ohne das Datum
       stünde dort ein Stand, den an diesem Tag niemand gemeldet hat, als
       wäre er von diesem Tag. Wo noch nichts bekannt war, bleibt die Zelle
       leer statt null zu behaupten. */
    return tabelleAn(box, ['', ...mitWerten.map(k => k.name)],
      tage.map((tag, d) => [nurTag(tag), ...mitWerten.map((k, i) => {
        const s = stand[i][d];
        if (!s) return null;
        return s.frisch ? text(k, s.j) : text(k, s.j) + ' · ' + nurTag(k.tage[s.j]);
      })]));
  }

  /* 2b — Temperatur je Tag und Melder. Dieselbe Kurvenschar wie beim Bestand,
     nur mit drei Unterschieden, und alle drei folgen daraus, dass Grad keine
     Anzahl sind:

       - Die Skala fängt nicht bei 0 an (siehe `achse`).
       - Im Kasten steht eine Kommazahl mit Einheit, nicht `2`, sondern `5,2 °C`.
       - Wurde an einem Tag mehrfach gemeldet, steht die SPANNE dahinter. Die
         Kurve kann nur einen Wert zeigen und zeigt den letzten; dass es an dem
         Tag auch mal 9 °C waren, stünde sonst nirgends.

     Die Reihenfolge der Farben ist dieselbe wie beim Bestand, weil dieselben
     Melder in derselben Reihenfolge kommen — wer im einen Bild grün ist, ist
     es im anderen auch. */
  const GRAD = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const gradText = v => GRAD.format(v) + ' °C';

  function bildGrad(titel, kurven) {
    return bildSchar(titel, kurven, {
      abNull: false,
      fussLeer: 'Niemand hat gemeldet.',
      text: (k, j) => {
        const wert = gradText(k.werte[j]);
        const tief = k.tief?.[j], hoch = k.hoch?.[j];
        // Nur wenn sich der Tag wirklich bewegt hat. Bei einer einzigen
        // Meldung waere "(5,2–5,2)" nur Rauschen hinter derselben Zahl.
        return (k.n?.[j] > 1 && tief !== hoch)
          ? `${wert} (${GRAD.format(tief)}–${GRAD.format(hoch)})`
          : wert;
      },
    });
  }

  /* 3 — Liegende Balken. Für Ranglisten mit Namen: senkrecht müsste man den
     Kopf drehen, um zu lesen, wer gemeint ist.

     ZWEI FASSUNGEN, und welche gilt, entscheiden die Daten.

     Steht an den Zeilen eine Melderfarbe (`farbe`, seit Schema 28), trägt
     jeder Balken SEINE — dieselbe Kreide wie die Kurve desselben Menschen im
     Bild darüber und sein Bogen am Rad. Dann sind die Balken voll deckend:
     die Rangfolge steht in der Reihenfolge und in der Zahl am Ende, und ein
     verblassender Farbton wäre nur noch ein schlechter Farbton.

     Ohne Melderfarbe bleibt es beim Alten: ein Ton, nach unten hin blasser.
     Das war nie Zierde — acht gleich gefärbte Balken sind eine Liste, eine
     Staffel ist eine Rangfolge, und die Länge allein trennt Platz 1 und
     Platz 2 kaum, wenn beide fast gleich oft dran waren. */
  function bildLiegend(titel, daten, nameVon, wertVon, was) {
    const box = rahmen(titel);
    if (!daten.length) return leer(box, 'Noch nichts eingetragen.');
    const zeilen = daten.slice(0, 8);
    const summe = zeilen.reduce((a, z) => a + wertVon(z), 0);
    const max = Math.max(...zeilen.map(wertVon), 1);
    const hoch = 15, luft = 5;
    const hoehe = Math.max(zeilen.length * (hoch + luft) + 6, 40);
    const svg = s_el('svg', { viewBox: `0 0 ${W} ${hoehe}`, role: 'img' });
    const lx = 66;   // Platz für den Namen
    /* Entweder ALLE Zeilen tragen eine Farbe oder keine. Ein gemischtes Bild
       — drei Melder bunt, der vierte im Verlegenheitsgrün — sähe aus, als
       bedeute das Grün etwas. */
    const eigen = zeilen.every(z => z && z.farbe != null);
    const ton = (z, i) => eigen ? menschenFarbe(z.farbe) : REIHE[0];
    const stufe = i => eigen ? 1 : Math.max(.34, .85 - i * .07);

    const balken = [];
    zeilen.forEach((z, i) => {
      const y = i * (hoch + luft) + 3;
      const b = (wertVon(z) / max) * (W - lx - 22);
      const r = s_el('rect', {
        x: lx, y, width: Math.max(b, 1), height: hoch, rx: 2,
        fill: ton(z, i), opacity: stufe(i),
      });
      svg.appendChild(r);
      balken.push(r);
      const n = s_el('text',
        { x: lx - 6, y: y + hoch - 4, 'text-anchor': 'end', 'font-size': 9.5, fill: P.text });
      n.textContent = nameVon(z);
      svg.appendChild(n);
      const w = s_el('text',
        { x: lx + Math.max(b, 1) + 5, y: y + hoch - 4, 'font-size': 9.5, fill: P.textWeg });
      w.textContent = zahl(wertVon(z));
      svg.appendChild(w);
    });

    // Getroffen wird die ganze Zeile, nicht der Balken: bei einem Wert von
    // eins ist der Balken drei Pixel breit.
    treffer(svg, zeilen.map((z, i) => ({
      flaeche: s_el('rect',
        { x: 0, y: i * (hoch + luft), width: W, height: hoch + luft }),
      hervor: an => balken[i].setAttribute('opacity', an ? 1 : stufe(i)),
      inhalt: () => ({
        titel: nameVon(z),
        zeilen: [{ farbe: ton(z, i), was: was || 'Anzahl', wert: zahl(wertVon(z)) }],
        fuss: summe ? Math.round((wertVon(z) / summe) * 100) + ' % der gezeigten Zeilen' : null,
      }),
    })));
    box.appendChild(svg);
    return tabelleAn(box, ['', was || 'Anzahl'],
      zeilen.map(z => [nameVon(z), zahl(wertVon(z))]));
  }

  /* 4 — Ein einziger gestapelter Balken. Die Frage ist der ANTEIL: wie oft
     wird aus einer Ziehung ein Abend. Vier Zahlen nebeneinander beantworten
     das schlechter als ein Band, das man mit einem Blick teilt. */
  const LOS_TITEL = {
    zugesagt: 'zugesagt', abgelehnt: 'abgesagt',
    verfallen: 'verfallen', offen: 'offen',
  };
  const LOS_FARBE = {};
  const losFarbenSetzen = () => Object.assign(LOS_FARBE, {
    zugesagt: REIHE[0], abgelehnt: REIHE[2], verfallen: REIHE[5], offen: REIHE[1],
  });
  function bildBand(titel, daten) {
    const box = rahmen(titel);
    const summe = daten.reduce((a, z) => a + z.n, 0);
    if (!summe) return leer(box, 'Noch nicht gedreht.');
    const hoehe = 58;
    const svg = s_el('svg', { viewBox: `0 0 ${W} ${hoehe}`, role: 'img' });
    let x = 0;
    const breit = W - 2;
    const stuecke = [];
    daten.forEach(z => {
      const b = (z.n / summe) * breit;
      const r = s_el('rect', {
        x: x + 1, y: 6, width: Math.max(b, .5), height: 20,
        fill: LOS_FARBE[z.status] || REIHE[5],
      });
      svg.appendChild(r);
      stuecke.push({ z, r, von: x + 1, breite: Math.max(b, .5) });
      x += b;
    });
    /* Die Beschriftung darunter, nicht im Balken: bei einem Segment von zwei
       Prozent passt kein Wort hinein, und dann stünde es woanders als der
       Rest. Zwei Spalten zu je zwei Zeilen — vier Ausgänge gibt es, mehr
       kann `los.status` nicht annehmen. */
    daten.forEach((z, i) => {
      const t = s_el('text', {
        x: 2 + Math.floor(i / 2) * 108, y: 42 + (i % 2) * 12,
        'font-size': 9, fill: P.text,
      });
      // Der Punkt in der Farbe des Segments: sonst muss man raten, welcher
      // Streifen im Band zu welchem Wort gehört.
      const punkt = s_el('tspan', { fill: LOS_FARBE[z.status] || REIHE[5] });
      punkt.textContent = '● ';
      t.appendChild(punkt);
      t.appendChild(document.createTextNode(
        `${LOS_TITEL[z.status] || z.status}: ${zahl(z.n)}`));
      svg.appendChild(t);
    });

    /* Die Frage des Bildes ist der Anteil — und der stand als Zahl nirgends.
       Die Trefferfläche reicht über den Streifen hinaus nach oben und unten:
       20 Pixel Höhe im viewBox sind auf dem Handy ein schmaler Grat. */
    const umriss = s_el('rect',
      { y: 5, height: 22, fill: 'none', stroke: P.stark, 'stroke-width': 1, opacity: 0 });
    svg.appendChild(umriss);
    treffer(svg, stuecke.map(s => ({
      flaeche: s_el('rect', { x: s.von, y: 0, width: s.breite, height: 32 }),
      hervor: an => {
        umriss.setAttribute('opacity', an ? .55 : 0);
        umriss.setAttribute('x', s.von); umriss.setAttribute('width', s.breite);
      },
      inhalt: () => ({
        titel: LOS_TITEL[s.z.status] || s.z.status,
        zeilen: [
          { farbe: LOS_FARBE[s.z.status] || REIHE[5], was: 'Ziehungen', wert: zahl(s.z.n) },
          { was: 'Anteil', wert: Math.round((s.z.n / summe) * 100) + ' %' },
        ],
        fuss: zahl(summe) + ' Ziehungen insgesamt',
      }),
    })));
    box.appendChild(svg);
    // Der Anteil steht mit in der Tabelle: er ist die Frage, die dieses Bild
    // beantwortet, und im Band liest man ihn nur mit dem Auge ab.
    return tabelleAn(box, ['', 'Ziehungen', 'Anteil'],
      daten.map(z => [LOS_TITEL[z.status] || z.status, zahl(z.n),
        Math.round((z.n / summe) * 100) + ' %']));
  }

  /* 4b — Dasselbe je Melder: ein liegender Balken je Mensch, so lang wie er
     gezogen wurde, darin die Ausgänge in denselben Farben wie im Band
     darüber. Die Länge beantwortet „wen trifft es oft", die Aufteilung „und
     was macht er daraus" — zwei Bilder nebeneinander würden dieselbe Zeile
     zweimal suchen lassen. Die Zahl am Ende ist die Summe; die einzelnen
     Ausgänge stehen im Tooltip, denn in einen Streifen von vier Pixeln passt
     keine Ziffer.

     Der Tooltip hängt an der ZEILE, nicht am Segment. Vorher war es ein
     `<title>` je Segment: der Browser braucht dafür eine Sekunde, malt seinen
     eigenen grauen Kasten — und ein Streifen von vier Pixeln ist ohnehin
     nicht anzielbar. Jetzt zeigt eine Zeile alle vier Ausgänge auf einmal,
     was sowieso die Frage ist, die man an eine Zeile hat. */
  const LOS_ORDNUNG = ['zugesagt', 'abgelehnt', 'verfallen', 'offen'];
  function bildLosJeMelder(titel, daten) {
    const box = rahmen(titel);
    const zeilen = daten.filter(z => z.gezogen).slice(0, 8);
    if (!zeilen.length) return leer(box, 'Noch nicht gedreht.');
    const max = Math.max(...zeilen.map(z => z.gezogen), 1);
    const hoch = 15, luft = 5;
    const hoehe = Math.max(zeilen.length * (hoch + luft) + 6, 40);
    const svg = s_el('svg', { viewBox: `0 0 ${W} ${hoehe}`, role: 'img' });
    const lx = 66;                   // Platz für den Namen, wie beim Balkenbild
    const voll = W - lx - 22;        // Platz für den längsten Balken

    const reihen = [];   // je Zeile ihre Segmente, fürs Hervorheben
    zeilen.forEach((z, i) => {
      const y = i * (hoch + luft) + 3;
      const laenge = (z.gezogen / max) * voll;
      let x = lx;
      const meine = [];
      LOS_ORDNUNG.forEach(status => {
        const v = z[status] || 0;
        if (!v) return;
        const b = (v / z.gezogen) * laenge;
        const r = s_el('rect',
          { x, y, width: Math.max(b, .5), height: hoch, fill: LOS_FARBE[status] });
        svg.appendChild(r);
        meine.push(r);
        x += b;
      });
      reihen.push(meine);
      const n = s_el('text',
        { x: lx - 6, y: y + hoch - 4, 'text-anchor': 'end', 'font-size': 9.5, fill: P.text });
      n.textContent = z.name;
      svg.appendChild(n);
      const w = s_el('text',
        { x: lx + Math.max(laenge, 1) + 5, y: y + hoch - 4, 'font-size': 9.5, fill: P.textWeg });
      w.textContent = zahl(z.gezogen);
      svg.appendChild(w);
    });

    treffer(svg, zeilen.map((z, i) => ({
      flaeche: s_el('rect',
        { x: 0, y: i * (hoch + luft), width: W, height: hoch + luft }),
      hervor: an => reihen[i].forEach(r => r.setAttribute('opacity', an ? 1 : .82)),
      inhalt: () => ({
        titel: z.name,
        // Nur die Ausgänge zeigen, die es bei ihm gab: vier Zeilen, von denen
        // drei „0" sagen, sind drei Zeilen zuviel.
        zeilen: LOS_ORDNUNG.filter(st => z[st]).map(st => ({
          farbe: LOS_FARBE[st], was: LOS_TITEL[st], wert: zahl(z[st]),
        })),
        fuss: zahl(z.gezogen) + '× gezogen',
      }),
    })));
    // Der Grundzustand ist leicht gedeckt, damit das Hervorheben überhaupt
    // etwas zu tun hat.
    reihen.forEach(m => m.forEach(r => r.setAttribute('opacity', .82)));
    box.appendChild(svg);

    const leg = el('div', 'legende');
    LOS_ORDNUNG.forEach(status => {
      const s = el('span');
      const punkt = el('i');
      punkt.style.background = LOS_FARBE[status];
      s.appendChild(punkt);
      s.appendChild(document.createTextNode(LOS_TITEL[status]));
      leg.appendChild(s);
    });
    box.appendChild(leg);
    return tabelleAn(box,
      ['', 'gezogen', ...LOS_ORDNUNG.map(st => LOS_TITEL[st])],
      zeilen.map(z => [z.name, zahl(z.gezogen), ...LOS_ORDNUNG.map(st => zahl(z[st] || 0))]));
  }

  /* 5/6 — Gestapelte Säulen. Eine Woche (oder eine Mailart) je Säule, die
     Schichten übereinander. */
  function bildSaeulen(titel, gruppen, reihen, markeVon) {
    const box = rahmen(titel);
    if (!gruppen.length) return leer(box, 'Noch nichts eingetragen.');
    const summen = gruppen.map(g => reihen.reduce((a, r) => a + (g[r.feld] || 0), 0));
    const max = Math.max(...summen, 1);
    const svg = svgNeu();
    achse(svg, max);

    const platz = IX / gruppen.length;
    const breit = Math.min(platz * .62, 26);

    /* Der Wisch, der die angefasste Säule hinterlegt. Er wird VOR den Säulen
       gezeichnet: darüber gelegt trübt er genau die Farben ein, um die es
       gerade geht. */
    const hinterlegt = s_el('rect',
      { y: PAD.o, height: IY, fill: P.stark, opacity: 0, rx: 2, 'pointer-events': 'none' });
    svg.appendChild(hinterlegt);

    gruppen.forEach((g, i) => {
      let unten = PAD.o + IY;
      reihen.forEach((r, j) => {
        const v = g[r.feld] || 0;
        if (!v) return;
        const h = (v / max) * IY;
        unten -= h;
        svg.appendChild(s_el('rect', {
          x: PAD.l + platz * i + (platz - breit) / 2, y: unten,
          width: breit, height: h, fill: r.farbe,
        }));
      });
    });
    /* Beschriftet wird, was ohne Überlappung hingeht — sonst nur die erste
       und die letzte Säule. Bei zwanzig Wochen überlagern sich sonst alle
       und lesbar ist am Ende keine; bei fünf Meldern dagegen IST der Name
       unter der Säule die halbe Auskunft, und ein Bild, in dem drei von fünf
       Leuten anonym bleiben, beantwortet seine eigene Überschrift nicht.

       Die Breite wird geschätzt, nicht gemessen: `getComputedTextLength`
       zwänge zu einem Layout mitten im Zeichnen, und zwar je Bild einmal.
       4.4 ist die mittlere Zeichenbreite bei `font-size: 8` in dieser
       Schrift, großzügig gerundet — was knapp wird, fällt zurück auf zwei
       Marken statt sich zu berühren. */
    const marken = gruppen.map(markeVon);
    const alleMarken = marken.length > 1
      && marken.every(m => String(m).length * 4.4 <= platz - 3);
    if (alleMarken) {
      marken.forEach((m, i) =>
        beschriftung(svg, PAD.l + platz * (i + .5), H - 4, m));
    } else {
      beschriftung(svg, PAD.l + platz * .5, H - 4, marken[0]);
      if (marken.length > 1) {
        beschriftung(svg, PAD.l + platz * (marken.length - .5), H - 4,
          marken[marken.length - 1]);
      }
    }

    /* Und wo die Beschriftung ihre Lücke behält — bei vielen Säulen tragen
       nur die erste und die letzte eine —, springt der Kasten ein: er sagt,
       welche Woche das ist, und dazu jede Schicht einzeln, denn gestapelt
       lässt sich eine mittlere Schicht mit dem Auge nicht messen. */
    treffer(svg, gruppen.map((g, i) => ({
      flaeche: s_el('rect',
        { x: PAD.l + platz * i, y: PAD.o, width: platz, height: IY }),
      hervor: an => {
        hinterlegt.setAttribute('opacity', an ? .05 : 0);
        hinterlegt.setAttribute('x', PAD.l + platz * i);
        hinterlegt.setAttribute('width', platz);
      },
      inhalt: () => ({
        titel: markeVon(g),
        zeilen: reihen.map(r => ({
          farbe: r.farbe, was: r.titel, wert: zahl(g[r.feld] || 0),
        })),
        fuss: 'zusammen ' + zahl(summen[i]),
      }),
    })));
    box.appendChild(svg);

    const leg = el('div', 'legende');
    reihen.forEach(r => {
      const s = el('span');
      const punkt = el('i');
      punkt.style.background = r.farbe;
      s.appendChild(punkt);
      s.appendChild(document.createTextNode(r.titel));
      leg.appendChild(s);
    });
    box.appendChild(leg);
    // Die Summe hinten dran: gestapelt ist sie die Gesamthöhe der Säule, und
    // die ist die eine Zahl, die man an einem Stapel wirklich abliest.
    return tabelleAn(box, ['', ...reihen.map(r => r.titel), 'zusammen'],
      gruppen.map((g, i) => [markeVon(g),
        ...reihen.map(r => zahl(g[r.feld] || 0)), zahl(summen[i])]));
  }

  /* Was die Seiten benutzen. Alles andere ist Innerei — wer von aussen an
     `achse` oder `treffer` muss, hat sich die Frage falsch gestellt. */
  return {
    aufsetzen,
    flaeche:     bildFlaeche,
    schar:       bildSchar,
    grad:        bildGrad,
    liegend:     bildLiegend,
    band:        bildBand,
    losJeMelder: bildLosJeMelder,
    saeulen:     bildSaeulen,
    funke,
    tippAm,
    // Zumachen, bevor die Seite neu zeichnet: der Kasten zeigte sonst gleich
    // auf einen Punkt, den es nicht mehr gibt.
    tippZu: () => { tipFest = false; tipAus(); },
    get reihe() { return REIHE; },
  };
})();
