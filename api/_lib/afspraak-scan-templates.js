// api/_lib/afspraak-scan-templates.js
//
// NIEUWE WhatsApp-templates (2026-11-02, Maxim) voor de STRATEGIE-SCAN: de vijf
// afspraakmomenten voor booking_source 'webinar' / 'strategiescan'. De huidige
// goedgekeurde templates (afspraak_*_v1) zeggen "kennismakingsgesprek" en
// blijven ongewijzigd bestaan: zij zijn de terugval.
//
// Zelfde rij-vorm als whatsapp_meta_templates (zoals WEBINAR_TEMPLATES), zodat
// scripts/360-templates-upload.mjs ze kan indienen zonder DB-rij. Zelfde
// variabelen in dezelfde volgorde als de v1 die ze vervangen → de cron geeft
// dezelfde waVars mee. Naam begint met 'afspraak_' → het script kiest UTILITY
// (bericht over een afspraak die de lead zelf boekte).
//
// GEBRUIK: de cron stuurt de nieuwe template ALLEEN als 360dialog hem als
// APPROVED meldt op de lijn (templateStatusOpLijn); anders de v1. Zie
// waTemplateVoor() in api/cron-afspraak-reminders.js.

const KNOP_ERBIJ = Object.freeze([Object.freeze({ type: 'QUICK_REPLY', text: 'Ik ben erbij' })]);
const ZOOM = 'https://zoom.us/j/12345678';
const SELF = 'https://deforexopleiding.nl/afspraak/abc123';

export const SCAN_WA_TEMPLATES = Object.freeze({
  afspraak_scan_bevestiging_v1: Object.freeze({
    name: 'afspraak_scan_bevestiging_v1', language: 'nl', category: 'UTILITY', header_type: 'NONE',
    body_text:
      'Hoi {{1}}, gelukt! ✅ Je gratis strategie-scan met De Forex Opleiding staat gepland.\n\n'
      + '20 minuten via Zoom met ons team. Trade je al? Dan doen we een audit van je tradeplan, je journal en je strategie. '
      + 'Trade je nog niet? Dan bekijken we of trading in je dagelijks leven past. Je gaat weg met een persoonlijk actieplan.\n\n'
      + '📅 Wanneer: {{2}}\n💻 Waar: via Zoom → {{3}}\n\n'
      + 'Kan het onverhoopt niet doorgaan? Verzetten of annuleren kan hier: {{4}}\n\n'
      + 'Tot dan! 🚀',
    body_examples: { 1: 'Paco', 2: 'dinsdag 9 september om 11:30', 3: ZOOM, 4: SELF },
    footer_text: null, buttons: null,
    vervangt: 'afspraak_bevestiging_v1',
  }),
  afspraak_scan_reminder_24u_v1: Object.freeze({
    name: 'afspraak_scan_reminder_24u_v1', language: 'nl', category: 'UTILITY', header_type: 'NONE',
    body_text:
      'Hoi {{1}}, een vriendelijke herinnering: morgen staat je strategie-scan met De Forex Opleiding gepland. 🙌\n\n'
      + '📅 Wanneer: {{2}}\n💻 Waar: via Zoom → {{3}}\n\n'
      + 'Trade je al? Houd dan je tradeplan en je journal bij de hand.\n\n'
      + 'Komt het net niet uit? Via {{4}} kun je je afspraak nog verzetten. Tot morgen!',
    body_examples: { 1: 'Paco', 2: 'dinsdag 9 september om 11:30', 3: ZOOM, 4: SELF },
    footer_text: null, buttons: null,
    vervangt: 'afspraak_reminder_24u_v1',
  }),
  afspraak_scan_reminder_2u_v1: Object.freeze({
    name: 'afspraak_scan_reminder_2u_v1', language: 'nl', category: 'UTILITY', header_type: 'NONE',
    body_text:
      'Hoi {{1}}, over 2 uur is het zover: om {{2}} start je strategie-scan met De Forex Opleiding. 🎯\n\n'
      + 'Kun je bevestigen dat het je lukt? Tik hieronder om te bevestigen. 👇',
    body_examples: { 1: 'Paco', 2: '11:30' },
    footer_text: null, buttons: KNOP_ERBIJ,
    vervangt: 'afspraak_reminder_2u_v1',
  }),
  afspraak_scan_reminder_30m_v1: Object.freeze({
    name: 'afspraak_scan_reminder_30m_v1', language: 'nl', category: 'UTILITY', header_type: 'NONE',
    body_text:
      'Hoi {{1}}, over 30 minuten ({{2}}) begint je strategie-scan en we houden je plek graag vrij.\n\n'
      + 'Laat je ons even weten of het je lukt? 🙌\n\n'
      + 'Je Zoom-link: {{3}}\nTot zo!',
    body_examples: { 1: 'Paco', 2: '11:30', 3: ZOOM },
    footer_text: null, buttons: KNOP_ERBIJ,
    vervangt: 'afspraak_reminder_30m_v1',
  }),
  afspraak_scan_zoom_5min_v1: Object.freeze({
    name: 'afspraak_scan_zoom_5min_v1', language: 'nl', category: 'UTILITY', header_type: 'NONE',
    body_text:
      'Hoi {{1}}, we beginnen zo! ⏱️ Over ongeveer 5 minuten start je strategie-scan.\n\n'
      + 'Klik hier om direct te joinen:\n{{2}}\n\n'
      + 'Lukt het inloggen niet meteen? Stuur ons even een berichtje, dan helpen we je er zo doorheen. Tot zo! 👋',
    body_examples: { 1: 'Paco', 2: ZOOM },
    footer_text: null, buttons: null,
    vervangt: 'afspraak_zoom_5min_v1',
  }),
});

export const SCAN_WA_NAMEN = Object.freeze(Object.keys(SCAN_WA_TEMPLATES));

/** v1-naam → nieuwe scan-naam. PURE. */
export const SCAN_WA_VOOR = Object.freeze(Object.fromEntries(
  Object.values(SCAN_WA_TEMPLATES).map((t) => [t.vervangt, t.name]),
));

/**
 * Welke template voor dit moment? De scan-template alleen bij een scan-boeking
 * én als hij APPROVED is; anders de huidige (v1). Nooit een fout: elke twijfel
 * (status onbekend, opvragen mislukt) = de v1. `statusVan(naam)` → 'APPROVED' | …
 */
export async function kiesWaTemplate({ v1, isScan, statusVan }) {
  const nieuw = isScan ? SCAN_WA_VOOR[v1] : null;
  if (!nieuw) return v1;
  try {
    return String(await statusVan(nieuw) || '').toUpperCase() === 'APPROVED' ? nieuw : v1;
  } catch (e) {
    console.warn('[afspraak-scan-templates] status opvragen mislukt, terugval op', v1, e?.message || e);
    return v1;
  }
}
