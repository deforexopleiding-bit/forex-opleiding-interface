// tests/customer-dossier-signals.test.js
//
// Unit-test voor api/_lib/customer-dossier-signals.js. Volledig pure functie —
// input is opgezette fixture-data, output is een lijst van signaal-objecten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSignals } from '../api/_lib/customer-dossier-signals.js';

const NOW_MS = Date.parse('2026-07-24T10:00:00Z');
const daysAgo = (n) => new Date(NOW_MS - n * 86400000).toISOString();

function codes(signals) {
  return signals.map((s) => s.code);
}

// ── 1. ACTION_APPROVED_NOT_EXECUTED ───────────────────────────────────────

test('signal: APPROVED zonder EXECUTED > 2 dagen → ACTION_APPROVED_NOT_EXECUTED', () => {
  const signals = detectSignals({
    pendingActions: [
      { id: 'pa1', action_type: 'TL_INVOICE_UPDATE_DUE', status: 'APPROVED',
        approved_at: daysAgo(3), executed_at: null },
    ],
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'ACTION_APPROVED_NOT_EXECUTED');
  assert.ok(s, 'signal moet gevonden zijn');
  assert.equal(s.severity, 'warning');
  assert.equal(s.evidence.days_open, 3);
});

test('signal: APPROVED zonder EXECUTED = 1 dag → NIET gemeld', () => {
  const signals = detectSignals({
    pendingActions: [
      { id: 'pa1', action_type: 'x', status: 'APPROVED', approved_at: daysAgo(1), executed_at: null },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('ACTION_APPROVED_NOT_EXECUTED'), false);
});

test('signal: APPROVED > 7 dagen → severity=critical', () => {
  const signals = detectSignals({
    pendingActions: [
      { id: 'pa1', action_type: 'x', status: 'APPROVED', approved_at: daysAgo(10), executed_at: null },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(signals[0].severity, 'critical');
});

test('signal: EXECUTED wordt niet gemeld', () => {
  const signals = detectSignals({
    pendingActions: [
      { id: 'pa1', action_type: 'x', status: 'EXECUTED', approved_at: daysAgo(10), executed_at: daysAgo(1) },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('ACTION_APPROVED_NOT_EXECUTED'), false);
});

// ── 2. RUN_PAUSED_NO_OWNER ────────────────────────────────────────────────

test('signal: paused run zonder open actie → RUN_PAUSED_NO_OWNER', () => {
  const signals = detectSignals({
    runs: [{ id: 'r1', status: 'paused', updated_at: daysAgo(2) }],
    pendingActions: [],  // geen open actie
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'RUN_PAUSED_NO_OWNER');
  assert.ok(s);
  assert.deepEqual(s.evidence.run_ids, ['r1']);
});

test('signal: paused run MET open PENDING actie → NIET gemeld', () => {
  const signals = detectSignals({
    runs: [{ id: 'r1', status: 'paused' }],
    pendingActions: [{ id: 'pa1', status: 'PENDING', action_type: 'x' }],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('RUN_PAUSED_NO_OWNER'), false);
});

test('signal: active run zonder open actie → NIET gemeld', () => {
  const signals = detectSignals({
    runs: [{ id: 'r1', status: 'active' }],
    pendingActions: [],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('RUN_PAUSED_NO_OWNER'), false);
});

// ── 3. REPEATED_SKIP_OPEN_ACTION ──────────────────────────────────────────

test('signal: 3× skipped_open_action op één run → REPEATED_SKIP_OPEN_ACTION', () => {
  const signals = detectSignals({
    dunningLog: [
      { run_id: 'r1', event_type: 'skipped_open_action', created_at: daysAgo(1) },
      { run_id: 'r1', event_type: 'skipped_open_action', created_at: daysAgo(2) },
      { run_id: 'r1', event_type: 'skipped_open_action', created_at: daysAgo(3) },
    ],
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'REPEATED_SKIP_OPEN_ACTION');
  assert.ok(s);
  assert.equal(s.evidence.skip_count, 3);
  assert.equal(s.severity, 'warning');
});

test('signal: 7× skipped → severity=critical', () => {
  const dlog = [];
  for (let i = 0; i < 7; i++) dlog.push({ run_id: 'r1', event_type: 'skipped_open_action', created_at: daysAgo(i) });
  const signals = detectSignals({ dunningLog: dlog, nowMs: NOW_MS });
  assert.equal(signals[0].severity, 'critical');
});

test('signal: 2× skipped → NIET gemeld', () => {
  const signals = detectSignals({
    dunningLog: [
      { run_id: 'r1', event_type: 'skipped_open_action', created_at: daysAgo(1) },
      { run_id: 'r1', event_type: 'skipped_open_action', created_at: daysAgo(2) },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('REPEATED_SKIP_OPEN_ACTION'), false);
});

// ── 4. OPEN_INVOICES_NO_DUNNING ───────────────────────────────────────────

test('signal: open facturen zonder run/regeling → OPEN_INVOICES_NO_DUNNING (critical)', () => {
  const signals = detectSignals({
    invoices: [{ id: 'inv1', amount_open: 150.75 }],
    runs: [],
    arrangements: [],
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'OPEN_INVOICES_NO_DUNNING');
  assert.ok(s);
  assert.equal(s.severity, 'critical');
  assert.equal(s.evidence.invoice_count, 1);
  assert.equal(s.evidence.total_open_amount, 150.75);
});

test('signal: open facturen + active run → NIET gemeld', () => {
  const signals = detectSignals({
    invoices: [{ id: 'inv1', amount_open: 100 }],
    runs: [{ id: 'r1', status: 'active' }],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('OPEN_INVOICES_NO_DUNNING'), false);
});

test('signal: open facturen + ACTIEVE regeling → NIET gemeld', () => {
  const signals = detectSignals({
    invoices: [{ id: 'inv1', amount_open: 100 }],
    arrangements: [{ id: 'a1', status: 'ACTIEF', type: 'UITSTEL' }],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('OPEN_INVOICES_NO_DUNNING'), false);
});

test('signal: geen open facturen → NIET gemeld', () => {
  const signals = detectSignals({
    invoices: [{ id: 'inv1', amount_open: 0 }],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('OPEN_INVOICES_NO_DUNNING'), false);
});

// ── 5. CUSTOMER_REPLIED_NO_RESPONSE ───────────────────────────────────────

test('signal: klant reageerde 3d geleden, geen outbound → CUSTOMER_REPLIED_NO_RESPONSE', () => {
  const signals = detectSignals({
    dunningLog: [{ event_type: 'paused_customer_replied', created_at: daysAgo(3) }],
    whatsappMessages: [
      { direction: 'inbound', sent_at: daysAgo(3) },  // klant's reply
      // GEEN outbound sindsdien
    ],
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'CUSTOMER_REPLIED_NO_RESPONSE');
  assert.ok(s);
  assert.equal(s.evidence.days_silent, 3);
});

test('signal: klant reageerde + outbound sindsdien → NIET gemeld', () => {
  const signals = detectSignals({
    dunningLog: [{ event_type: 'paused_customer_replied', created_at: daysAgo(3) }],
    whatsappMessages: [{ direction: 'outbound', sent_at: daysAgo(1) }],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('CUSTOMER_REPLIED_NO_RESPONSE'), false);
});

test('signal: klant reageerde 1d geleden → NIET gemeld (grace-periode)', () => {
  const signals = detectSignals({
    dunningLog: [{ event_type: 'paused_customer_replied', created_at: daysAgo(1) }],
    whatsappMessages: [],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('CUSTOMER_REPLIED_NO_RESPONSE'), false);
});

// ── 6. MULTIPLE_LIVE_ARRANGEMENTS ─────────────────────────────────────────

test('signal: 2× ACTIEVE arrangement → MULTIPLE_LIVE_ARRANGEMENTS (critical)', () => {
  const signals = detectSignals({
    arrangements: [
      { id: 'a1', status: 'ACTIEF',      type: 'UITSTEL' },
      { id: 'a2', status: 'VOORGESTELD', type: 'SPLITSING' },
    ],
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'MULTIPLE_LIVE_ARRANGEMENTS');
  assert.ok(s);
  assert.equal(s.severity, 'critical');
  assert.equal(s.evidence.arrangement_ids.length, 2);
});

test('signal: 1× ACTIEVE + 1× NAGEKOMEN → NIET gemeld', () => {
  const signals = detectSignals({
    arrangements: [
      { id: 'a1', status: 'ACTIEF',    type: 'UITSTEL' },
      { id: 'a2', status: 'NAGEKOMEN', type: 'UITSTEL' },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('MULTIPLE_LIVE_ARRANGEMENTS'), false);
});

// ── 7. BROKEN_ARRANGEMENT_NO_FOLLOWUP ─────────────────────────────────────

test('signal: VERBROKEN 5d geleden, geen nieuwe pending_action → BROKEN_ARRANGEMENT_NO_FOLLOWUP', () => {
  const signals = detectSignals({
    arrangements: [
      { id: 'a1', status: 'VERBROKEN', type: 'UITSTEL', updated_at: daysAgo(5) },
    ],
    pendingActions: [
      // nieuwer moet ontbreken; deze is OUDER dan verbroken → telt niet als followup
      { id: 'pa-old', status: 'CANCELLED', created_at: daysAgo(20) },
    ],
    nowMs: NOW_MS,
  });
  const s = signals.find((x) => x.code === 'BROKEN_ARRANGEMENT_NO_FOLLOWUP');
  assert.ok(s);
});

test('signal: VERBROKEN met opvolg-actie erna → NIET gemeld', () => {
  const signals = detectSignals({
    arrangements: [{ id: 'a1', status: 'VERBROKEN', type: 'UITSTEL', updated_at: daysAgo(5) }],
    pendingActions: [{ id: 'pa1', status: 'PENDING', created_at: daysAgo(2) }],
    nowMs: NOW_MS,
  });
  assert.equal(codes(signals).includes('BROKEN_ARRANGEMENT_NO_FOLLOWUP'), false);
});

// ── Robuustheid ───────────────────────────────────────────────────────────

test('detectSignals: geen input → lege array (geen crash)', () => {
  assert.deepEqual(detectSignals({}), []);
  assert.deepEqual(detectSignals(null), []);
  assert.deepEqual(detectSignals({ pendingActions: null, runs: undefined }), []);
});

test('detectSignals: alles gezond → lege array', () => {
  const signals = detectSignals({
    invoices: [],
    runs: [{ id: 'r1', status: 'active' }],
    arrangements: [],
    pendingActions: [],
    dunningLog: [],
    whatsappMessages: [],
    nowMs: NOW_MS,
  });
  assert.deepEqual(signals, []);
});
