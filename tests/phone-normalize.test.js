// tests/phone-normalize.test.js
//
// Regressietest voor api/_lib/phone-normalize.js — pure helpers voor telefoon-
// fuzzy-matching gebruikt door de globale follow-up-zoekbalk (en potentieel
// andere endpoints die NL/BE-nummer-varianten willen matchen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripToDigits,
  last9Digits,
  phonesLikelyMatch,
} from '../api/_lib/phone-normalize.js';

// ─────────────────────────────────────────────────────────────────────────────
// stripToDigits
// ─────────────────────────────────────────────────────────────────────────────

test('stripToDigits: standaard NL-nummer met spaties', () => {
  assert.equal(stripToDigits('06 12 34 56 78'), '0612345678');
});

test('stripToDigits: +31 met streepjes', () => {
  assert.equal(stripToDigits('+31-6-12345678'), '31612345678');
});

test('stripToDigits: alleen digits blijft', () => {
  assert.equal(stripToDigits('0612345678'), '0612345678');
});

test('stripToDigits: null/undefined/leeg → ""', () => {
  assert.equal(stripToDigits(null), '');
  assert.equal(stripToDigits(undefined), '');
  assert.equal(stripToDigits(''), '');
});

test('stripToDigits: BE +32', () => {
  assert.equal(stripToDigits('+32 470 12 34 56'), '32470123456');
});

// ─────────────────────────────────────────────────────────────────────────────
// last9Digits
// ─────────────────────────────────────────────────────────────────────────────

test('last9Digits: 0612345678 (10 digits) → 612345678 (laatste 9)', () => {
  assert.equal(last9Digits('0612345678'), '612345678');
});

test('last9Digits: +31612345678 (11 digits) → 612345678', () => {
  assert.equal(last9Digits('+31612345678'), '612345678');
});

test('last9Digits: te kort (<9 digits) → null', () => {
  assert.equal(last9Digits('12345678'), null);
  assert.equal(last9Digits(''), null);
});

test('last9Digits: null → null', () => {
  assert.equal(last9Digits(null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// phonesLikelyMatch — kern van de fuzzy-match, gebruikt door search-dedupe
// ─────────────────────────────────────────────────────────────────────────────

test('phonesLikelyMatch: NL lokale variant = internationaal', () => {
  assert.equal(phonesLikelyMatch('0612345678', '+31 6 12345678'), true);
  assert.equal(phonesLikelyMatch('0612345678', '0031612345678'), true);
});

test('phonesLikelyMatch: BE lokale variant = internationaal', () => {
  assert.equal(phonesLikelyMatch('0470123456', '+32 470 123 456'), true);
});

test('phonesLikelyMatch: verschillende nummers → false', () => {
  assert.equal(phonesLikelyMatch('0612345678', '0687654321'), false);
});

test('phonesLikelyMatch: één leeg → false (geen ruis-match op leeg)', () => {
  assert.equal(phonesLikelyMatch('', '0612345678'), false);
  assert.equal(phonesLikelyMatch('0612345678', null), false);
  assert.equal(phonesLikelyMatch(null, undefined), false);
});

test('phonesLikelyMatch: identieke digit-strings → true', () => {
  assert.equal(phonesLikelyMatch('0612345678', '0612345678'), true);
});

test('phonesLikelyMatch: opmaak-tolerant (spaties/streepjes)', () => {
  assert.equal(phonesLikelyMatch('06-12-34-56-78', '06 12 34 56 78'), true);
});

test('phonesLikelyMatch: te korte nummers → false (geen last9-match mogelijk)', () => {
  assert.equal(phonesLikelyMatch('12345', '67890'), false);
});
