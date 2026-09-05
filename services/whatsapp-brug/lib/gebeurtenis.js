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

/** Zelfde grens als bij inkomend: een gesprek, geen boek. */
export const MAX_TEKST = 4000;

/**
 * Een bericht dat Dave zelf verstuurt.
 *
 * Alleen fromMe: inkomend loopt via het 'message'-event. Groepen vallen af.
 *
 * DE TEKST GAAT NU WEL MEE, en dat is een bewuste wijziging. Eerder ging hij
 * niet mee met de redenering: voor de meting is alleen nodig dát er iets uitging
 * en of het ingesproken was, dus is de tekst gevoeliger dan nodig. Die
 * redenering klopte zolang het CRM het gesprek niet toonde. Nu wel: Dave leest
 * en beantwoordt het gesprek in het systeem, en een gesprek met alleen de
 * antwoorden van de lead erin is geen gesprek.
 *
 * Wat NIET verandert is waar de grens ligt. De aanroeper in whatsapp.js doet
 * eerst leadlijst.mag(msg.to) en pas daarna deze functie. Alles buiten de
 * leadlijst wordt volledig genegeerd en nergens gelogd; groepen vallen hier
 * bovendien nog een tweede keer af. Daves privégesprekken verlaten de telefoon
 * dus niet — niet omdat we ze verderop wegfilteren, maar omdat ze hier nooit
 * aankomen. Verplaats die volgorde nooit.
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
    tekst     : typeof msg.body === 'string' ? msg.body.slice(0, MAX_TEKST) : '',
    media_type: msg.type || null,
    bericht_id: msg.id?._serialized || null,
  };
}

/**
 * Een statusverandering op iets dat wij verstuurden.
 *
 * Hier gaat GEEN tekst mee, ook niet nu het uitgaande pad die wel draagt: een
 * ack is een statusmelding over een bericht dat al doorgegeven is, geen tweede
 * exemplaar ervan. Zou hij de tekst ook meesturen, dan hing dezelfde inhoud aan
 * drie gebeurtenissen (verzonden, afgeleverd, gelezen) en moest de ontvanger
 * uitzoeken welke de echte was.
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

/**
 * Een bericht uit de opgehaalde geschiedenis, klaar om terug te geven.
 *
 * Pure functie zonder client, zodat de vorm te testen is zonder puppeteer,
 * Chromium of een gekoppelde telefoon — net als de twee hierboven.
 *
 * Let op het verschil met de live-gebeurtenissen: hier gaat geen `soort` mee.
 * Een historisch bericht is geen gebeurtenis die nu plaatsvindt; het CRM
 * schrijft het weg als gespreksregel en raakt de poging-telling niet aan. Zou
 * dit als 'uitgaand' of 'antwoord_ontvangen' binnenkomen, dan telde een gesprek
 * van vorige week vandaag mee als moeite.
 *
 * `timestamp` is in seconden; de rest van het systeem rekent in ISO.
 */
export function bouwHistoriekBericht(msg, nu = Date.now()) {
  if (!msg || !msg.id) return null;
  const jid = msg.fromMe === true ? msg.to : msg.from;
  if (isGroep(jid)) return null;
  const seconden = Number(msg.timestamp);
  return {
    bericht_id: msg.id?._serialized || null,
    richting  : msg.fromMe === true ? 'uit' : 'in',
    tekst     : typeof msg.body === 'string' ? msg.body.slice(0, MAX_TEKST) : '',
    media_type: msg.type || null,
    tijdstip  : new Date(Number.isFinite(seconden) && seconden > 0 ? seconden * 1000 : nu).toISOString(),
  };
}
