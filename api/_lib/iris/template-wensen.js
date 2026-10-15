// api/_lib/iris/template-wensen.js
//
// De vier templates die Iris mist, als gegevens in plaats van als tekst in een
// document.
//
// ── WAAROM DIT IN CODE STAAT EN NIET ALLEEN IN EEN DOCUMENT ──────────────────
// Ze stonden in docs/iris/template-wensen.md, met als bedoeling dat iemand ze
// met de hand bij Meta zou intypen. Dat is één keer overtypen met vier kansen
// op een typefout, en een typefout in een templatetekst wordt pas zichtbaar als
// Meta hem heeft goedgekeurd en een klant hem leest.
//
// Hier staan ze als gegevens, zodat het indienen één knop is en de tekst die de
// klant leest letterlijk dezelfde is als de tekst die iemand heeft goedgekeurd.
// tests/iris-template-wensen.test.js houdt deze lijst tegen dat document aan:
// wijkt er één woord, dan is de toets rood.
//
// ── WAAROM ELKE VARIABELE EEN VOORBEELD HEEFT ────────────────────────────────
// Meta WIL een voorbeeldwaarde per {{N}} bij de beoordeling. Zonder voorbeelden
// wordt een template geweigerd, en met nietszeggende voorbeelden ("voorbeeld")
// duurt de beoordeling langer of volgt een afkeuring. De voorbeelden hieronder
// zijn dus geen opsmuk maar onderdeel van de aanvraag — ze veranderen niets aan
// de tekst die een klant uiteindelijk leest.
//
// ── WAAROM ALLE VIER OP HET KLANTNUMMER ──────────────────────────────────────
// Iris werkt op gesprekken van de modules finance, dunning en onboarding, en
// die staan alle drie op het klantnummer (api/_lib/wa-nummers.js). Het
// hoofdnummer sluit die modules uitdrukkelijk uit. Een template die op het
// hoofdnummer wordt goedgekeurd, kan Iris dus niet versturen — hij zou er zijn
// en toch niet werken, en dat is het soort stilte waar je een uur naar zoekt.

/** De lijn waarop deze templates horen. Sleutel uit api/_lib/wa-nummers.js. */
export const WENS_NUMMER = 'klantnummer';

/**
 * De vier wensen. Vorm gelijk aan een whatsapp_meta_templates-rij, zodat
 * buildComponents() uit api/_lib/wa-template-components.js ze zonder omweg
 * aankan.
 *
 * `body_text` staat positioneel ({{1}}, {{2}} …) en NIET met benoemde
 * variabelen ({{klant.naam}}), omdat Iris positioneel invult: ze telt de
 * {{N}} in body_text (zie controleerVariabelen in templates.js) en geeft een
 * array mee aan sendTemplate. Benoemde variabelen zouden een
 * meta_param_mapping vereisen die Iris niet leest.
 */
export const TEMPLATE_WENSEN = Object.freeze([
  Object.freeze({
    name: 'betaalafspraak_bevestiging',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text: 'Beste {{1}}, we hebben je betaalafspraak genoteerd: {{2}} op {{3}}. Je hoort tot dan niets meer van ons over deze factuur. Lukt het toch niet, laat het dan even weten — dan kijken we samen verder.',
    body_examples: Object.freeze({ 1: 'Jeffrey', 2: '€ 249,00', 3: 'vrijdag 24 oktober' }),
    footer_text: null,
    buttons: null,
    variabelen: Object.freeze(['naam', 'bedrag', 'datum']),
    waarvoor: 'betaalafspraak — het bericht dat een gesprek afsluit',
  }),
  Object.freeze({
    name: 'lms_toegang_hulp',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text: 'Beste {{1}}, we zagen je bericht over het inloggen. We hebben je toegang nagekeken en sturen je zo een nieuwe link. Lukt het daarna nog niet, laat het weten.',
    body_examples: Object.freeze({ 1: 'Jeffrey' }),
    footer_text: null,
    buttons: null,
    variabelen: Object.freeze(['naam']),
    waarvoor: 'lms_toegang — "ik kan niet inloggen", vaak \'s avonds',
  }),
  Object.freeze({
    name: 'factuur_vraag',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text: 'Beste {{1}}, we hebben je vraag over je factuur ontvangen en kijken het na. Je hoort vandaag nog van ons.',
    body_examples: Object.freeze({ 1: 'Jeffrey' }),
    footer_text: null,
    buttons: null,
    variabelen: Object.freeze(['naam']),
    waarvoor: 'facturatie — een ontvangstbevestiging',
  }),
  Object.freeze({
    name: 'mentor_planning',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text: 'Beste {{1}}, over je sessie met {{2}}: {{3}}. Laat weten of dat lukt.',
    body_examples: Object.freeze({ 1: 'Jeffrey', 2: 'Maxim', 3: 'woensdag 22 oktober om 19:00' }),
    footer_text: null,
    buttons: null,
    variabelen: Object.freeze(['naam', 'mentor', 'voorstel']),
    waarvoor: 'planning_mentor — sessies verzetten gebeurt buiten kantooruren',
  }),
]);

/** Namen van de wensen, in dezelfde volgorde. */
export const WENS_NAMEN = Object.freeze(TEMPLATE_WENSEN.map((w) => w.name));

/** Eén wens op naam, of null. */
export function wensOpNaam(naam) {
  const n = String(naam || '').trim();
  return TEMPLATE_WENSEN.find((w) => w.name === n) || null;
}

/**
 * De WABA-sleutel waarop onze templaterijen staan.
 *
 * In whatsapp_meta_templates is business_account_id alleen een FILTERSLEUTEL
 * voor de lijst in de inbox — niet de WABA waar de template echt staat. Alle
 * CRM-rijen staan op deze waarde, en whatsapp_module_config wijst finance en
 * onboarding er ook naar (zie 2026-10-07-whatsapp-klantnummer-lijn.sql). Zetten
 * we hier iets anders, dan bestaat de template wel maar staat hij niet in de
 * lijst van de module die hem moet kunnen sturen.
 */
export const WENS_BUSINESS_ACCOUNT_ID = '990429800401598';
