// ===========================================================================
// EPC-QR (Girocode, EPC069-12) und die übrigen Zahlwege (Schema 36, Etappe 5).
//
// Eigener Code, getrennt von der vendorten Bibliothek in `qr.js` - die
// Lizenztrennung soll an der Dateigrenze sichtbar bleiben, nicht im Diff
// verschwimmen.
//
// WARUM VERSION '002', NIE '001' (Opus-Konsultation vor der Festlegung,
// 2026-08-11). '001' verlangt die BIC als Pflichtfeld, '002' laesst sie leer.
// `zahlweg` (Migration 0036) hat keine BIC-Spalte - die Wahl ist damit keine
// Design-Entscheidung hier im Encoder, sondern eine erzwungene Folge des
// Schemas, siehe auch der Kommentar dort.
//
// WARUM DIE NUTZLAST MAX. 331 BYTES TRAEGT. Bei Fehlerkorrekturstufe M
// (von der EPC-Spezifikation vorgeschrieben, §2.1) ist Version 13 (69x69
// Module) die groesste, die dieser Encoder zulaesst (siehe `qrSvg()` unten,
// `maxVersion=13` - eine bewusste Deckelung, kein Versehen). Ihre
// Byte-Kapazitaet bei Byte-Modus ist der harte Rand, gegen den die Kuerzung
// unten laeuft.
// ===========================================================================

import { QrCode, QrSegment } from './qr.js';

const EPC_VERSION = '002';
const EPC_ZEICHENSATZ = '1'; // UTF-8 - die Spezifikation erlaubt es ausdruecklich, ihr eigenes Beispiel heisst "Mustermänn"
const EPC_ID = 'SCT';
const EPC_INHABER_MAX = 70;   // Zeichen, Spezifikationsgrenze fuer den Empfaengernamen
const EPC_ZWECK_MAX = 140;    // Zeichen, Spezifikationsgrenze fuer die unstrukturierte Verwendungszweck-Info
const EPC_NUTZLAST_MAX_BYTES = 331; // Kapazitaetsdeckel bei ECC M / Version <= 13, siehe Kopf oben
// Das erste Wort jedes Verwendungszwecks. Steht hier und nicht in `zweckBauen`,
// weil `epcNutzlast` es beim Kuerzen braucht - eine Wahrheit, zwei Leser.
const EPC_ZWECK_PRAEFIX = 'BeerStock';

const ZAHLWEG_ARTEN = ['paypal', 'bank', 'wero', 'bar'];
const ZAHLWEG_TITEL = { paypal: 'PayPal', bank: 'Überweisung', wero: 'Wero', bar: 'Bar' };

/* Zeilenumbrueche und Tabs werden zu Leerzeichen, jedes weitere
   Steuerzeichen (Codepoint < 32 oder = 127) faellt ganz weg - ueber eine
   Codepoint-Schleife statt eines Regex-Zeichenbereichs, der Steuerzeichen
   selbst enthalten muesste. Nicht kosmetisch: ein Zeilenumbruch in einem
   freien Textfeld (Inhaber, Gruppenname) wuerde sonst eine ZEILE der
   EPC-Nutzlast verschieben und liesse sich als IBAN-Spoof missbrauchen (ein
   Gruppenadmin koennte eine fremde IBAN in die IBAN-Zeile schieben). Diese
   Funktion ist die einzige Stelle, die das tut - jeder Aufrufer unten geht
   hier durch, keine zweite Kopie. */
function saeubern(text) {
  const ohneUmbruch = String(text ?? '').split(/[\r\n\t]/).join(' ');
  let ergebnis = '';
  for (const zeichen of ohneUmbruch) {
    const code = zeichen.codePointAt(0);
    if (code >= 32 && code !== 127) ergebnis += zeichen;
  }
  return ergebnis.split(/\s+/).join(' ').trim();
}

function ibanNormalisieren(roh) {
  return String(roh ?? '').split(/\s+/).join('').toUpperCase();
}

// Pruefziffer nach ISO 7064 (MOD 97-10) - Ziffer fuer Ziffer ueber die
// umgestellte IBAN, kein BigInt noetig: der laufende Rest bleibt immer
// unter 970 und passt in eine normale Zahl.
function ibanGueltig(iban) {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const umgestellt = iban.slice(4) + iban.slice(0, 4);
  const ziffern = umgestellt.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const z of ziffern) rest = (rest * 10 + Number(z)) % 97;
  return rest === 1;
}

const bytesLaenge = text => new TextEncoder().encode(text).length;

/* Der Verwendungszweck - EIN Ausdruck fuer jeden Aufrufer (die
   Wiederkehrende-Fallen-Lehre aus Etappe 3/4: `naechster_preis` und
   `SALDO_ZEILEN_SQL` drifteten beide auseinander, weil sie an zwei Stellen
   standen). Passt der volle Text nicht in die 140-Zeichen-Grenze, wird ZUERST
   der Gruppenname gekuerzt - der Mitgliedsname muss ueberleben, er ist der
   Zweck des Zwecks (der Admin sortiert danach im Kontoauszug). */
function zweckBauen(gruppenName, monatSchluessel, personName) {
  const praefix = EPC_ZWECK_PRAEFIX;
  const name = saeubern(personName);
  let gruppe = saeubern(gruppenName);

  const fixLaenge = praefix.length + 3 /* drei Leerzeichen zwischen vier Teilen */
    + monatSchluessel.length + name.length;
  const gruppeMax = Math.max(0, EPC_ZWECK_MAX - fixLaenge);
  if (gruppe.length > gruppeMax) gruppe = gruppe.slice(0, gruppeMax).trim();

  let zweck = [praefix, gruppe, monatSchluessel, name].join(' ').split(/\s+/).join(' ').trim();
  if (zweck.length > EPC_ZWECK_MAX) zweck = zweck.slice(0, EPC_ZWECK_MAX).trim();
  return zweck;
}

/* Die zwoelf-zeilige EPC-Nutzlast (elf Elemente, davon eines - Beneficiary-
   to-Originator - grundsaetzlich weggelassen, siehe Spezifikationsbeispiele).
   Zehn Zeilenumbrueche, KEIN abschliessender. Zeichensatz und Version wie
   oben begruendet, Zweck-Code und strukturierte Referenz bleiben leer - sie
   sind zum unstrukturierten Verwendungszweck exklusiv (EPC069-12,
   "Or"-Feld), und dieser Encoder fuellt ausschliesslich den
   unstrukturierten. */
export function epcNutzlast({ inhaber, iban, centBetrag, zweck }) {
  // Zeichenweise (nicht codeeinheitenweise) kuerzen, an BEIDEN Feldern:
  // `.slice()` auf dem rohen String schneidet nach UTF-16-Codeeinheiten und
  // koennte ein Surrogatpaar genau an der Grenze zerreissen (ein einzelnes
  // uebrig gebliebenes Surrogat kodiert TextEncoder als U+FFFD, kein
  // Absturz, aber ein falsches Zeichen in der Nutzlast). `Array.from()`
  // zaehlt zuerst in echte Zeichen um, danach ist das Schneiden sicher.
  const inhaberGekuerzt = Array.from(saeubern(inhaber)).slice(0, EPC_INHABER_MAX).join('');
  const ibanRein = ibanNormalisieren(iban);
  const betrag = 'EUR' + (centBetrag / 100).toFixed(2);
  let zweckZeichen = Array.from(saeubern(zweck)).slice(0, EPC_ZWECK_MAX);

  const bauen = () => [
    'BCD', EPC_VERSION, EPC_ZEICHENSATZ, EPC_ID,
    '', // BIC - Version 002 laesst sie leer, siehe Kopf
    inhaberGekuerzt, ibanRein, betrag,
    '', // Zweck-Code
    '', // strukturierte Referenz
    zweckZeichen.join(''),
  ].join('\n');

  /* Reicht die Byte-Kapazitaet nicht, wird der Zweck gekuerzt - und zwar VON
     VORN, hinter dem Praefix, nicht vom Ende her. Der Zweck ist "BeerStock
     <Gruppe> <Monat> <Name>", und hinten steht das Wichtigste: `zweckBauen`
     kuerzt aus demselben Grund zuerst den Gruppennamen ("er ist der Zweck des
     Zwecks - der Admin sortiert danach im Kontoauszug"). Ein Pop vom Ende
     naehme genau die andere Reihenfolge und liesse eine Ueberweisung ankommen,
     die niemand mehr zuordnen kann.

     WANN DAS UEBERHAUPT GREIFT: nachgemessen liegt der reine ASCII-Vollausbau
     - Inhaber auf 70, Zweck auf 140 Zeichen - bei 264 von 331 Bytes, der
     Alltagsfall ("BeerStock Die Nachtschicht 2026-08 Matthias Schneider") bei
     121. Die Schleife laeuft erst an, wenn beide Textfelder in UTF-8 deutlich
     mehr Bytes als Zeichen brauchen (CJK, Emoji, oder siebzig Umlaute am
     Stueck: 330 Bytes, und der Zweck steht dann bei 68 Zeichen). Sie ist ein
     Netz, kein Regelweg.

     Der Preis dafuer, und er ist bewusst bezahlt: `GET /api/zahlwege` gibt den
     UNGEKUERZTEN Zweck aus (dort gibt es keine IBAN, gegen die man rechnen
     koennte - eine Gruppe kann mehrere Bankwege haben). Im Ausnahmefall traegt
     der QR damit eine kuerzere Referenz als die Zeile zum Abtippen daneben.
     Beide beginnen gleich und enden gleich; auseinander gehen sie nur im
     Gruppennamen in der Mitte, und der ist der Teil, den beim Zuordnen ohnehin
     niemand braucht. */
  const schutz = Array.from(EPC_ZWECK_PRAEFIX).length + 1; // Praefix und das Leerzeichen dahinter
  let text = bauen();
  while (bytesLaenge(text) > EPC_NUTZLAST_MAX_BYTES && zweckZeichen.length > 0) {
    // Ist nur noch das Praefix da, faellt auch das - sonst endete die Schleife nie.
    zweckZeichen.splice(zweckZeichen.length > schutz ? schutz : 0, 1);
    text = bauen();
  }
  return text;
}

/* Der QR selbst - ECC-Stufe M FEST, wie die Spezifikation es vorschreibt
   (kein Verlassen auf einen Bibliotheks-Default), `boostEcl=false` (sie darf
   sich nicht selbst auf eine hoehere Stufe hochziehen), Version gedeckelt auf
   13 (69x69 Module, die EPC-Obergrenze). Vier Module Ruhezone rundum -
   fehlt sie, liest kein Handy den Code, auch wenn die Module selbst korrekt
   sind. */
export function qrSvg(nutzlast) {
  const seg = QrSegment.makeBytes(new TextEncoder().encode(nutzlast));
  const qr = QrCode.encodeSegments([seg], QrCode.Ecc.MEDIUM, 1, 13, -1, false);
  const rand = 4;
  const groesse = qr.size + rand * 2;
  let pfad = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) pfad += `M${x + rand},${y + rand}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${groesse} ${groesse}" shape-rendering="crispEdges">`
    + `<rect width="${groesse}" height="${groesse}" fill="#fff"/>`
    + `<path d="${pfad}" fill="#000"/>`
    + `</svg>`;
}

// Nimmt eine volle paypal.me-URL ODER nur die Kennung entgegen - der
// Gruppenadmin darf beides eintragen. Ohne Betrag (Pflege-Ansicht in
// `gruppe.html`, kein Saldo im Kontext) bleibt der Link ohne Summe.
function paypalLink(wert, centBetrag) {
  let kennung = String(wert || '').trim();
  const treffer = kennung.match(/paypal\.me\/([^/?#\s]+)/i) || kennung.match(/paypalme\/([^/?#\s]+)/i);
  if (treffer) kennung = treffer[1];
  kennung = kennung.replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  if (!kennung) return null;
  const basis = `https://www.paypal.com/paypalme/${encodeURIComponent(kennung)}`;
  if (centBetrag == null) return basis;
  return `${basis}/${(centBetrag / 100).toFixed(2)}EUR`;
}

/* EIN Aufbereiter fuer beide Aufrufer (die `?g=`-Pflegeansicht ohne Saldo
   UND die `?saldo=`-Zahlansicht) - dieselbe Lehre wie `SALDO_ZEILEN_SQL`:
   zwei Kopien drifteten in Etappe 4 auseinander, eine geteilte Funktion
   kann das nicht mehr. `offenCent`/`saldoId` bleiben `null` in der
   Pflegeansicht - dort gibt es keinen Betrag und keinen QR. */
export function wegeAufbereiten(zeilen, { offenCent = null, saldoId = null } = {}) {
  return zeilen.map(z => {
    // Kein eigenes `kopieren`-Feld: die Seiten kennen `art` ohnehin (sie
    // entscheiden danach, welcher Knopf erscheint) und lesen bei 'wero'/
    // 'bank' schlicht `wert` - ein zweites Feld mit demselben Inhalt wäre
    // eine Wahrheit an zwei Stellen.
    const basis = {
      id: z.id, art: z.art, titel: ZAHLWEG_TITEL[z.art], wert: z.wert,
      inhaber: z.art === 'bank' ? z.inhaber : null,
      link: null, qr: null,
    };
    if (z.art === 'paypal') basis.link = paypalLink(z.wert, offenCent);
    if (z.art === 'bank' && saldoId && offenCent > 0) {
      basis.qr = `/api/zahlung/qr.svg?saldo=${saldoId}&weg=${z.id}`;
    }
    return basis;
  });
}

export { saeubern, ibanNormalisieren, ibanGueltig, zweckBauen, ZAHLWEG_ARTEN };
