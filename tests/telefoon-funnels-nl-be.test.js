// tests/telefoon-funnels-nl-be.test.js
//
// De funnels op deforexopleiding.nl (vooral Nederlands publiek) sturen hun
// nummer naar het CRM via /api/lab-aanmelding (The Lab) en de boek-route
// (Strategie-scan → public-opstartsessie-book, telefoonNlBe). Vastgelegd
// (2026-10-20): elk NL- en BE-formaat wordt E.164 — gsm, vast, met +, 00 of
// zonder 0 — zodat de softphone (lijn op +31/+32) en WhatsApp werken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseerNlBe, telefoonNlBe } from '../api/_lib/phone-e164.js';
import { valideerLabAanmelding } from '../api/_lib/lab-aanmelding-validatie.js';

const GEVALLEN = [
  ['06 12345678', '+31612345678'], ['06-12345678', '+31612345678'], ['0612345678', '+31612345678'],
  ['+31 6 12345678', '+31612345678'], ['+31612345678', '+31612345678'], ['0031612345678', '+31612345678'],
  ['612345678', '+31612345678'],
  ['020 123 4567', '+31201234567'], ['010-1234567', '+31101234567'], ['+31 20 123 4567', '+31201234567'],
  ['0470 12 34 56', '+32470123456'], ['+32 470 12 34 56', '+32470123456'], ['0032470123456', '+32470123456'],
  ['470123456', '+32470123456'], ['09 123 45 67', '+3291234567'], ['+32470123456', '+32470123456'],
];

test('normaliseerNlBe + telefoonNlBe: NL (gsm + vast) en BE → E.164', () => {
  for (const [in_, uit] of GEVALLEN) {
    assert.equal(normaliseerNlBe(in_).e164, uit, in_);
    assert.equal(telefoonNlBe(in_, { bron: 'test' }), uit, in_);
  }
});

test('Lab-aanmelding: NL en BE aanvaard, opgeslagen in E.164', () => {
  for (const [in_, uit] of GEVALLEN) {
    const v = valideerLabAanmelding({ voornaam: 'Test', email: 'maxim.delombaerde96+labtest1@gmail.com', gsm: in_ });
    assert.equal(v.ok, true, in_);
    assert.equal(v.data.telefoon_e164, uit, in_);
  }
});

test('Lab-aanmelding: echt fout → duidelijke melding met NL- en BE-voorbeeld', () => {
  const v = valideerLabAanmelding({ voornaam: 'Test', email: 'a@b.nl', gsm: '12345' });
  assert.equal(v.ok, false);
  assert.equal(v.veld, 'gsm');
  assert.match(v.fout, /06 12 34 56 78 \(Nederland\) of 0470 12 34 56 \(België\)/);
});
