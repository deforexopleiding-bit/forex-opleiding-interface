// api/_lib/whatsapp-systeemtypes.js
//
// Beschrijft een WhatsApp-berichttype een ECHT gesprek, of is het een
// systeemmelding?
//
// LET OP — DIT BESTAND HEEFT EEN TWEELING
// services/whatsapp-brug/lib/gebeurtenis.js draagt dezelfde lijst en dezelfde
// functie. Dat is met opzet: de brug moet zelfstandig naar een VPS te kopiëren
// zijn zonder de rest van de repo mee te slepen, en het endpoint mag niet
// afhankelijk zijn van de brug-versie die daar toevallig draait.
// tests/whatsapp-systeemtypes.test.js importeert allebei en vergelijkt de
// uitkomsten, zodat ze niet uit elkaar kunnen lopen zonder dat de test rood
// wordt. Wijzig je hier iets, wijzig het daar dan ook.
//
// WAAROM DIT TWEE KEER GECONTROLEERD WORDT
// De brug draait op een VPS en loopt altijd achter op een deploy. Zou alleen de
// brug filteren, dan hangt de juistheid van de cijfers af van wanneer iemand
// daar voor het laatst `git pull` heeft gedaan. Het endpoint controleert het
// dus opnieuw.

/**
 * Types die WhatsApp over de berichtenstroom stuurt maar die geen bericht zijn.
 *
 * In productie stond een rij in opvolging_wa_berichten met richting 'in',
 * media_type 'e2e_notification' en geen tekst — en daarnaast een poging met
 * resultaat 'antwoord ontvangen'. Er was niets geantwoord: WhatsApp had een
 * sleutel ververst, en het systeem noteerde dat als contact met de lead. De
 * dekking liep op en een lead die nooit reageerde zag er beantwoord uit.
 *
 * EEN WEIGERLIJST, GEEN TOELATINGSLIJST. Een toelatingslijst laat een type dat
 * WhatsApp volgend jaar toevoegt stil vallen, en dan mist Dave een echt bericht
 * zonder dat iemand het merkt. Stil laten vallen van iets echts is erger dan
 * een systeemmelding te veel: die zie je, en dan vul je de lijst aan.
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
