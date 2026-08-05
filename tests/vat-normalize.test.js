// tests/vat-normalize.test.js
//
// Unit-tests voor api/_lib/vat-normalize.js — normalisatie + validatie van
// btw-nummers vóór Teamleader-push. Test-inputs komen 1:1 uit de 41-bedrijven-
// inventarisatie (aug 2026) die de user aanleverde.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVat, _internals } from '../api/_lib/vat-normalize.js';

// ── NORMAAL: strip + uppercase → geldig formaat ──────────────────────────
test('normale BE met spatie + punten → BE0729599851', () => {
  const r = normalizeVat('BE 0729.599.851');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0729599851');
  assert.equal(r.country, 'BE');
  assert.equal(r.changed, true);
});

test('normale NL met spatie + punten → NL862575187B01', () => {
  const r = normalizeVat('NL 8625.75.187.B01');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'NL862575187B01');
  assert.equal(r.country, 'NL');
  assert.equal(r.changed, true);
});

test('NL kleine letters → NL865112964B01', () => {
  const r = normalizeVat('nl865112964B01');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'NL865112964B01');
  assert.equal(r.country, 'NL');
  assert.equal(r.changed, true);
});

// ── PROBLEEMGEVAL a) ZONDER LANDCODE — BE-patroon (10 cijfers, begint met 0) ─
test('Chamano BV 0808.734.629 → BE0808734629', () => {
  const r = normalizeVat('0808.734.629');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0808734629');
  assert.equal(r.country, 'BE');
});

test('HMM 0787550126 → BE0787550126', () => {
  const r = normalizeVat('0787550126');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0787550126');
});

test('Radepa BV 0897407178 → BE0897407178', () => {
  const r = normalizeVat('0897407178');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0897407178');
});

// ── PROBLEEMGEVAL b) tekst-voorvoegsel ─────────────────────────────────────
test('FA Projects BtwBE0677756222 → BE0677756222', () => {
  const r = normalizeVat('BtwBE0677756222');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0677756222');
  assert.equal(r.country, 'BE');
});

test('VAT-prefix (Engels) → strip', () => {
  const r = normalizeVat('VAT NL862575187B01');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'NL862575187B01');
});

test('TVA-prefix (Frans) → strip', () => {
  const r = normalizeVat('TVA BE0729599851');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0729599851');
});

test('lowercase btw-prefix → strip', () => {
  const r = normalizeVat('btw be0729599851');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0729599851');
});

// ── EDGE CASES: al genormaliseerd, changed=false ───────────────────────────
test('al genormaliseerd BE → changed=false', () => {
  const r = normalizeVat('BE0729599851');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'BE0729599851');
  assert.equal(r.changed, false);
});

test('al genormaliseerd NL → changed=false', () => {
  const r = normalizeVat('NL862575187B01');
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
});

// ── AFWIJZINGEN ────────────────────────────────────────────────────────────
test('lege string → VAT_EMPTY', () => {
  const r = normalizeVat('');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_EMPTY');
});

test('null → VAT_EMPTY', () => {
  const r = normalizeVat(null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_EMPTY');
});

test('undefined → VAT_EMPTY', () => {
  const r = normalizeVat(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_EMPTY');
});

test('alleen spaties/punten → VAT_EMPTY', () => {
  const r = normalizeVat('   ...  ');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_EMPTY');
});

test('9 cijfers zonder landcode → VAT_COUNTRY_UNDETECTABLE (niet BE, niet NL)', () => {
  const r = normalizeVat('123456789');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_COUNTRY_UNDETECTABLE');
  assert.match(r.error, /landcode/);
});

test('10 cijfers die NIET met 0 beginnen → VAT_COUNTRY_UNDETECTABLE', () => {
  const r = normalizeVat('1234567890');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_COUNTRY_UNDETECTABLE');
});

test('BE + te weinig cijfers → VAT_INVALID_FORMAT', () => {
  const r = normalizeVat('BE 0729.599');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_INVALID_FORMAT');
});

test('NL + verkeerd B-suffix → VAT_INVALID_FORMAT', () => {
  const r = normalizeVat('NL862575187X01'); // 'X' i.p.v. 'B'
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_INVALID_FORMAT');
});

test('DE + geldig-lookend patroon → VAT_INVALID_FORMAT (DE niet supported)', () => {
  const r = normalizeVat('DE123456789');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAT_INVALID_FORMAT');
});

test('random tekst → VAT_COUNTRY_UNDETECTABLE', () => {
  const r = normalizeVat('nonsense');
  assert.equal(r.ok, false);
});

// ── INTERNALS ──────────────────────────────────────────────────────────────
test('_internals.stripAndUpper: BTW-prefix wordt gestript', () => {
  assert.equal(_internals.stripAndUpper('BtwBE0677756222'), 'BE0677756222');
  assert.equal(_internals.stripAndUpper('vat BE0729599851'), 'BE0729599851');
});

test('_internals.stripAndUpper: alleen 1 prefix wordt gestript (geen loop)', () => {
  // "BTWBTW..." is geen legitieme input; we strippen alleen de eerste BTW.
  const s = _internals.stripAndUpper('BTWBTWBE0729599851');
  assert.equal(s, 'BTWBE0729599851');
});

test('_internals.inferCountryCode: BE-patroon', () => {
  assert.equal(_internals.inferCountryCode('0808734629'), 'BE');
});

test('_internals.inferCountryCode: NL-patroon', () => {
  assert.equal(_internals.inferCountryCode('862575187B01'), 'NL');
});

test('_internals.inferCountryCode: ambigu → null', () => {
  assert.equal(_internals.inferCountryCode('123456789'), null);
  assert.equal(_internals.inferCountryCode(''), null);
});

test('_internals.isValidFormat: alle valid patronen', () => {
  assert.equal(_internals.isValidFormat('BE0729599851'), true);
  assert.equal(_internals.isValidFormat('NL862575187B01'), true);
  assert.equal(_internals.isValidFormat('BE12345'), false);
  assert.equal(_internals.isValidFormat('FR12345678901'), false);
});
