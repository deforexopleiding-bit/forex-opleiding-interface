// tests/sales-reservation-fee-bypass.test.js
//
// Unit-tests voor validateBypassRequest — de pure helper die bepaalt of
// een reserveringsfee-bypass mag doorgaan. Fail-secure gedrag is de kern:
// bypass wordt alleen goedgekeurd bij (a) strict body.bypass_reservation_fee===true,
// (b) hasPermission===true, én (c) geldige reden (>=10 chars na trim).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBypassRequest } from '../api/_lib/reservation-fee-bypass.js';

// ── Happy path ─────────────────────────────────────────────────────────────

test('bypass niet gevraagd → { bypassApproved: false }', () => {
  const r = validateBypassRequest({}, true);
  assert.deepEqual(r, { bypassApproved: false });
});

test('bypass niet gevraagd (body-veld ontbreekt), zelfs met perm → geen approve', () => {
  const r = validateBypassRequest({ subscriptions: [{}] }, true);
  assert.deepEqual(r, { bypassApproved: false });
});

test('bypass gevraagd + perm + geldige reden → { bypassApproved: true, reason }', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: 'On hold 3 maanden' },
    true
  );
  assert.equal(r.bypassApproved, true);
  assert.equal(r.reason, 'On hold 3 maanden');
});

// ── Fail-secure: permissie ─────────────────────────────────────────────────

test('bypass gevraagd zonder perm → 403 no-permission (geldige reden mag niet redden)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: 'volstrekt geldige reden' },
    false
  );
  assert.equal(r.status, 403);
  assert.equal(r.error, 'no-permission');
  assert.ok(!('bypassApproved' in r) || r.bypassApproved !== true, 'bypass mag NIET zijn goedgekeurd');
});

// ── Fail-secure: reden ─────────────────────────────────────────────────────

test('bypass gevraagd met perm, geen reden → 422 reason-required', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true },
    true
  );
  assert.equal(r.status, 422);
  assert.equal(r.error, 'reason-required');
});

test('bypass gevraagd met perm, lege string als reden → 422', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: '' },
    true
  );
  assert.equal(r.status, 422);
  assert.equal(r.error, 'reason-required');
});

test('bypass gevraagd met perm, alleen whitespace als reden → 422', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: '   \t\n  ' },
    true
  );
  assert.equal(r.status, 422);
  assert.equal(r.error, 'reason-required');
});

test('bypass gevraagd met perm, reden = 9 chars → 422 (grens: min. 10)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: '123456789' },
    true
  );
  assert.equal(r.status, 422);
  assert.equal(r.error, 'reason-required');
});

test('bypass gevraagd met perm, reden = precies 10 chars → approved', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: '1234567890' },
    true
  );
  assert.equal(r.bypassApproved, true);
  assert.equal(r.reason, '1234567890');
});

// ── Body-shape edge-cases ──────────────────────────────────────────────────

test('bypass=string "true" is NIET goed genoeg (strict boolean check)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: 'true', bypass_reason: 'geldige reden' },
    true
  );
  assert.deepEqual(r, { bypassApproved: false });
});

test('bypass=1 (number truthy) is NIET goed genoeg (strict boolean check)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: 1, bypass_reason: 'geldige reden' },
    true
  );
  assert.deepEqual(r, { bypassApproved: false });
});

test('bypass=false expliciet + reden ingevuld → bypass niet aan (reden is irrelevant)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: false, bypass_reason: 'wel iets ingevuld' },
    true
  );
  assert.deepEqual(r, { bypassApproved: false });
});

test('lege body → geen bypass, geen error', () => {
  const r = validateBypassRequest({}, true);
  assert.deepEqual(r, { bypassApproved: false });
});

test('null body → geen crash, geen bypass', () => {
  const r = validateBypassRequest(null, true);
  assert.deepEqual(r, { bypassApproved: false });
});

test('undefined body → geen crash, geen bypass', () => {
  const r = validateBypassRequest(undefined, true);
  assert.deepEqual(r, { bypassApproved: false });
});

// ── Regressie-guards ───────────────────────────────────────────────────────

test('reason met leading/trailing whitespace: trim werkt, count na trim >=10 telt', () => {
  // 8 tekens body + 4 spaces padding — na trim: 8 → 422.
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: '  abcdefgh  ' },
    true
  );
  assert.equal(r.status, 422);
  assert.equal(r.error, 'reason-required');
});

test('reason met leading/trailing whitespace: trim werkt, resultaat is geschoond', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: '  precies tien!  ' },
    true
  );
  assert.equal(r.bypassApproved, true);
  assert.equal(r.reason, 'precies tien!', 'reason moet getrimd zijn — audit-log krijgt schone tekst');
});

test('reason=null met bypass=true + perm → 422 (geen crash op toLowerCase o.i.d.)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: null },
    true
  );
  assert.equal(r.status, 422);
});

test('reason=nummer met bypass=true + perm → 422 (String() coerce, dan trim)', () => {
  const r = validateBypassRequest(
    { bypass_reservation_fee: true, bypass_reason: 12345 },
    true
  );
  // String(12345) = '12345', trim = '12345', length 5 → onvoldoende.
  assert.equal(r.status, 422);
});
