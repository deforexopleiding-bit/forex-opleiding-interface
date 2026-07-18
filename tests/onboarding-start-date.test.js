// tests/onboarding-start-date.test.js
//
// Regressietest voor de start-date min-gate op onboarding.start_date.
// Test de PURE functies uit api/_lib/onboarding-start-date.js — geen DB,
// geen netwerk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMinOnboardingStartDate,
  compareYmd,
  assertStartDateNotTooEarly,
  ONBOARDING_START_DATE_MIN_OFFSET_DAYS,
} from '../api/_lib/onboarding-start-date.js';

// Vaste NOW voor determinisme: 2026-07-18 12:00 UTC = 14:00 Europe/Amsterdam
// (CEST +02:00 in juli). NL-lokale datum = 2026-07-18. Min = +3 dagen = 2026-07-21.
const NOW = new Date('2026-07-18T12:00:00.000Z');

test('constante: ONBOARDING_START_DATE_MIN_OFFSET_DAYS = 3', () => {
  assert.equal(ONBOARDING_START_DATE_MIN_OFFSET_DAYS, 3);
});

test('getMinOnboardingStartDate: vandaag NL = 2026-07-18 → min = 2026-07-21', () => {
  assert.equal(getMinOnboardingStartDate(NOW), '2026-07-21');
});

test('getMinOnboardingStartDate: laat op de avond NL (23:30) blijft dezelfde NL-dag', () => {
  // 2026-07-18 21:30 UTC = 2026-07-18 23:30 NL → nog steeds "vandaag" = 18 juli.
  const late = new Date('2026-07-18T21:30:00.000Z');
  assert.equal(getMinOnboardingStartDate(late), '2026-07-21');
});

test('getMinOnboardingStartDate: net over middernacht NL (00:15) telt als nieuwe dag', () => {
  // 2026-07-18 22:15 UTC = 2026-07-19 00:15 NL → "vandaag" = 19 juli. Min = 22 juli.
  const justPastMidnight = new Date('2026-07-18T22:15:00.000Z');
  assert.equal(getMinOnboardingStartDate(justPastMidnight), '2026-07-22');
});

test('getMinOnboardingStartDate: DST-boundary (wintertijd → zomertijd) telt gewone kalenderdagen', () => {
  // Winter: 2026-01-15 (NL = UTC+01:00). Vandaag NL = 15 jan. Min = 18 jan.
  const winter = new Date('2026-01-15T12:00:00.000Z');
  assert.equal(getMinOnboardingStartDate(winter), '2026-01-18');
});

test('compareYmd: gelijke datums → 0', () => {
  assert.equal(compareYmd('2026-07-21', '2026-07-21'), 0);
});

test('compareYmd: a < b → -1', () => {
  assert.equal(compareYmd('2026-07-20', '2026-07-21'), -1);
});

test('compareYmd: a > b → 1', () => {
  assert.equal(compareYmd('2026-07-22', '2026-07-21'), 1);
});

test('compareYmd: ongeldige input → null', () => {
  assert.equal(compareYmd('vandaag', '2026-07-21'), null);
  assert.equal(compareYmd('2026-7-21', '2026-07-21'), null); // ontbrekende padding
  assert.equal(compareYmd(null, '2026-07-21'), null);
});

test('assertStartDateNotTooEarly: leeg / null → OK (backward-compat)', () => {
  assert.equal(assertStartDateNotTooEarly(null, NOW), null);
  assert.equal(assertStartDateNotTooEarly('', NOW), null);
  assert.equal(assertStartDateNotTooEarly(undefined, NOW), null);
});

test('assertStartDateNotTooEarly: datum = min → OK', () => {
  assert.equal(assertStartDateNotTooEarly('2026-07-21', NOW), null);
});

test('assertStartDateNotTooEarly: datum > min → OK', () => {
  assert.equal(assertStartDateNotTooEarly('2026-07-22', NOW), null);
  assert.equal(assertStartDateNotTooEarly('2026-12-01', NOW), null);
});

test('assertStartDateNotTooEarly: vandaag (2026-07-18) → TOO_EARLY', () => {
  const err = assertStartDateNotTooEarly('2026-07-18', NOW);
  assert.ok(err);
  assert.equal(err.code, 'START_DATE_TOO_EARLY');
  assert.equal(err.min, '2026-07-21');
  assert.equal(err.got, '2026-07-18');
});

test('assertStartDateNotTooEarly: min - 1 dag → TOO_EARLY', () => {
  const err = assertStartDateNotTooEarly('2026-07-20', NOW);
  assert.ok(err);
  assert.equal(err.code, 'START_DATE_TOO_EARLY');
});

test('assertStartDateNotTooEarly: datum in het verleden → TOO_EARLY', () => {
  const err = assertStartDateNotTooEarly('2025-01-01', NOW);
  assert.ok(err);
  assert.equal(err.code, 'START_DATE_TOO_EARLY');
});

test('assertStartDateNotTooEarly: ongeldig formaat → INVALID (geen crash)', () => {
  const err = assertStartDateNotTooEarly('18-07-2026', NOW);
  assert.ok(err);
  assert.equal(err.code, 'START_DATE_INVALID');
});
