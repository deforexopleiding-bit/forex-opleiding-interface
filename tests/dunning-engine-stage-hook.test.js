// tests/dunning-engine-stage-hook.test.js
//
// Regressietest voor isAanmaningSendSuccess() — de predicate die bepaalt
// of de stage-hook 'nieuw' → 'aangemaand' triggert na een engine-send.
// Voorkomt dat non-send events (wait/task/failed/skipped) per ongeluk
// de stage forwarden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAanmaningSendSuccess } from '../api/_lib/dunning-engine.js';

// ── True-cases: succesvolle email/whatsapp-send ──────────────────────────

test('email_sent + status ok → true (triggert stage-hook)', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'ok', log_event: 'email_sent' }), true);
});

test('whatsapp_sent + status ok → true (triggert stage-hook)', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'ok', log_event: 'whatsapp_sent' }), true);
});

// ── False-cases: geen send / failed / skipped ────────────────────────────

test('email_send_failed → false', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'failed', log_event: 'email_send_failed' }), false);
});

test('whatsapp_skipped_no_phone → false', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'skipped', log_event: 'whatsapp_skipped_no_phone' }), false);
});

test('whatsapp_skipped_no_payment_link → false (blocked draft)', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'skipped', log_event: 'whatsapp_skipped_no_payment_link' }), false);
});

test('wait-step (ok) → false (geen send)', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'ok', log_event: 'wait' }), false);
});

test('task-step (ok) → false (geen send)', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'ok', log_event: 'task_created' }), false);
});

test('unknown_step_type → false', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'failed', log_event: 'unknown_step_type' }), false);
});

// ── Edge cases: null / undefined / rare shapes ───────────────────────────

test('null → false', () => {
  assert.equal(isAanmaningSendSuccess(null), false);
});

test('undefined → false', () => {
  assert.equal(isAanmaningSendSuccess(undefined), false);
});

test('leeg object → false', () => {
  assert.equal(isAanmaningSendSuccess({}), false);
});

test('status ok maar geen log_event → false', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'ok' }), false);
});

test('log_event email_sent maar status niet ok → false', () => {
  assert.equal(isAanmaningSendSuccess({ status: 'failed', log_event: 'email_sent' }), false);
});
