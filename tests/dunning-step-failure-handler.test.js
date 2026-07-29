// tests/dunning-step-failure-handler.test.js
//
// Pure unit-tests voor het retry+escalatie-pad van advanceActiveRuns.
// Bewijst zowel de faal-paden (retry × 2 → escalate op 3e) als de
// happy-path-symmetrie: een succesvolle send na eerdere fails clear't
// step_failure_count én needs_attention, met een resolved-event zodat
// de audit-trail intact blijft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RETRIES,
  RETRY_DELAY_HOURS,
  buildFailureReason,
  evaluateStepFailure,
  evaluateSuccessAfterFailure,
} from '../api/_lib/dunning-step-failure-handler.js';

const NOW_ISO = '2026-07-29T12:00:00.000Z';

// ── buildFailureReason ─────────────────────────────────────────────────────

test('buildFailureReason: log_event + meta_code → "event:code"', () => {
  const r = buildFailureReason({ log_event: 'whatsapp_send_failed', log_payload: { meta_code: 132000 } });
  assert.equal(r, 'whatsapp_send_failed:132000');
});

test('buildFailureReason: alleen log_event → geen colon', () => {
  const r = buildFailureReason({ log_event: 'email_send_failed', log_payload: { some: 'x' } });
  assert.equal(r, 'email_send_failed');
});

test('buildFailureReason: geen log_event → "unknown"', () => {
  assert.equal(buildFailureReason({}), 'unknown');
  assert.equal(buildFailureReason(null), 'unknown');
});

// ── evaluateStepFailure: retry-tak (attempts 1 en 2) ───────────────────────

test('1e fail (count 0→1): retry met next_action_at nu+24u, current_step_id blijft ongewijzigd', () => {
  const r = evaluateStepFailure({
    currentCount: 0,
    stepResult:   { status: 'failed', log_event: 'whatsapp_send_failed', log_payload: { meta_code: 132000 } },
    nowIso:       NOW_ISO,
  });
  assert.equal(r.action, 'retry');
  assert.equal(r.update.step_failure_count, 1);
  assert.equal(r.update.needs_attention, undefined, 'needs_attention NIET gezet bij retry');
  assert.equal(r.update.next_action_at, '2026-07-30T12:00:00.000Z', 'nu + 24u');
  assert.equal(r.update.last_failure_reason, 'whatsapp_send_failed:132000');
  assert.equal(r.log_event, 'step_failed_retry');
  assert.equal(r.log_payload.attempt, 1);
  assert.equal(r.log_payload.max_retries, MAX_RETRIES);
  assert.equal(r.break_loop, true);
  // Cruciaal: geen current_step_id in de update — engine moet 'em NIET wijzigen.
  assert.equal(r.update.current_step_id, undefined);
});

test('2e fail (count 1→2): nog steeds retry', () => {
  const r = evaluateStepFailure({
    currentCount: 1,
    stepResult:   { status: 'failed', log_event: 'whatsapp_send_failed', log_payload: { meta_code: 132000 } },
    nowIso:       NOW_ISO,
  });
  assert.equal(r.action, 'retry');
  assert.equal(r.update.step_failure_count, 2);
  assert.equal(r.log_payload.attempt, 2);
});

// ── evaluateStepFailure: escalatie-tak (3e fail) ───────────────────────────

test('3e fail (count 2→3): escalate met needs_attention=true, GEEN next_action_at update', () => {
  const r = evaluateStepFailure({
    currentCount: 2,
    stepResult:   { status: 'failed', log_event: 'whatsapp_send_failed', log_payload: { meta_code: 132000 } },
    nowIso:       NOW_ISO,
  });
  assert.equal(r.action, 'escalate');
  assert.equal(r.update.needs_attention, true);
  assert.equal(r.update.step_failure_count, 3);
  assert.equal(r.update.last_failure_reason, 'whatsapp_send_failed:132000');
  // Bewust GEEN next_action_at — engine skipt de run via de selectie-filter
  // needs_attention=false, dus verdere retry-scheduling is niet nodig.
  assert.equal(r.update.next_action_at, undefined);
  assert.equal(r.update.current_step_id, undefined);
  assert.equal(r.log_event, 'step_failed_final');
  assert.equal(r.log_payload.attempt, 3);
  assert.equal(r.break_loop, true);
});

test('override maxRetries=2: 2e fail → escalate', () => {
  const r = evaluateStepFailure({
    currentCount: 1,
    stepResult:   { status: 'failed', log_event: 'x' },
    nowIso:       NOW_ISO,
    maxRetries:   2,
  });
  assert.equal(r.action, 'escalate');
  assert.equal(r.update.step_failure_count, 2);
});

test('override retryDelayHours=6: next_action_at wordt nu+6u', () => {
  const r = evaluateStepFailure({
    currentCount: 0,
    stepResult:   { status: 'failed', log_event: 'x' },
    nowIso:       NOW_ISO,
    retryDelayHours: 6,
  });
  assert.equal(r.action, 'retry');
  assert.equal(r.update.next_action_at, '2026-07-29T18:00:00.000Z');
});

test('currentCount=null/undefined → behandel als 0', () => {
  const r1 = evaluateStepFailure({ currentCount: null,      stepResult: { status: 'failed', log_event: 'x' }, nowIso: NOW_ISO });
  const r2 = evaluateStepFailure({ currentCount: undefined, stepResult: { status: 'failed', log_event: 'x' }, nowIso: NOW_ISO });
  assert.equal(r1.update.step_failure_count, 1);
  assert.equal(r2.update.step_failure_count, 1);
});

// ── evaluateSuccessAfterFailure: happy path met eerdere fails ─────────────

test('geen eerdere fails + geen needs_attention → geen clear (no-op)', () => {
  const r = evaluateSuccessAfterFailure({ run: { step_failure_count: 0, needs_attention: false } });
  assert.equal(r.should_clear, false);
  assert.deepEqual(r.update_patch, {});
  assert.equal(r.log_event, undefined, 'geen resolved-event bij no-op');
});

test('eerdere fails (count>0) maar geen needs_attention → clear count, geen attention-log', () => {
  const r = evaluateSuccessAfterFailure({ run: { step_failure_count: 2, needs_attention: false, last_failure_reason: 'whatsapp_send_failed:132000' } });
  assert.equal(r.should_clear, true);
  assert.equal(r.update_patch.step_failure_count, 0);
  assert.equal(r.update_patch.needs_attention, undefined, 'needs_attention niet in patch — was al false');
  // Wel log-event: audit-spoor dat de flaky-fase voorbij is.
  assert.equal(r.log_event, 'needs_attention_resolved');
  assert.equal(r.log_payload.previously_flagged, false);
  assert.equal(r.log_payload.previous_failures, 2);
});

test('needs_attention=true + fails → clear beide + resolved-event met eerdere reden', () => {
  const r = evaluateSuccessAfterFailure({
    run: {
      step_failure_count:  3,
      needs_attention:     true,
      last_failure_reason: 'whatsapp_send_failed:132000',
    },
  });
  assert.equal(r.should_clear, true);
  assert.equal(r.update_patch.step_failure_count, 0);
  assert.equal(r.update_patch.needs_attention, false, 'flag wordt gewist');
  assert.equal(r.log_event, 'needs_attention_resolved');
  assert.equal(r.log_payload.previous_reason, 'whatsapp_send_failed:132000');
  assert.equal(r.log_payload.previous_failures, 3);
  assert.equal(r.log_payload.previously_flagged, true);
});

// ── Regressie-guard: happy path (count 0, geen attention) mag NOOIT clearen ─

test('regressie: succesvolle 1e send zonder eerdere fails → puur no-op', () => {
  const r = evaluateSuccessAfterFailure({ run: { step_failure_count: 0, needs_attention: false } });
  assert.equal(r.should_clear, false);
  // Bewijs dat de engine dus NIETS extras hoeft te doen op de happy path
  // — geen resolved-log, geen patch, geen wasted DB-writes.
  assert.deepEqual(Object.keys(r.update_patch), []);
});

test('regressie: run zonder fields (undefined) → no-op zonder crash', () => {
  const r = evaluateSuccessAfterFailure({ run: {} });
  assert.equal(r.should_clear, false);
});

test('regressie: run=null → no-op zonder crash', () => {
  const r = evaluateSuccessAfterFailure({ run: null });
  assert.equal(r.should_clear, false);
});
