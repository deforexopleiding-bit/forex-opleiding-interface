// api/_lib/iris/verzonden-map.js
//
// Een kopie van wat we versturen in de map Verzonden zetten.
//
// ── HET GAT DAT DIT DICHT ────────────────────────────────────────────────────
// Onze uitgaande mail gaat via Strato's SMTP en belandt daarmee nergens in de
// mailbox zelf. Ze staat alleen in email_replies, in ons eigen systeem. Wie in
// Thunderbird kijkt, of op zijn telefoon, ziet zijn eigen antwoord niet — en
// bij een klantgesprek waar twee mensen aan werken is dat een gat waar dingen
// doorheen vallen. Iemand antwoordt een tweede keer omdat hij denkt dat het
// eerste antwoord nooit weg is.
//
// Gat G7 in docs/iris/02-gesprekken-audit.md.
//
// ── WAAROM ALLEEN IRIS DIT DOET, EN NIET IEDEREEN ────────────────────────────
// De verleiding is om dit in send-email-core.js te zetten, want dan geldt het
// meteen voor alles. Dat is precies waarom het hier staat en niet daar:
// send-email-core.js wordt door de aanmaanmotor gebruikt, en die hoort van
// deze verandering niets te merken. Een IMAP-verbinding openen kost een paar
// seconden, en een bulkronde die per bericht een verbinding opzet is een
// bulkronde die de tijdsgrens haalt in plaats van het werk.
//
// Zodra dit zich bewezen heeft, kan het naar de gedeelde laag. Dat is een
// latere, losse opruiming — geen bijvangst van deze bouw.
//
// ── FAALZACHT, EN ECHT FAALZACHT ─────────────────────────────────────────────
// De mail is al verstuurd op het moment dat deze functie draait. Gaat het
// neerzetten van de kopie mis, dan is dat vervelend maar verandert het niets
// aan wat de klant kreeg. Deze functie gooit dus nooit en geeft alleen terug
// of het gelukt is.

import { ImapFlow } from 'imapflow';

/** Per mailbox de omgevingsvariabele met het wachtwoord. Spiegelt send-email-core.js. */
const WACHTWOORDEN = {
  'leads@deforexopleiding.nl': 'IMAP_PASS',
  'info@deforexopleiding.nl': 'IMAP_PASS_INFO',
  'partners@deforexopleiding.nl': 'IMAP_PASS_PARTNERS',
  'administratie@deforexopleiding.nl': 'IMAP_PASS_ADMINISTRATIE',
  'onboarding@deforexopleiding.nl': 'IMAP_PASS_ONBOARDING',
  'events@deforexopleiding.nl': 'IMAP_PASS_EVENTS',
  'welkom@deforexopleiding.nl': 'IMAP_PASS_WELKOM',
};

/**
 * Namen die een Verzonden-map kan hebben.
 *
 * Strato heet hem 'Sent'; een Nederlandstalige instelling maakt er 'Verzonden'
 * van, een Duitstalige 'Gesendet'. In plaats van gokken zoeken we de map op die
 * bestaat, en gebruiken we de bijzondere aanduiding \Sent als de server die
 * meegeeft.
 */
export const VERZONDEN_NAMEN = Object.freeze([
  'Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages',
  'Verzonden', 'INBOX.Verzonden', 'Verzonden items',
  'Gesendet', 'INBOX.Gesendet',
]);

/**
 * Kies de map waar de kopie heen moet.
 *
 * Zuiver, zodat te testen is welke map er gekozen wordt zonder een
 * IMAP-server. De bijzondere aanduiding wint altijd van een naam: die komt van
 * de server zelf en is niet afhankelijk van de taalinstelling.
 *
 * @param {Array<{path: string, specialUse?: string, name?: string}>} mappen
 * @returns {string|null}
 */
export function kiesVerzondenMap(mappen) {
  const lijst = Array.isArray(mappen) ? mappen.filter(Boolean) : [];
  if (!lijst.length) return null;

  const bijzonder = lijst.find((m) => m.specialUse === '\\Sent');
  if (bijzonder) return bijzonder.path;

  for (const naam of VERZONDEN_NAMEN) {
    const gevonden = lijst.find((m) => String(m.path || '').toLowerCase() === naam.toLowerCase());
    if (gevonden) return gevonden.path;
  }

  // Laatste poging: een map waarvan het laatste stuk van het pad op een
  // verzonden-naam lijkt. Sommige servers hangen alles onder een voorvoegsel.
  const kaal = new Set(VERZONDEN_NAMEN.map((n) => n.toLowerCase().split('.').pop()));
  const bijnaam = lijst.find((m) => kaal.has(String(m.path || '').toLowerCase().split(/[./]/).pop()));
  return bijnaam ? bijnaam.path : null;
}

/**
 * Bouw het rauwe RFC822-bericht dat in de map komt.
 *
 * Een bewust eenvoudige opbouw: platte tekst, UTF-8, quoted-printable vermeden
 * door base64 te gebruiken. Dat laatste is geen luxe — een accent in een
 * Nederlandse zin dat verkeerd gecodeerd de map in gaat, leest als rommel en
 * ondermijnt precies het vertrouwen dat deze kopie moet geven.
 */
export function bouwRfc822({ van, naar, onderwerp, tekst, messageId, datum = new Date(), inReplyTo = null }) {
  const regels = [
    `From: ${van}`,
    `To: ${Array.isArray(naar) ? naar.join(', ') : naar}`,
    `Subject: ${codeerKop(onderwerp || '')}`,
    `Date: ${datum.toUTCString()}`,
  ];
  if (messageId) regels.push(`Message-ID: ${messageId}`);
  if (inReplyTo) {
    regels.push(`In-Reply-To: ${inReplyTo}`);
    regels.push(`References: ${inReplyTo}`);
  }
  regels.push('MIME-Version: 1.0');
  regels.push('Content-Type: text/plain; charset=UTF-8');
  regels.push('Content-Transfer-Encoding: base64');
  regels.push('');
  regels.push(Buffer.from(String(tekst || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'));
  return regels.join('\r\n');
}

/**
 * Codeer een onderwerp dat niet-ASCII bevat.
 *
 * Zonder dit staat er "Vraag over je factuur â€" bedrag" in de map. Technisch
 * werkt de mail dan nog; leesbaar is hij niet.
 */
export function codeerKop(tekst) {
  const s = String(tekst || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * Zet een kopie in de map Verzonden.
 *
 * @returns {Promise<{ok: boolean, map?: string, reden?: string}>}
 */
export async function zetInVerzonden({ mailbox, naar, onderwerp, tekst, messageId, inReplyTo = null }) {
  let rauw;
  try {
    rauw = bouwRfc822({ van: mailbox, naar, onderwerp, tekst, messageId, inReplyTo });
  } catch (e) {
    return { ok: false, reden: e?.message || 'bericht niet op te bouwen' };
  }
  return zetRauwInVerzonden({ mailbox, rauw });
}

/**
 * Zet een KANT-EN-KLAAR bericht in de map Verzonden.
 *
 * Het verschil met zetInVerzonden(): daar bouwen we zelf een eenvoudig
 * platte-tekstbericht, hier krijgen we de bytes aangereikt. Dat is wat
 * api/send-email.js nodig heeft — die mail kan opmaak, kopieontvangers en
 * bijlagen hebben, en een kopie die dat alles kwijt is, is een kopie die
 * liegt over wat je verstuurd hebt.
 *
 * Deze functie was eerst alleen voor Iris. Ze is het nu niet meer: het gat dat
 * ze dicht (G7) zit in de gewone antwoordknop net zo goed. Het bestand mag bij
 * een volgende opruiming naar de gedeelde laag; dat is geen bijvangst van deze
 * bouw.
 *
 * Gooit nooit. De mail is op het moment dat dit draait al verstuurd.
 *
 * @returns {Promise<{ok: boolean, map?: string, reden?: string}>}
 */
export async function zetRauwInVerzonden({ mailbox, rauw, vlaggen = ['\\Seen'] }) {
  const wachtwoordVar = WACHTWOORDEN[String(mailbox || '').toLowerCase()];
  if (!wachtwoordVar) {
    return { ok: false, reden: `onbekende mailbox: ${mailbox}` };
  }
  const wachtwoord = process.env[wachtwoordVar];
  const host = process.env.IMAP_HOST;
  if (!wachtwoord || !host) {
    // Alleen de NAAM van de ontbrekende variabele, nooit de waarde.
    return { ok: false, reden: `ontbreekt in omgeving: ${!host ? 'IMAP_HOST' : wachtwoordVar}` };
  }
  if (!rauw || (typeof rauw !== 'string' && !Buffer.isBuffer(rauw))) {
    return { ok: false, reden: 'geen bericht om neer te zetten' };
  }

  let client;
  try {
    client = new ImapFlow({
      host,
      port: parseInt(process.env.IMAP_PORT || '993', 10),
      secure: true,
      auth: { user: mailbox, pass: wachtwoord },
      logger: false,
      socketTimeout: 15_000,
    });
    await client.connect();

    const mappen = await client.list();
    const doel = kiesVerzondenMap(mappen);
    if (!doel) {
      return { ok: false, reden: 'geen map Verzonden gevonden' };
    }

    await client.append(doel, rauw, vlaggen);
    return { ok: true, map: doel };
  } catch (e) {
    // De mail is op dit moment al verstuurd. Dit mislukken verandert niets aan
    // wat de klant kreeg, dus het is een waarschuwing en geen fout.
    console.warn('[iris/verzonden-map] kopie niet neergezet:', e?.message || e);
    return { ok: false, reden: e?.message || 'onbekende fout' };
  } finally {
    try { if (client) await client.logout(); } catch (_) { /* verbinding al weg */ }
  }
}
