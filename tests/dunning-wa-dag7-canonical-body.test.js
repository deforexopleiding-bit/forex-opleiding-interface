// tests/dunning-wa-dag7-canonical-body.test.js
//
// Bewijst voor het "Aanmaning dag 7 (WhatsApp)"-template
// (id 861cf8ea-4c47-4515-ac47-026ec27a84a6, meta_template_name aanmaning_dag7)
// dat NA de canonical body-restore migratie:
//   1) buildMetaTemplateVariables 5 params naar Meta stuurt (matcht approval)
//   2) De VOLGORDE van params 1-op-1 matcht met wat Meta bij goedkeuring
//      vastlegde: {{1}}=voornaam, {{2}}=factuurnummer, {{3}}=bedrag,
//      {{4}}=vervaldatum, {{5}}=betaal-link.
//   3) Diagnose geen unmatched placeholders vindt (n_missing = 0).
//   4) Elke waarde staat inhoudelijk op de juiste plek in de gerenderde
//      tekst (bewijs dat de mapping klopt en niet bv. bedrag op de naam-plek
//      belandt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMetaTemplateVariables,
  diagnoseTemplatePlaceholders,
} from '../api/_lib/dunning-template-placeholders.js';

// Exacte body zoals die na de 2026-07-29 restore-migratie in DB staat.
const CANONICAL_BODY =
  'Hoi {{klant.voornaam}},\n' +
  'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' +
  'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' +
  'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}\n' +
  'Met vriendelijke groeten,\n' +
  'Team De Forex Opleiding';

// Realistische test-waarden (bewust divers zodat swap-fouten opvallen).
const SAMPLE_VARS = {
  'klant.voornaam':      'Linda',
  'factuur.nummer':      '2026/1234',
  'factuur.bedrag':      '160,00',
  'factuur.vervaldatum': '14 juli 2026',
  'factuur.betaal_link': 'https://focus.teamleader.eu/invoice/abc123/pay',
};

test('canonical body: precies 5 unieke placeholders, geen unmatched', () => {
  const diag = diagnoseTemplatePlaceholders(CANONICAL_BODY);
  assert.equal(diag.total_count, 5, 'Meta krijgt 5 params (matcht approved template)');
  assert.equal(diag.n_missing,   0, 'geen unmatched — geen #132000');
  assert.deepEqual(diag.matched, [
    'klant.voornaam',
    'factuur.nummer',
    'factuur.bedrag',
    'factuur.vervaldatum',
    'factuur.betaal_link',
  ]);
});

test('buildMetaTemplateVariables: array-lengte = 5', () => {
  const out = buildMetaTemplateVariables(CANONICAL_BODY, SAMPLE_VARS);
  assert.equal(out.length, 5, 'exact 5 positionele params richting Meta');
});

test('positie 1 = voornaam (Linda), positie 2 = factuurnummer, positie 3 = bedrag, positie 4 = vervaldatum, positie 5 = betaal-link', () => {
  const out = buildMetaTemplateVariables(CANONICAL_BODY, SAMPLE_VARS);
  // Exacte volgorde-check — als iemand de body-volgorde in de toekomst wisselt,
  // faalt deze test en zien we het meteen.
  assert.equal(out[0], 'Linda',                                            '{{1}} = klant.voornaam');
  assert.equal(out[1], '2026/1234',                                        '{{2}} = factuur.nummer');
  assert.equal(out[2], '160,00',                                           '{{3}} = factuur.bedrag');
  assert.equal(out[3], '14 juli 2026',                                     '{{4}} = factuur.vervaldatum');
  assert.equal(out[4], 'https://focus.teamleader.eu/invoice/abc123/pay',   '{{5}} = factuur.betaal_link');
});

test('geen "swap" mogelijk: elke waarde is uniek genoeg om verkeerde plek te detecteren', () => {
  // Als factuurnummer per ongeluk op de bedrag-plek belandt, zou out[2] '2026/1234'
  // zijn i.p.v. '160,00'. Dat kan niet met deze fixture ondekt blijven — de test
  // hierboven controleert exact.
  const out = buildMetaTemplateVariables(CANONICAL_BODY, SAMPLE_VARS);
  assert.notEqual(out[0], out[1], 'voornaam ≠ factuurnummer');
  assert.notEqual(out[1], out[2], 'factuurnummer ≠ bedrag');
  assert.notEqual(out[2], out[3], 'bedrag ≠ vervaldatum');
  assert.notEqual(out[3], out[4], 'vervaldatum ≠ betaal-link');
});

test('rendered preview (menselijke lezing) — waarden op de juiste plek in de body', () => {
  // Simuleer de client-side render: vervang elke {{key}} door SAMPLE_VARS[key].
  let rendered = CANONICAL_BODY;
  for (const [key, val] of Object.entries(SAMPLE_VARS)) {
    rendered = rendered.replaceAll('{{' + key + '}}', val);
  }
  // Semantische checks: elke waarde staat in de juiste zin/context.
  assert.ok(rendered.includes('Hoi Linda,'),                                              'naam op naam-plek');
  assert.ok(rendered.includes('factuur 2026/1234 van EUR 160,00'),                        'factuurnummer + bedrag naast elkaar in factuur-zin');
  assert.ok(rendered.includes('De vervaldatum was 14 juli 2026.'),                        'vervaldatum in vervaldatum-zin');
  assert.ok(rendered.includes('Hier is ook direct een link om de factuur te betalen https://focus.teamleader.eu/invoice/abc123/pay'), 'betaal-link in betaal-link-zin');
  // Geen placeholder-syntax mag overblijven na render.
  assert.equal(rendered.match(/\{\{[^{}]+\}\}/g), null, 'geen niet-ge-resolvde placeholders in eindtekst');
});

test('kapotte body (de 15-juli-drift): heeft 4 vars — reproduceert #132000-scenario', () => {
  // Als regressie-guard: als iemand in de toekomst de body opnieuw drift,
  // zien we via deze test wat de "kapotte" versie doet. Meta verwacht 5 vars,
  // wij zouden dan 4 sturen → #132000.
  const DRIFTED_BODY =
    'Hoi {{klant.voornaam}},\n' +
    'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' +
    'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren of bevestig het eventjes.\n' +
    'Met vriendelijke groeten,\n' +
    'Team De Forex Opleiding';
  const diag = diagnoseTemplatePlaceholders(DRIFTED_BODY);
  assert.equal(diag.total_count, 4, 'kapotte body stuurt 4 vars — Meta verwacht 5 → 132000');
  assert.ok(!diag.matched.includes('factuur.betaal_link'), 'betaal-link ontbreekt in kapotte body');
});

test('ontbrekende betaal-link value → lege string op positie 5 (Meta accepteert)', () => {
  // Safety-net: als executor de betaal-link niet kan ophalen (bv. TL-fout),
  // krijgt positie 5 een lege string. Meta accepteert dat wel (bericht heeft
  // dan een half-lege zin). Executor skipt echter fail-CLOSED via
  // whatsapp_skipped_no_payment_link vóór send — deze test bewijst dat de
  // helper zelf niet crasht op ontbrekende value.
  const partial = { ...SAMPLE_VARS };
  delete partial['factuur.betaal_link'];
  const out = buildMetaTemplateVariables(CANONICAL_BODY, partial);
  assert.equal(out.length, 5, 'AANTAL blijft 5 zodat Meta niet #132000 gooit');
  assert.equal(out[4],   '',  'ontbrekende value = lege string');
});
