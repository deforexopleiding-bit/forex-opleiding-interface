// tests/wik-brief-layout.test.js
//
// Bewijst de pure helpers voor WIK-brief opmaak (fase C5-vensterenvelop):
//   - validateCustomerAddress → 422 ADDRESS_INCOMPLETE trigger
//   - buildAddressBlockPosition → C5-vensterenvelop-slot in pdfkit-punten
//   - buildAddressBlockLines   → naam + straat+nr + postcode+plaats + landregel

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCustomerAddress,
  REQUIRED_ADDRESS_FIELDS,
  buildAddressBlockPosition,
  buildAddressBlockLines,
  mmToPt,
  MM_TO_PT,
  C5_ENVELOPE,
} from '../api/_lib/wik-brief-layout.js';

// ── validateCustomerAddress ─────────────────────────────────────────

test('validate: alle 4 velden gevuld → ok=true, missing=[]', () => {
  const cust = {
    address_street: 'Grote Markt',
    address_number: '12A',
    address_postal: '1234 AB',
    address_city:   'Amsterdam',
  };
  const r = validateCustomerAddress(cust);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('validate: 1 veld leeg → ok=false, missing lijst', () => {
  const cust = { address_street: 'X', address_number: '1', address_postal: '', address_city: 'Y' };
  const r = validateCustomerAddress(cust);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['address_postal']);
});

test('validate: alles leeg/null → ok=false, alle 4 in missing', () => {
  const r = validateCustomerAddress({});
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 4);
  for (const f of REQUIRED_ADDRESS_FIELDS) assert.ok(r.missing.includes(f));
});

test('validate: whitespace-only telt als leeg', () => {
  const cust = { address_street: '   ', address_number: '\t\n', address_postal: ' ', address_city: '' };
  const r = validateCustomerAddress(cust);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 4);
});

test('validate: null / undefined cust → alle velden missing', () => {
  assert.equal(validateCustomerAddress(null).missing.length, 4);
  assert.equal(validateCustomerAddress(undefined).missing.length, 4);
});

test('validate: address_country is NIET required (fallback naar NL in landregel)', () => {
  const cust = {
    address_street: 'X', address_number: '1', address_postal: '1000 AA', address_city: 'Y',
    // address_country ontbreekt bewust
  };
  assert.equal(validateCustomerAddress(cust).ok, true);
});

// ── mmToPt / C5_ENVELOPE ────────────────────────────────────────────

test('mmToPt: 1mm → ~2.834645pt', () => {
  const pt = mmToPt(1);
  assert.ok(Math.abs(pt - MM_TO_PT) < 0.001);
});

test('mmToPt: 210mm (A4 breedte) → ~595pt', () => {
  const pt = mmToPt(210);
  assert.ok(Math.abs(pt - 595.28) < 0.5, `got ${pt}`);
});

test('C5_ENVELOPE: NL standaard 90×40mm venster op 45×50mm', () => {
  assert.equal(C5_ENVELOPE.window_from_left_mm, 45);
  assert.equal(C5_ENVELOPE.window_from_top_mm, 50);
  assert.equal(C5_ENVELOPE.window_width_mm, 90);
  assert.equal(C5_ENVELOPE.window_height_mm, 40);
  assert.equal(C5_ENVELOPE.safe_margin_mm, 5);
});

// ── buildAddressBlockPosition ───────────────────────────────────────

test('buildAddressBlockPosition: adres binnen safe-area van venster', () => {
  const pos = buildAddressBlockPosition();
  // Safe-margin 5mm binnen 90×40 → 80×30mm effectief schrijfvlak.
  assert.equal(pos.mm.x_mm,      50);  // 45 + 5
  assert.equal(pos.mm.y_mm,      55);  // 50 + 5
  assert.equal(pos.mm.width_mm,  80);  // 90 - (5*2)
  assert.equal(pos.mm.height_mm, 30);  // 40 - (5*2)
});

test('buildAddressBlockPosition: pt-conversie klopt', () => {
  const pos = buildAddressBlockPosition();
  // 50mm → ~141.7pt, 55mm → ~155.9pt, 80mm → ~226.8pt
  assert.ok(Math.abs(pos.x         - 50 * MM_TO_PT) < 0.01);
  assert.ok(Math.abs(pos.y         - 55 * MM_TO_PT) < 0.01);
  assert.ok(Math.abs(pos.width     - 80 * MM_TO_PT) < 0.01);
  assert.ok(Math.abs(pos.maxHeight - 30 * MM_TO_PT) < 0.01);
});

test('buildAddressBlockPosition: adresblok past niet buiten A4 breedte', () => {
  const pos = buildAddressBlockPosition();
  const a4WidthPt = mmToPt(210);
  assert.ok(pos.x + pos.width <= a4WidthPt, 'adres past niet in A4');
});

// ── buildAddressBlockLines ──────────────────────────────────────────

test('lines: NL default landregel = "Nederland"', () => {
  const cust = {
    address_street: 'Grote Markt', address_number: '12A',
    address_postal: '1234 AB', address_city: 'Amsterdam',
    // address_country ontbreekt → NL default
  };
  const lines = buildAddressBlockLines(cust, 'Jan Jansen');
  assert.deepEqual(lines, [
    'Jan Jansen',
    'Grote Markt 12A',
    '1234 AB Amsterdam',
    'Nederland',
  ]);
});

test('lines: BE landregel = "België"', () => {
  const cust = {
    address_street: 'Grote Markt', address_number: '12',
    address_postal: '1000', address_city: 'Brussel',
    address_country: 'BE',
  };
  const lines = buildAddressBlockLines(cust, 'Jean Dupont');
  assert.equal(lines[3], 'België');
});

test('lines: address_country lowercase "be" → nog steeds "België"', () => {
  const cust = {
    address_street: 'X', address_number: '1', address_postal: '1000', address_city: 'Y',
    address_country: 'be',
  };
  assert.equal(buildAddressBlockLines(cust, 'Naam')[3], 'België');
});

test('lines: onbekende country → default naar Nederland', () => {
  const cust = {
    address_street: 'X', address_number: '1', address_postal: '1000', address_city: 'Y',
    address_country: 'DE',
  };
  assert.equal(buildAddressBlockLines(cust, 'Naam')[3], 'Nederland');
});

test('lines: lege naam → naam-regel wordt skipped', () => {
  const cust = {
    address_street: 'X', address_number: '1', address_postal: '1000', address_city: 'Y',
  };
  const lines = buildAddressBlockLines(cust, '');
  assert.equal(lines.length, 3); // straat, postcode+plaats, land
  assert.equal(lines[0], 'X 1');
});

test('lines: lange bedrijfsnaam blijft op regel 1', () => {
  const cust = {
    address_street: 'Zuidas', address_number: '100',
    address_postal: '1082 MD', address_city: 'Amsterdam',
  };
  const lines = buildAddressBlockLines(cust, 'ACME Nederland B.V. i.o.');
  assert.equal(lines[0], 'ACME Nederland B.V. i.o.');
});
