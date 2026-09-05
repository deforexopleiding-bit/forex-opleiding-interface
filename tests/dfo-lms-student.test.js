// tests/dfo-lms-student.test.js
//
// Borgt de twee dingen die bij de dfo-lms-koppeling stil fout kunnen gaan:
//
//   1. product_soort. hlms_student.product_soort is `text` ZONDER CHECK, dus
//      de databank houdt een verkeerde waarde niet tegen. De studentkant
//      (trajectstand.ts) kent alleen 'mentorship' en 'membership'; al het
//      andere valt daar in 'onbekend' en dan ziet een betalende klant dat
//      zijn traject niet bekend is. Deze test borgt dat er nooit een derde
//      waarde uit de mapping komt — ook niet via de traject-key.
//   2. De datum-rekenkunde van het toegangsvenster (maand-clamp).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bepaalProductSoort, bepaalCallsTotaal } from '../api/_lib/dfo-lms-student.js';
import { addMonths, parseDatumUtc, berekenLmsVenster } from '../api/_lib/onboarding-window.js';
import { isUniqueViolation } from '../api/_lib/dfo-lms-db.js';

// ── 1) product_soort: strikte woordenlijst ──────────────────────────────────

test('product_soort: 1op1 wordt mentorship', () => {
  assert.equal(bepaalProductSoort({ type: '1op1' }), 'mentorship');
});

test('product_soort: membership blijft membership', () => {
  assert.equal(bepaalProductSoort({ type: 'membership' }), 'membership');
});

test('product_soort: hoofdletters en spaties worden genormaliseerd', () => {
  assert.equal(bepaalProductSoort({ type: '  MemberShip ' }), 'membership');
  assert.equal(bepaalProductSoort({ type: '1OP1' }), 'mentorship');
});

test('product_soort: traject-key glipt er NIET doorheen als terugval', () => {
  // Dit was de oude bug: type onbekend -> key doorgeven -> derde waarde in
  // de databank -> student ziet 'onbekend'. Moet nu null zijn zodat de
  // aanmaak luidruchtig faalt.
  assert.equal(bepaalProductSoort({ type: null, key: '1-op-1-coaching-12m' }), null);
  assert.equal(bepaalProductSoort({ type: '', key: 'membership-jaar' }), null);
});

test('product_soort: onbekend type geeft null, nooit een gok', () => {
  for (const t of ['coaching', 'alpha', 'lidmaatschap', 'mentorship-plus', 'onbekend', undefined]) {
    assert.equal(bepaalProductSoort({ type: t }), null, 'type=' + String(t));
  }
  assert.equal(bepaalProductSoort(null), null);
});

test('product_soort: geeft ALLEEN ooit mentorship of membership terug', () => {
  const toegestaan = new Set(['mentorship', 'membership', null]);
  const proef = ['1op1', '1-op-1', 'mentorship', 'membership', 'MEMBERSHIP',
    'rommel', '', null, undefined, '  ', '1op1 ', 'student'];
  for (const t of proef) {
    assert.ok(toegestaan.has(bepaalProductSoort({ type: t })), 'onverwachte waarde voor ' + String(t));
  }
});

// ── 2) calls_totaal ─────────────────────────────────────────────────────────

test('calls_totaal: calls wint van alpha_calls_total', () => {
  assert.equal(bepaalCallsTotaal({ calls: 24, alpha_calls_total: 48 }), 24);
});

test('calls_totaal: valt terug op alpha_calls_total', () => {
  assert.equal(bepaalCallsTotaal({ calls: null, alpha_calls_total: 48 }), 48);
});

test('calls_totaal: 0 en onzin geven null (geen 0 als sentinel)', () => {
  assert.equal(bepaalCallsTotaal({ calls: 0, alpha_calls_total: 0 }), null);
  assert.equal(bepaalCallsTotaal({}), null);
  assert.equal(bepaalCallsTotaal(null), null);
});

// ── 3) Datum-rekenkunde ─────────────────────────────────────────────────────

test('addMonths klemt op de laatste dag van de doelmaand', () => {
  // 31 januari + 1 maand mag geen 2/3 maart worden.
  const uit = addMonths(new Date('2026-01-31T00:00:00Z'), 1);
  assert.equal(uit.toISOString().slice(0, 10), '2026-02-28');
});

test('addMonths met schrikkeljaar', () => {
  const uit = addMonths(new Date('2024-01-31T00:00:00Z'), 1);
  assert.equal(uit.toISOString().slice(0, 10), '2024-02-29');
});

test('addMonths negeert negatieve en onzinnige maanden', () => {
  const basis = new Date('2026-03-15T00:00:00Z');
  assert.equal(addMonths(basis, -3).toISOString(), basis.toISOString());
  assert.equal(addMonths(basis, null).toISOString(), basis.toISOString());
});

test('parseDatumUtc leest een date-kolom als UTC-middernacht', () => {
  // Zonder expliciete UTC-suffix zou dit bij negatieve offsets een dag
  // verschuiven; dat is exact de off-by-one uit de lessons learned.
  assert.equal(parseDatumUtc('2026-09-05').toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(parseDatumUtc(null), null);
  assert.equal(parseDatumUtc('rommel'), null);
});

test('berekenLmsVenster: start + duur geeft einddatum', () => {
  const { startIso, eindIso } = berekenLmsVenster({ startDate: '2026-09-05', duurMaanden: 12 });
  assert.equal(startIso, '2026-09-05T00:00:00.000Z');
  assert.equal(eindIso.slice(0, 10), '2027-09-05');
});

test('berekenLmsVenster: zonder duur GEEN verzonnen einddatum', () => {
  const { eindIso } = berekenLmsVenster({ startDate: '2026-09-05', duurMaanden: null });
  assert.equal(eindIso, null);
  assert.equal(berekenLmsVenster({ startDate: '2026-09-05', duurMaanden: 0 }).eindIso, null);
});

test('berekenLmsVenster: startdatum in het verleden blijft de ECHTE startdatum', () => {
  // Wijkt bewust af van de Bubble-variant, die naar now schuift. Een
  // studentrij legt een administratief feit vast; bij de handmatige knop op
  // een bestaande onboarding is dat de oorspronkelijke startdatum.
  const { startIso } = berekenLmsVenster({ startDate: '2024-01-10', duurMaanden: 6 });
  assert.equal(startIso, '2024-01-10T00:00:00.000Z');
});

// ── 4) Unique-violation herkenning ──────────────────────────────────────────

test('isUniqueViolation herkent 23505 en niets anders', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ code: 23505 }), true);   // niet-string variant
  assert.equal(isUniqueViolation({ code: '23503' }), false); // FK-schending
  assert.equal(isUniqueViolation({ message: 'duplicate key' }), false);
  assert.equal(isUniqueViolation(null), false);
});
