// api/_lib/bezwaren.js
//
// De elf bezwaren — de serverkant van één lijst.
//
// Deze lijst bestond al: de Follow-up-module vraagt hem uit bij het afronden
// van een belgesprek (BEZWAREN in modules/klanten-v2/views/followup-v2.js).
// Vanaf stap 2 vraagt ook het afrondscherm van een event ernaar, zodra iemand
// "Geen interesse" kiest. Dat moet dezelfde lijst zijn: twee lijsten die uit
// elkaar lopen leveren twee rapportages op die niet op te tellen zijn.
//
// De frontend is een klassiek script en de API draait op ES-modules, dus één
// bestand delen kan niet. De lijst staat daarom op twee plekken:
//   · hier, voor de server;
//   · KV_V2.helpers.BEZWAREN in modules/klanten-v2/views/_shared-v2.js,
//     voor het scherm — en followup-v2.js leest die inmiddels ook.
// tests/bezwaren-lijst-gelijk.test.js leest dat andere bestand als tekst en
// faalt zodra de twee lijsten uit elkaar lopen. Verandert er hier iets, dan
// moet het daar ook, en de test zegt het als je dat vergeet.
//
// Volgorde is betekenisvol: zo staan ze op het scherm.

export const BEZWAREN = Object.freeze([
  'Te duur',
  'Geen tijd',
  'Moet overleggen',
  'Al bij andere partij',
  'Wil eerst resultaten zien',
  'Twijfelt over online',
  'Geen vertrouwen',
  'Wil eerst zelf proberen',
  'Slecht moment',
  'Geen budget nu',
  'Anders',
]);

const BEZWAREN_SET = new Set(BEZWAREN);

/** Is dit een geldig bezwaar? Trimt niet en accepteert geen varianten. */
export function isBezwaar(waarde) {
  return typeof waarde === 'string' && BEZWAREN_SET.has(waarde);
}
