// api/_lib/webinar-templates.js
//
// De vier WhatsApp-templates van het webinar (fase 1), als ÉÉN bron voor:
//   - de verzender (api/_lib/webinar.js) — welke naam + welke parametervolgorde;
//   - het indien-script (scripts/360-templates-upload.mjs) — dat gebruikt deze
//     definitie als er (nog) geen rij in whatsapp_meta_templates staat.
// Zelfde rij-vorm als whatsapp_meta_templates (buildComponents leest hem zo).
//
// UTILITY: elk bericht gaat over de eigen aanmelding (datum, tijd, Zoom-link) —
// geen aanbod, geen korting, geen urgentie. Positionele {{n}}, mapping in `vars`.
//
// Status bij Meta: niet hier — die vraagt de verzender live op bij 360dialog
// (templateStatusOpLijn). Zolang een template niet APPROVED is, gaat alleen de
// mail uit.

export const WEBINAR_TEMPLATES = Object.freeze({
  webinar_bevestiging: Object.freeze({
    name: 'webinar_bevestiging',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text:
      'Hoi {{1}}, je bent aangemeld voor het webinar van De Forex Opleiding op {{2}} om {{3}}.\n\n'
      + 'Je doet mee via Zoom: {{4}}\n\n'
      + 'Bewaar dit bericht, dan heb je de link straks bij de hand. Tot maandag!',
    body_examples: { 1: 'Jeffrey', 2: 'maandag 13 oktober', 3: '19:00', 4: 'https://us02web.zoom.us/j/12345678901' },
    footer_text: null,
    buttons: null,
    vars: Object.freeze(['voornaam', 'datum', 'tijd', 'zoom']),
  }),
  webinar_reminder_dag: Object.freeze({
    name: 'webinar_reminder_dag',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text:
      'Hoi {{1}}, een herinnering: morgen, {{2}}, om {{3}} begint het webinar van De Forex Opleiding.\n\n'
      + 'De Zoom-link: {{4}}\n\n'
      + 'Zet het alvast in je agenda, dan zien we je morgen.',
    body_examples: { 1: 'Jeffrey', 2: 'maandag 13 oktober', 3: '19:00', 4: 'https://us02web.zoom.us/j/12345678901' },
    footer_text: null,
    buttons: null,
    vars: Object.freeze(['voornaam', 'datum', 'tijd', 'zoom']),
  }),
  webinar_reminder_uur: Object.freeze({
    name: 'webinar_reminder_uur',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text:
      'Hoi {{1}}, over een uur, om {{2}}, begint het webinar van De Forex Opleiding.\n\n'
      + 'Je doet mee via deze Zoom-link: {{3}}\n\n'
      + 'Tot zo!',
    body_examples: { 1: 'Jeffrey', 2: '19:00', 3: 'https://us02web.zoom.us/j/12345678901' },
    footer_text: null,
    buttons: null,
    vars: Object.freeze(['voornaam', 'tijd', 'zoom']),
  }),
  webinar_live: Object.freeze({
    name: 'webinar_live',
    language: 'nl',
    category: 'UTILITY',
    header_type: 'NONE',
    body_text:
      // Meta weigert een body die op een variabele eindigt ("Invalid parameter").
      'Hoi {{1}}, we zijn live! Het webinar van De Forex Opleiding is net begonnen.\n\n'
      + 'Doe mee via Zoom: {{2}}\n\n'
      + 'Tot zo in de sessie!',
    body_examples: { 1: 'Jeffrey', 2: 'https://us02web.zoom.us/j/12345678901' },
    footer_text: null,
    buttons: null,
    vars: Object.freeze(['voornaam', 'zoom']),
  }),
});

export const WEBINAR_TEMPLATE_NAMEN = Object.freeze(Object.keys(WEBINAR_TEMPLATES));

/** Parameters in template-volgorde uit een context { voornaam, datum, tijd, zoom }. */
export function templateVariabelen(naam, ctx) {
  const t = WEBINAR_TEMPLATES[naam];
  if (!t) throw new Error('Onbekende webinar-template: ' + naam);
  return t.vars.map((k) => String(ctx?.[k] ?? '').trim() || '-');
}

/** De body met ingevulde parameters (voor het gesprekslog in de inbox). */
export function renderTemplateTekst(naam, ctx) {
  const t = WEBINAR_TEMPLATES[naam];
  const vals = templateVariabelen(naam, ctx);
  return t.body_text.replace(/\{\{(\d+)\}\}/g, (_, n) => vals[Number(n) - 1] ?? '');
}
