// tests/wik-brief-land.test.js
//
// Landbepaling voor de WIK-brief: address_country (indien NL/BE) met terugval op
// het postcodeformaat. Dekt de landregel in het adresblok én — via dezelfde
// bepaalLand — de NL/BE-templatekeuze.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bepaalLand, buildAddressBlockLines } from '../api/_lib/wik-brief-layout.js';

// helper: template-code precies zoals de core (resolvedCountry === 'BE' ? _be : _nl)
const templateCode = (cust) => (bepaalLand(cust) === 'BE' ? 'incasso_pre_be' : 'incasso_pre_nl');
const landregelVan = (cust, override = null) => buildAddressBlockLines(cust, 'X', override).slice(-1)[0];

// ── bepaalLand ──────────────────────────────────────────────────────────────

test('BE-postcode zonder address_country (2100 Antwerpen) → BE', () => {
  assert.equal(bepaalLand({ address_postal: '2100', address_city: 'Antwerpen' }), 'BE');
});

test('NL-postcode (4 cijfers + 2 letters) → NL', () => {
  assert.equal(bepaalLand({ address_postal: '7812 HZ' }), 'NL');
  assert.equal(bepaalLand({ address_postal: '1234AB' }), 'NL'); // zonder spatie
});

test('expliciete address_country wint van postcode', () => {
  assert.equal(bepaalLand({ address_country: 'BE', address_postal: '7812 HZ' }), 'BE');
  assert.equal(bepaalLand({ address_country: 'NL', address_postal: '2100' }), 'NL');
  assert.equal(bepaalLand({ address_country: 'be', address_postal: '' }), 'BE'); // case-insensitive
});

test('geen/onbekende postcode → terugval NL', () => {
  assert.equal(bepaalLand({ address_postal: '' }), 'NL');
  assert.equal(bepaalLand({}), 'NL');
  assert.equal(bepaalLand({ address_postal: 'X1' }), 'NL');
});

// ── landregel in het adresblok ──────────────────────────────────────────────

test('Belgische klant (2100 Antwerpen, leeg land) → landregel "België"', () => {
  const jennifer = { address_street: 'Voorbeeldstraat', address_number: '5', address_postal: '2100', address_city: 'Antwerpen', address_country: null };
  assert.equal(landregelVan(jennifer), 'België');
});

test('Nederlandse klant → landregel "Nederland"', () => {
  const nl = { address_street: 'Kerkweg', address_number: '3', address_postal: '7812 HZ', address_city: 'Emmen', address_country: null };
  assert.equal(landregelVan(nl), 'Nederland');
});

test('landOverride (gekozen template-land) wint voor de landregel', () => {
  const nlPc = { address_postal: '7812 HZ' };
  assert.equal(landregelVan(nlPc, 'BE'), 'België');   // template BE gekozen → landregel volgt
  assert.equal(landregelVan({ address_postal: '2100' }, 'NL'), 'Nederland');
});

// ── templatekeuze (zelfde bepaalLand) ───────────────────────────────────────

test('BE-klant → BE-template; NL-klant → NL-template', () => {
  assert.equal(templateCode({ address_postal: '2100', address_city: 'Antwerpen' }), 'incasso_pre_be');
  assert.equal(templateCode({ address_postal: '7812 HZ' }), 'incasso_pre_nl');
});
