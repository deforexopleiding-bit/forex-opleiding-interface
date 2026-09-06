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

/**
 * BESCHRIJFT DIT TYPE EEN ECHT GESPREK?
 *
 * WhatsApp stuurt over dezelfde stroom ook dingen die geen bericht zijn. In
 * productie stond een rij in opvolging_wa_berichten met richting 'in',
 * media_type 'e2e_notification' en geen tekst — en daarnaast een poging met
 * resultaat 'antwoord ontvangen'. Er was NIETS geantwoord: WhatsApp had een
 * sleutel ververst, en het systeem noteerde dat als contact met de lead.
 *
 * Dat is de fout die we steeds opnieuw maken — een gebeurtenis die iets anders
 * betekent dan waar hij voor doorgaat — en hij zat in de cijfers waar Dave op
 * stuurt: de dekking liep op en een lead die nooit reageerde zag er beantwoord
 * uit.
 *
 * EEN WEIGERLIJST, GEEN TOELATINGSLIJST. Dat is met opzet en het is de
 * belangrijkste keuze in dit bestand. Een toelatingslijst laat een type dat
 * WhatsApp volgend jaar toevoegt stil vallen, en dan mist Dave een echt bericht
 * zonder dat iemand het merkt. Stil laten vallen van iets echts is erger dan
 * een systeemmelding te veel: die zie je, en dan vul je de lijst aan.
 *
 * Vandaar ook dat elke weigering per type geteld wordt (zie lib/tellers.js).
 * Duikt er een onbekend type op dat massaal binnenkomt, dan staat dat in
 * /status — alleen het type, nooit een nummer of tekst.
 */
export const SYSTEEM_TYPES = new Set([
  'e2e_notification',        // sleutel ververst — dit was de rij in productie
  'notification_template',   // WhatsApp's eigen systeemmelding
  'gp2',                     // groepsmutatie (iemand toegevoegd/verwijderd)
  'protocol',                // protocolbericht, bv. een verlopen bericht
  'ciphertext',              // nog niet ontsleuteld; er is geen inhoud
  'revoked',                 // bericht ingetrokken
  'call_log',                // gemiste of gevoerde oproep, geen bericht
  'broadcast_notification',  // meldingen rond een broadcastlijst
  'unknown',                 // whatsapp-web.js kon het type niet plaatsen
]);

/**
 * Is dit type een echt gesprek? Onbekend = ja, met opzet — zie hierboven.
 *
 * Een ontbrekend type telt óók als gesprek: whatsapp-web.js levert `type` niet
 * altijd, en een bericht wegdoen omdat een veld ontbrak is precies het stille
 * verlies dat we niet willen.
 */
export function isEchtGesprek(mediaType) {
  if (mediaType === null || mediaType === undefined || mediaType === '') return true;
  return !SYSTEEM_TYPES.has(String(mediaType).toLowerCase());
}

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
  // Ook hier: een e2e_notification is geen gespreksregel. Hij raakt de
  // poging-telling niet aan, maar zou wel als lege bubbel in het gesprek
  // verschijnen — en dan staat er iets in de draad wat niemand gezegd heeft.
  if (!isEchtGesprek(msg.type)) return null;
  const seconden = Number(msg.timestamp);
  return {
    bericht_id: msg.id?._serialized || null,
    richting  : msg.fromMe === true ? 'uit' : 'in',
    tekst     : typeof msg.body === 'string' ? msg.body.slice(0, MAX_TEKST) : '',
    media_type: msg.type || null,
    tijdstip  : new Date(Number.isFinite(seconden) && seconden > 0 ? seconden * 1000 : nu).toISOString(),
  };
}
