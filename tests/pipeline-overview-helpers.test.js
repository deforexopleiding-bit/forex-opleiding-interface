// tests/pipeline-overview-helpers.test.js
//
// Unit tests voor api/_lib/pipeline-overview-helpers.js. Volledig pure
// functies — geen DB, geen mocks, alleen fixture-input.
//
// Test-scope:
//   - classifyRunBucket: 8 buckets + edge-cases
//   - reconstructPauseReason: alle 5 reden-categorieën
//   - projectRunTimeline: 22-stap workflow → verwachte data
//   - buildBucketCounts: aggregatie met completion_reason-split
//   - incassoCondition: kandidaat vs generieke drempel

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRunBucket,
  reconstructPauseReason,
  projectRunTimeline,
  incassoCondition,
  buildBucketCounts,
  BUCKET_VANDAAG,
  BUCKET_MORGEN,
  BUCKET_LATER,
  BUCKET_WACHT_KLANT,
  BUCKET_WACHT_REGELING,
  BUCKET_WACHT_GESPREK,
  BUCKET_WACHT_HANDMATIG,
  BUCKET_WACHT_OPENSTAANDE_ACTIE,
  BUCKET_KLAAR,
} from '../api/_lib/pipeline-overview-helpers.js';

// NOW = vr 24 juli 2026 12:00 NL (10:00 UTC, CEST +2). Vandaag NL = 24 jul.
const NOW_MS = Date.parse('2026-07-24T10:00:00Z');
const iso    = (offsetMs) => new Date(NOW_MS + offsetMs).toISOString();
const days   = (n) => n * 86400000;

// ═══════════ classifyRunBucket ═════════════════════════════════════════

// ── vandaag / morgen / later — NL-kalenderdag-buckets ────────────────────

test('bucket: active met next_action_at = vandaag 14:00 NL → vandaag', () => {
  // 12:00 UTC = 14:00 NL op 24 juli
  const run = { status: 'active', next_action_at: '2026-07-24T12:00:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_VANDAAG);
});

test('bucket: active met next_action_at in het verleden → vandaag (moet nu opgepakt worden)', () => {
  const run = { status: 'active', next_action_at: iso(-days(3)) };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_VANDAAG);
});

test('bucket: active met next_action_at = morgen 09:00 NL → morgen', () => {
  // 07:00 UTC 25 juli = 09:00 NL op 25 juli
  const run = { status: 'active', next_action_at: '2026-07-25T07:00:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_MORGEN);
});

test('bucket: active met next_action_at = overmorgen → later', () => {
  const run = { status: 'active', next_action_at: '2026-07-26T09:00:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_LATER);
});

test('bucket: active met next_action_at = 14 dagen weg → later', () => {
  const run = { status: 'active', next_action_at: iso(days(14)) };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_LATER);
});

test('bucket: active zonder next_action_at → later (defensief)', () => {
  const run = { status: 'active', next_action_at: null };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_LATER);
});

// ── Middernacht-overgang NL-tijd (kritiek edge-case) ─────────────────────

test('bucket: 23:59 NL vandaag → vandaag (net vóór middernacht)', () => {
  // 21:59 UTC 24 juli = 23:59 NL 24 juli (CEST +2 in juli)
  const run = { status: 'active', next_action_at: '2026-07-24T21:59:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_VANDAAG);
});

test('bucket: 00:00 NL morgen → morgen (net na middernacht)', () => {
  // 22:00 UTC 24 juli = 00:00 NL 25 juli
  const run = { status: 'active', next_action_at: '2026-07-24T22:00:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_MORGEN);
});

test('bucket: 00:01 NL morgen → morgen', () => {
  // 22:01 UTC 24 juli = 00:01 NL 25 juli
  const run = { status: 'active', next_action_at: '2026-07-24T22:01:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_MORGEN);
});

test('bucket: 23:59 NL morgen → morgen (net vóór einde morgen)', () => {
  // 21:59 UTC 25 juli = 23:59 NL 25 juli
  const run = { status: 'active', next_action_at: '2026-07-25T21:59:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_MORGEN);
});

test('bucket: 00:00 NL overmorgen → later (net na einde morgen)', () => {
  // 22:00 UTC 25 juli = 00:00 NL 26 juli
  const run = { status: 'active', next_action_at: '2026-07-25T22:00:00Z' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_LATER);
});

test('bucket: NL-tijd wordt CORRECT bepaald bij DST-grens — winter (CET +1)', () => {
  // Winter: 23:00 UTC = 00:00 NL. NOW in januari CET +1.
  const winterNow = Date.parse('2026-01-15T12:00:00Z');   // vandaag NL = 15 jan
  const run = { status: 'active', next_action_at: '2026-01-15T23:00:00Z' };  // = 00:00 NL 16 jan
  assert.equal(classifyRunBucket(run, null, winterNow), BUCKET_MORGEN);
});

// ── Overige bucket-tests ──────────────────────────────────────────────────

test('bucket: active + laatste log skipped_open_action → wacht_openstaande_actie', () => {
  const run = { status: 'active', next_action_at: iso(days(3)) };
  const log = { event_type: 'skipped_open_action', created_at: iso(-days(1)) };
  assert.equal(classifyRunBucket(run, log, NOW_MS), BUCKET_WACHT_OPENSTAANDE_ACTIE);
});

test('bucket: paused + paused_by_arrangement_id → wacht_regeling', () => {
  const run = { status: 'paused', paused_by_arrangement_id: 'a-1' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_WACHT_REGELING);
});

test('bucket: paused + paused_by_conversation_id → wacht_gesprek', () => {
  const run = { status: 'paused', paused_by_conversation_id: 'c-1' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_WACHT_GESPREK);
});

test('bucket: paused + laatste log paused_customer_replied → wacht_klant', () => {
  const run = { status: 'paused' };
  const log = { event_type: 'paused_customer_replied', payload: { channel: 'whatsapp' } };
  assert.equal(classifyRunBucket(run, log, NOW_MS), BUCKET_WACHT_KLANT);
});

test('bucket: paused + laatste log run_control_pause → wacht_handmatig', () => {
  const run = { status: 'paused' };
  const log = { event_type: 'run_control_pause', payload: { user_id: 'u-1' } };
  assert.equal(classifyRunBucket(run, log, NOW_MS), BUCKET_WACHT_HANDMATIG);
});

test('bucket: paused zonder kolom en zonder log → wacht_handmatig (safer default)', () => {
  const run = { status: 'paused' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_WACHT_HANDMATIG);
});

test('bucket: kolom-first wint van log — arrangement + skipped_open_action-log → wacht_regeling', () => {
  const run = { status: 'paused', paused_by_arrangement_id: 'a-1' };
  const log = { event_type: 'skipped_open_action' };
  assert.equal(classifyRunBucket(run, log, NOW_MS), BUCKET_WACHT_REGELING);
});

test('bucket: completed → klaar', () => {
  const run = { status: 'completed', completion_reason: 'paid' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_KLAAR);
});

test('bucket: cancelled → klaar', () => {
  const run = { status: 'cancelled', completion_reason: 'manual_cancel_by_user' };
  assert.equal(classifyRunBucket(run, null, NOW_MS), BUCKET_KLAAR);
});

test('bucket: null/onbekende status → null', () => {
  assert.equal(classifyRunBucket({ status: 'foo' }, null, NOW_MS), null);
  assert.equal(classifyRunBucket(null, null, NOW_MS), null);
});

// ═══════════ reconstructPauseReason ═════════════════════════════════════

test('reason: paused + arrangement_id → code=arrangement + heldere tekst', () => {
  const run = { status: 'paused', paused_by_arrangement_id: 'a-1', updated_at: iso(-days(2)) };
  const r = reconstructPauseReason(run, null);
  assert.equal(r.code, 'arrangement');
  assert.match(r.message, /regeling is actief/i);
  assert.ok(r.at);
});

test('reason: paused + conversation_id → code=conversation', () => {
  const run = { status: 'paused', paused_by_conversation_id: 'c-1' };
  const r = reconstructPauseReason(run, null);
  assert.equal(r.code, 'conversation');
  assert.match(r.message, /gesprek/i);
});

test('reason: paused + customer_replied-log → code=customer_replied met channel', () => {
  const run = { status: 'paused' };
  const log = { event_type: 'paused_customer_replied', payload: { channel: 'whatsapp' }, created_at: iso(-days(1)) };
  const r = reconstructPauseReason(run, log);
  assert.equal(r.code, 'customer_replied');
  assert.equal(r.channel, 'whatsapp');
  assert.match(r.message, /via whatsapp/i);
});

test('reason: paused + run_control_pause-log → code=manual met user_id', () => {
  const run = { status: 'paused' };
  const log = { event_type: 'run_control_pause', payload: { user_id: 'jeffrey-uid' } };
  const r = reconstructPauseReason(run, log);
  assert.equal(r.code, 'manual');
  assert.equal(r.user_id, 'jeffrey-uid');
});

test('reason: active + skipped_open_action-log → code=open_action met count + typen', () => {
  const run = { status: 'active' };
  const log = {
    event_type: 'skipped_open_action',
    payload: { count: 2, action_types: ['MANUAL_VERIFY_PAYMENT', 'TL_INVOICE_UPDATE_DUE'] },
    created_at: iso(-days(1)),
  };
  const r = reconstructPauseReason(run, log);
  assert.equal(r.code, 'open_action');
  assert.match(r.message, /2/);
  assert.match(r.message, /MANUAL_VERIFY_PAYMENT/);
});

test('reason: active zonder skip-log → null (geen reden)', () => {
  const run = { status: 'active', next_action_at: iso(days(3)) };
  assert.equal(reconstructPauseReason(run, null), null);
});

test('reason: paused zonder enige info → code=manual met "reden onbekend"', () => {
  const run = { status: 'paused' };
  const r = reconstructPauseReason(run, null);
  assert.equal(r.code, 'manual');
  assert.match(r.message, /onbekend/i);
});

// ═══════════ projectRunTimeline ═════════════════════════════════════════

test('project: active run, deterministische vooruit-rekening op 22-stap workflow', () => {
  // Simuleer stappen 1-6 uit de "Aanmaningen"-flow (wait-days: 7,7,1,2,4,15).
  const steps = [
    { id: 's1', workflow_id: 'wf1', step_order: 1, step_type: 'email',    config: {} },
    { id: 's2', workflow_id: 'wf1', step_order: 2, step_type: 'wait',     config: { days: 7 } },
    { id: 's3', workflow_id: 'wf1', step_order: 3, step_type: 'whatsapp', config: {} },
    { id: 's4', workflow_id: 'wf1', step_order: 4, step_type: 'wait',     config: { days: 7 } },
    { id: 's5', workflow_id: 'wf1', step_order: 5, step_type: 'email',    config: {} },
    { id: 's6', workflow_id: 'wf1', step_order: 6, step_type: 'wait',     config: { days: 15 } },
  ];
  const run = {
    status: 'active',
    workflow_id: 'wf1',
    current_step_id: 's3',    // huidige stap = whatsapp (order 3)
    next_action_at: iso(0),   // vandaag
  };
  const p = projectRunTimeline(run, steps, NOW_MS);
  assert.ok(p);
  assert.equal(p.current_step.order, 3);
  assert.equal(p.current_step.type, 'whatsapp');
  assert.equal(p.total_steps, 6);
  assert.equal(p.next_action.at, iso(0));
  assert.equal(p.next_action.is_estimate, false);
  // Eerstvolgende contact NA de wait van 7d = email op vandaag+7d.
  assert.equal(p.next_contact.at, iso(days(7)));
  assert.equal(p.next_contact.is_estimate, true);
  assert.equal(p.is_estimate, true);
});

test('project: paused run → null (geen projectie)', () => {
  const steps = [{ id: 's1', workflow_id: 'wf1', step_order: 1, step_type: 'email', config: {} }];
  const run = { status: 'paused', workflow_id: 'wf1', current_step_id: 's1' };
  assert.equal(projectRunTimeline(run, steps, NOW_MS), null);
});

test('project: completed run → null', () => {
  assert.equal(projectRunTimeline({ status: 'completed' }, [], NOW_MS), null);
});

test('project: current_step_id niet in steps → null (step_missing edge)', () => {
  const steps = [{ id: 's1', workflow_id: 'wf1', step_order: 1, step_type: 'email', config: {} }];
  const run = { status: 'active', current_step_id: 's-onbekend' };
  assert.equal(projectRunTimeline(run, steps, NOW_MS), null);
});

test('project: geen resterende contact-stappen na huidige → next_contact=null', () => {
  const steps = [
    { id: 's1', step_order: 1, step_type: 'email', config: {} },
    { id: 's2', step_order: 2, step_type: 'wait',  config: { days: 5 } },
    { id: 's3', step_order: 3, step_type: 'stop',  config: {} },
  ];
  const run = { status: 'active', current_step_id: 's1', next_action_at: iso(0) };
  const p = projectRunTimeline(run, steps, NOW_MS);
  assert.equal(p.next_contact, null);
});

// ═══════════ incassoCondition ═══════════════════════════════════════════

test('incasso: VERBROKEN arrangement → is_candidate=true', () => {
  const r = incassoCondition([{ status: 'VERBROKEN' }], false, { min_days_overdue: 14 });
  assert.equal(r.is_candidate, true);
  assert.match(r.message, /verbroken/i);
});

test('incasso: refusal-flag → is_candidate=true', () => {
  const r = incassoCondition([], true, { min_days_overdue: 14 });
  assert.equal(r.is_candidate, true);
  assert.match(r.message, /weigering/i);
});

test('incasso: geen kandidaat → generieke drempel-tekst met dagen', () => {
  const r = incassoCondition([{ status: 'ACTIEF' }], false, { min_days_overdue: 21 });
  assert.equal(r.is_candidate, false);
  assert.match(r.message, /21/);
});

test('incasso: settings leeg → default 14 dagen in tekst', () => {
  const r = incassoCondition([], false, {});
  assert.equal(r.is_candidate, false);
  assert.match(r.message, /14/);
});

// ═══════════ buildBucketCounts ═════════════════════════════════════════

test('counts: mixed runs → juiste tellers per bucket + klaar_by_reason', () => {
  const runs = [
    { _bucket: BUCKET_VANDAAG },
    { _bucket: BUCKET_VANDAAG },
    { _bucket: BUCKET_MORGEN },
    { _bucket: BUCKET_LATER },
    { _bucket: BUCKET_WACHT_KLANT },
    { _bucket: BUCKET_WACHT_REGELING },
    { _bucket: BUCKET_KLAAR, completion_reason: 'paid' },
    { _bucket: BUCKET_KLAAR, completion_reason: 'paid' },
    { _bucket: BUCKET_KLAAR, completion_reason: 'manual_cancel_by_user' },
  ];
  const { counts, klaar_by_reason } = buildBucketCounts(runs);
  assert.equal(counts[BUCKET_VANDAAG], 2);
  assert.equal(counts[BUCKET_MORGEN], 1);
  assert.equal(counts[BUCKET_LATER], 1);
  assert.equal(counts[BUCKET_WACHT_KLANT], 1);
  assert.equal(counts[BUCKET_WACHT_REGELING], 1);
  assert.equal(counts[BUCKET_KLAAR], 3);
  assert.equal(klaar_by_reason.paid, 2);
  assert.equal(klaar_by_reason.manual_cancel_by_user, 1);
});

test('counts: klaar zonder completion_reason → key "onbekend"', () => {
  const runs = [{ _bucket: BUCKET_KLAAR, completion_reason: null }];
  const { klaar_by_reason } = buildBucketCounts(runs);
  assert.equal(klaar_by_reason.onbekend, 1);
});

test('counts: lege input → alle tellers 0, klaar_by_reason={}', () => {
  const { counts, klaar_by_reason } = buildBucketCounts([]);
  assert.equal(counts[BUCKET_VANDAAG], 0);
  assert.equal(counts[BUCKET_MORGEN], 0);
  assert.equal(counts[BUCKET_LATER], 0);
  assert.equal(counts[BUCKET_KLAAR], 0);
  assert.deepEqual(klaar_by_reason, {});
});
