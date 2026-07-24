// tests/subscription-start-date-decouple.test.js
//
// Regressietest die expliciet vastlegt dat subscription-startdatums een
// ANDERE ondergrens hebben dan onboarding-startdatums:
//
//   onboarding / deal → assertStartDateNotTooEarly (vandaag+3d) — BEHOUDEN
//   subscription      → assertDateNotInPast        (vandaag)    — losgekoppeld
//
// De reden staat uitvoerig in api/sales-subscription-create.js (comment
// bij de gate op r~118) en modules/subscription-wizard.html (comment bij
// _swMinStartDateNL). Kort samengevat:
//   - Bubble krijgt subscription.start_date NIET (alleen onboarding).
//   - Er wordt nergens (sub.start_date − N dagen) berekend.
//   - Empirisch geverifieerd: sub ff40e1af-… had start_date 4d vóór
//     created_at en factureerde correct.
//
// Deze tests bewaken dat een toekomstige "consolidatie" (zoals #819) de
// twee semantieken NIET per ongeluk weer samensmelt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertStartDateNotTooEarly,
  assertDateNotInPast,
  getMinOnboardingStartDate,
  getTodayNL,
} from '../api/_lib/onboarding-start-date.js';

// Vaste NOW (ma 2026-07-27 12:00 UTC → 14:00 NL, CEST). NL-datum = 2026-07-27.
// Onboarding-min = +3d = 2026-07-30. Vandaag-NL = 2026-07-27.
const NOW = new Date('2026-07-27T12:00:00.000Z');

test('onboarding-regel: vandaag NL is TE VROEG (+3d gate)', () => {
  const today = getTodayNL(NOW);
  const err = assertStartDateNotTooEarly(today, NOW);
  assert.ok(err, 'vandaag moet als te vroeg worden geweigerd voor onboarding');
  assert.equal(err.code, 'START_DATE_TOO_EARLY');
  assert.equal(err.min, getMinOnboardingStartDate(NOW));  // vandaag+3d
  assert.equal(err.got, today);
});

test('subscription-regel: vandaag NL is OK (alleen niet-in-verleden gate)', () => {
  const today = getTodayNL(NOW);
  const err = assertDateNotInPast(today, 'subscription start_date', NOW);
  assert.equal(err, null, 'vandaag moet OK zijn voor subscription');
});

test('subscription-regel: MORGEN NL is OK', () => {
  const tomorrow = '2026-07-28';
  const err = assertDateNotInPast(tomorrow, 'subscription start_date', NOW);
  assert.equal(err, null);
});

test('subscription-regel: GISTEREN NL wordt geweigerd (server-side no-past)', () => {
  const yesterday = '2026-07-26';
  const err = assertDateNotInPast(yesterday, 'subscription start_date', NOW);
  assert.ok(err, 'gisteren moet geweigerd worden');
  assert.equal(err.code, 'DATE_IN_PAST');
  assert.equal(err.got, yesterday);
  assert.equal(err.field, 'subscription start_date');
});

test('semantiek-boundary: vandaag+1 wordt door onboarding geweigerd maar door subscription geaccepteerd', () => {
  const oneDayAhead = '2026-07-28';
  // Onboarding-min is vandaag+3d = 2026-07-30, dus 2026-07-28 is te vroeg.
  const onErr = assertStartDateNotTooEarly(oneDayAhead, NOW);
  assert.ok(onErr, 'onboarding: vandaag+1d nog te vroeg');
  assert.equal(onErr.code, 'START_DATE_TOO_EARLY');
  // Subscription: vandaag+1d is toekomst → OK.
  const subErr = assertDateNotInPast(oneDayAhead, 'subscription start_date', NOW);
  assert.equal(subErr, null, 'subscription: vandaag+1d wel toegestaan');
});

test('regressie-guard: assertStartDateNotTooEarly en assertDateNotInPast zijn TWEE aparte gates', () => {
  // Deze test bewaakt dat een toekomstige refactor de twee helpers niet
  // per ongeluk samensmelt. Dezelfde datum → verschillende uitkomst.
  const today = getTodayNL(NOW);
  const onboardingResult = assertStartDateNotTooEarly(today, NOW);
  const subscriptionResult = assertDateNotInPast(today, 'x', NOW);
  assert.notEqual(
    onboardingResult === null,
    subscriptionResult === null,
    'de twee helpers moeten VERSCHILLEND oordelen over "vandaag NL"'
  );
});
