// services/whatsapp-brug/lib/gebeurtenis.js
//
// Welke webhook-gebeurtenis levert een WhatsApp-bericht op? Los van de client
// en zonder één dependency, zodat het te testen is zonder puppeteer, Chromium
// of een gekoppelde telefoon.
//
// De privacy-beslissing zit HIER NIET in. Die staat in whatsapp.js, vóór deze
// functies worden aangeroepen — eerst leadlijst.mag(), dan pas iets bouwen. Zo
// is er geen pad waarlangs een bericht van een privécontact ook maar in een
// object terechtkomt.

/** Ack-codes van whatsapp-web.js naar iets leesbaars. -1 en 0 leveren niets op. */
export const ACK_SOORT = { 1: 'verzonden', 2: 'afgeleverd', 3: 'gelezen', 4: 'gelezen' };

/** Types die WhatsApp gebruikt voor een ingesproken bericht. */
export const SPRAAK_TYPES = new Set(['ptt', 'audio']);

/** Is dit een groepsgesprek? Daar zitten per definitie onbekenden in. */
export function isGroep(jid) {
  return typeof jid === 'string' && jid.includes('@g.us');
}

/**
 * Een bericht dat Dave zelf verstuurt.
 *
 * Alleen fromMe: inkomend loopt via het 'message'-event. Groepen vallen af.
 *
 * GEEN BERICHTTEKST. Voor deze meting hoeven we alleen te weten dát er iets
 * uitging en of het ingesproken was. De tekst van wat Dave naar een lead
 * stuurt is gevoeliger dan nodig, dus die verlaat de telefoon niet.
 *
 * Het tijdstip komt uit msg.timestamp — het moment van versturen. De
 * ack-gebeurtenissen weten dat niet; die kennen alleen het moment waarop de
 * bevestiging binnenkwam, en dat kan uren later zijn. Voor een deadline van
 * 09:00 is dat verschil het hele verhaal.
 */
export function bouwUitgaandeGebeurtenis(msg, nu = Date.now()) {
  if (!msg || msg.fromMe !== true) return null;
  const naar = msg.to;
  if (!naar || isGroep(naar)) return null;
  const seconden = Number(msg.timestamp);
  return {
    soort     : 'uitgaand',
    jid       : naar,
    tijdstip  : new Date(Number.isFinite(seconden) && seconden > 0 ? seconden * 1000 : nu).toISOString(),
    media_type: msg.type || null,
    bericht_id: msg.id?._serialized || null,
  };
}

/**
 * Een statusverandering op iets dat wij verstuurden.
 *
 * Het Message-object bij een ack draagt gewoon .type — dat stond er alleen niet
 * in. Zonder media_type is een verstuurd spraakbericht niet te onderscheiden
 * van een tekstje.
 */
export function bouwAckGebeurtenis(msg, ack, nu = Date.now()) {
  const soort = ACK_SOORT[ack];
  if (!soort || !msg) return null;
  const jid = msg.to || msg.from;
  if (!jid || isGroep(jid)) return null;
  return {
    soort,
    jid,
    tijdstip  : new Date(nu).toISOString(),
    media_type: msg.type || null,
    bericht_id: msg.id?._serialized || null,
  };
}

/** Is dit een ingesproken bericht? */
export function isSpraak(mediaType) {
  return SPRAAK_TYPES.has(String(mediaType || '').toLowerCase());
}
