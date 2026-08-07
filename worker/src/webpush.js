/* ===========================================================================
   Web-Push: die Nachricht aufs Geraet.

   Zwei Dinge stecken hier drin, und beide sind Vorschrift, nicht Geschmack:

   1. VAPID (RFC 8292) - der Ausweis des Absenders. Ein signiertes JWT, mit dem
      sich dieser Worker beim Push-Dienst (Google, Apple, Mozilla) als der
      ausweist, fuer den das Geraet einmal ein Abo angelegt hat.
   2. Die Verschluesselung der Nutzlast (RFC 8291, "aes128gcm"). Der
      Push-Dienst ist ein Zwischenhaendler, der die Nachricht weiterreicht -
      lesen darf er sie nicht. Verschluesselt wird gegen die zwei Schluessel,
      die der Browser beim Abonnieren mitgegeben hat (`p256dh` und `auth`).

   Alles in purem WebCrypto, ohne eine einzige Abhaengigkeit: dieses Projekt
   hat bewusst keine `node_modules`, und die ueblichen Pakete (`web-push`)
   bringen einen halben Kryptobaukasten mit, von dem hier 150 Zeilen gebraucht
   werden.

   GEPRUEFT gegen das Rechenbeispiel in RFC 8291 Abschnitt 5 samt der
   Zwischenwerte aus Anhang A - Byte fuer Byte, mit festem Salz und festen
   Schluesselpaaren. Das Skript dazu liegt in `ideas/pruefungen/`. Wer hier
   etwas aendert, laesst es noch einmal laufen: eine falsch gesetzte Null in
   einer der Info-Zeichenketten faellt sonst erst am Geraet auf, und dort als
   "kommt halt nichts an".
   =========================================================================== */

const enc = new TextEncoder();

// base64url in beide Richtungen. Ohne Polster ("="), wie es die Push-Dienste
// und der Browser tun.
const ausB64 = roh => {
  const s = String(roh).replace(/-/g, '+').replace(/_/g, '/');
  const b = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const raus = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) raus[i] = b.charCodeAt(i);
  return raus;
};

const inB64 = bytes => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const zusammen = (...teile) => {
  const gesamt = teile.reduce((n, t) => n + t.length, 0);
  const raus = new Uint8Array(gesamt);
  let wo = 0;
  for (const t of teile) { raus.set(t, wo); wo += t.length; }
  return raus;
};

/* HKDF (RFC 5869) in einem Aufruf - WebCrypto macht Extract und Expand
   zusammen. Beide Ableitungen unten sind genau das: Salz, Ausgangsmaterial,
   Info, Laenge. */
async function hkdf(salz, material, info, laenge) {
  const k = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salz, info }, k, laenge * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// 1. Die Nutzlast verschluesseln (RFC 8291)
// ---------------------------------------------------------------------------
/* Genau EIN Record. Die Aufteilung in mehrere waere fuer eine Meldung mit
   Titel und zwei Zeilen Text Aufwand ohne Gegenwert; dafuer muss die Nutzlast
   unter die Satzgroesse passen (4096 minus Kopf, Marke und Fuellzeichen -
   praktisch unter 3.800 Byte). Was hier reingegeben wird, ist ein
   JSON-Objekt aus vier kurzen Feldern; das reicht mit grossem Abstand.

   `pruefSalz` und `pruefPaar` gibt es nur fuer die Pruefung gegen den RFC:
   im Betrieb ist das Salz zufaellig und das Absenderpaar frisch je Nachricht,
   und beides MUSS es sein - ein zweites Mal dasselbe Salz mit demselben
   Schluessel macht AES-GCM angreifbar. */
export async function verschluesseln(abo, klartext, pruefSalz = null, pruefPaar = null) {
  const empfaengerRoh = ausB64(abo.p256dh);        // 65 Byte, unkomprimiert
  const auth = ausB64(abo.auth);                   // 16 Byte

  const empfaenger = await crypto.subtle.importKey(
    'raw', empfaengerRoh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const paar = pruefPaar || await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const absenderRoh = new Uint8Array(await crypto.subtle.exportKey('raw', paar.publicKey));

  // Das gemeinsame Geheimnis der beiden Schluesselpaare. 32 Byte.
  const gemeinsam = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: empfaenger }, paar.privateKey, 256));

  /* Der Handschlag mit dem Auth-Geheimnis. Die Null hinter "WebPush: info"
     gehoert dazu (Info-Zeichenketten sind hier nullterminiert), und die
     Reihenfolge der beiden Schluessel ist EMPFAENGER-dann-ABSENDER. Wer sie
     vertauscht, bekommt ein Ergebnis, das ueberall durchlaeuft und beim
     Geraet still verworfen wird. */
  const keyInfo = zusammen(enc.encode('WebPush: info\0'), empfaengerRoh, absenderRoh);
  const ikm = await hkdf(auth, gemeinsam, keyInfo, 32);

  const salz = pruefSalz || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salz, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salz, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  /* Der Kopf nach RFC 8188: Salz (16), Satzgroesse (4, gross zuerst), Laenge
     der Schluesselkennung (1), die Kennung selbst - hier der oeffentliche
     Schluessel des Absenders (65). Zusammen 86 Byte, und sie reisen
     unverschluesselt mit: der Empfaenger braucht sie zum Entschluesseln. */
  const kopf = zusammen(
    salz,
    new Uint8Array([0, 0, 0x10, 0x00]),          // 4096
    new Uint8Array([absenderRoh.length]),        // 65
    absenderRoh,
  );

  // Das Fuellzeichen 0x02 heisst "letzter Record". Ohne es wirft der Browser
  // die Nachricht weg.
  const inhalt = zusammen(enc.encode(klartext), new Uint8Array([2]));
  const schluessel = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const geheim = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, schluessel, inhalt));

  return zusammen(kopf, geheim);
}

// ---------------------------------------------------------------------------
// 2. Der Ausweis (VAPID, RFC 8292)
// ---------------------------------------------------------------------------
/* Der importierte Signierschluessel bleibt im Isolat liegen: er aendert sich
   nie, und ein `importKey` je Meldung waere bei einem Notruf an sechs Leute
   sechsmal dieselbe Arbeit. Der Schluessel selbst (die JWK-Zeichenkette) ist
   der Schluessel des Caches - taeuscht man ihn aus, faellt der Cache von
   selbst weg. */
let signierer = null;

async function signierSchluessel(geheim) {
  if (signierer && signierer.roh === geheim) return signierer.key;
  const jwk = JSON.parse(geheim);
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  signierer = { roh: geheim, key };
  return key;
}

/* Das JWT gilt zwoelf Stunden und haengt nur am Ziel-Dienst - fuer alle
   Meldungen an dieselbe Herkunft ist es dasselbe. Ein Notruf an sechs Leute
   mit fuenf Geraeten waere sonst elf Signaturen fuer eine Auskunft.

   `aud` ist Schema und Host des Endpoints, NIE der Pfad: der Pfad ist die
   Geraeteadresse und hat in einem Ausweis nichts zu suchen. */
const ausweise = new Map();

export async function vapidKopf(env, endpoint) {
  const wohin = new URL(endpoint).origin;
  const jetzt = Math.floor(Date.now() / 1000);
  const liegt = ausweise.get(wohin);
  // Eine Stunde Sicherheitsabstand: ein Ausweis, der unterwegs ablaeuft, ist
  // ein 401 ohne Wiederholung.
  if (liegt && liegt.exp - 3600 > jetzt) return liegt.kopf;

  const kopfTeil = inB64(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const exp = jetzt + 12 * 3600;
  /* `sub` sagt dem Push-Dienst, wen er anrufen kann, wenn dieser Absender
     Unsinn schickt. `MELDE_AN` ist die Adresse des Betreibers und liegt schon
     als Secret. Fehlt sie - lokal ist das der Normalfall -, steht hier die
     Adresse der Tafel: eine `mailto:undefined` weisen FCM und Apple ab, und
     dann kaeme die Meldung nirgends an. */
  const wer = env.MELDE_AN ? `mailto:${env.MELDE_AN}` : (env.SEITE || 'https://example.invalid');
  const rumpfTeil = inB64(enc.encode(JSON.stringify({ aud: wohin, exp, sub: wer })));
  const zuSignieren = enc.encode(`${kopfTeil}.${rumpfTeil}`);

  /* WebCrypto liefert die ECDSA-Signatur bereits als r‖s, 64 Byte roh - genau
     das, was JWS will. Der Umweg ueber DER, den die meisten Anleitungen
     zeigen, gilt fuer OpenSSL und waere hier ein Fehler. */
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await signierSchluessel(env.VAPID_PRIVAT),
    zuSignieren));

  const kopf = `vapid t=${kopfTeil}.${rumpfTeil}.${inB64(sig)}, k=${env.VAPID_PUBLIK}`;
  ausweise.set(wohin, { exp, kopf });
  return kopf;
}

// ---------------------------------------------------------------------------
// 3. Abschicken
// ---------------------------------------------------------------------------
// Ohne beide Haelften des Schluesselpaars geht gar nichts - dann bleibt Push
// einfach aus, und `GET /api/health` sagt warum. Kein Fehler, ein Zustand.
export const pushBereit = env => !!(env && env.VAPID_PRIVAT && env.VAPID_PUBLIK);

/* Wirft nicht. Ein Push ist eine Beigabe zur Mail, und keine Zusage darf
   daran scheitern, dass Apple gerade 503 sagt.

   `status` 404 oder 410 heisst: dieses Abo ist tot (App geloescht, Browser
   zurueckgesetzt, Endpoint rotiert). Der AUFRUFER loescht die Zeile dann -
   hier steht keine Datenbank, damit diese Datei nur eines kann. */
export async function pushSenden(env, abo, nutzlast, ttlSekunden, dringend = false) {
  if (!pushBereit(env)) return { ok: false, status: 0 };
  try {
    const koerper = await verschluesseln(abo, JSON.stringify(nutzlast));
    const r = await fetch(abo.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': await vapidKopf(env, abo.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(Math.max(0, Math.round(ttlSekunden))),
        /* `high` weckt das Geraet auch aus dem Stromsparen. Das ist ein
           Versprechen, das man nicht bei jeder Kleinigkeit gibt - es gilt
           dem Los und dem Notruf, nicht der Terminverschiebung. */
        'Urgency': dringend ? 'high' : 'normal',
      },
      body: koerper,
    });
    if (!r.ok && r.status !== 404 && r.status !== 410) {
      console.error(`Push ${r.status} an ${new URL(abo.endpoint).host}`);
    }
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error('pushSenden:', e && e.message || e);
    return { ok: false, status: 0 };
  }
}
