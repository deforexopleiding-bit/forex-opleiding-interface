// tests/pending-action-snooze-validate.test.js
//
// Bewijst de kritieke invarianten van de snooze-schrijf-actie (FASE 3):
//   1. Input-validatie weigert lege/malformed/verleden datums.
//   2. Row-check weigert non-PENDING (EXECUTED / REJECTED / FAILED / CANCELLED
//      / APPROVED) — pas op: snoozen van niet-PENDING is nooit zinvol want
//      die staan al niet in Te doen.
//   3. Happy-path: PENDING + toekomstige datum → OK.
//
// Pure unit-tests op de gedeelde helpers, geen DB, geen HTTP. Endpoint
// (api/pending-action-snooze.js) ketent deze helpers plus supabase-load
// en supabase-update met een race-guard (eq('status','PENDING')).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_FUTURE_MS,
  validateSnoozeInput,
  checkCanSnooze,
} from '../api/_lib/pending-action-snooze-validate.js';

const UUID_OK   = '11111111-2222-3333-4444-555555555555';
const UUID_BAD  = 'not-a-uuid';

// ── validateSnoozeInput ─────────────────────────────────────────────────

test('DEFAULT_MIN_FUTURE_MS = 60_000 (60s)', () => {
  assert.equal(DEFAULT_MIN_FUTURE_MS, 60 * 1000);
});

test('validate: id ontbreekt → MISSING_ID', () => {
  const r = validateSnoozeInput({ scheduled_for: '2099-01-01T00:00:00Z' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_ID');
});

test('validate: id is geen UUID → MISSING_ID', () => {
  const r = validateSnoozeInput({ id: UUID_BAD, scheduled_for: '2099-01-01T00:00:00Z' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_ID');
});

test('validate: scheduled_for ontbreekt → MISSING_SCHEDULED_FOR', () => {
  const r = validateSnoozeInput({ id: UUID_OK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_SCHEDULED_FOR');
});

test('validate: scheduled_for is onparseerbaar → MISSING_SCHEDULED_FOR', () => {
  const r = validateSnoozeInput({ id: UUID_OK, scheduled_for: 'niet-een-datum' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_SCHEDULED_FOR');
});

test('validate: scheduled_for in verleden → SCHEDULED_FOR_PAST', () => {
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  const r = validateSnoozeInput({
    id: UUID_OK,
    scheduled_for: '2026-07-29T10:00:00Z',
    now,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SCHEDULED_FOR_PAST');
  assert.equal(r.min_future_ms, DEFAULT_MIN_FUTURE_MS);
});

test('validate: scheduled_for = now (edge) → SCHEDULED_FOR_PAST', () => {
  // Zonder 60s buffer zou een snooze naar exact-nu vaak dezelfde iso
  // teruggeven als de DB-clock, waardoor de pending-actions-list-filter
  // (scheduled_for <= now) alsnog hit — dan blijft de taak in Te doen.
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  const r = validateSnoozeInput({
    id: UUID_OK,
    scheduled_for: '2026-07-30T10:00:00Z',
    now,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SCHEDULED_FOR_PAST');
});

test('validate: scheduled_for = now + 30s → SCHEDULED_FOR_PAST (60s buffer)', () => {
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  const in30s = new Date(now + 30_000).toISOString();
  const r = validateSnoozeInput({ id: UUID_OK, scheduled_for: in30s, now });
  assert.equal(r.ok, false, 'binnen buffer moet weigeren');
  assert.equal(r.code, 'SCHEDULED_FOR_PAST');
});

test('validate: scheduled_for = now + 61s → OK (net buiten buffer)', () => {
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  const in61s = new Date(now + 61_000).toISOString();
  const r = validateSnoozeInput({ id: UUID_OK, scheduled_for: in61s, now });
  assert.equal(r.ok, true);
  assert.equal(r.scheduledForIso, in61s);
});

test('validate: happy path — normale volgende-week snooze', () => {
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  const nextWeek = '2026-08-06T09:00:00.000Z';
  const r = validateSnoozeInput({ id: UUID_OK, scheduled_for: nextWeek, now });
  assert.equal(r.ok, true);
  assert.equal(r.scheduledForIso, nextWeek);
  assert.equal(r.minFutureMs, DEFAULT_MIN_FUTURE_MS);
});

test('validate: custom minFutureMs override werkt', () => {
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  const in10s = new Date(now + 10_000).toISOString();
  // Met minFutureMs=5000 mag 10s wél.
  const r = validateSnoozeInput({ id: UUID_OK, scheduled_for: in10s, now, minFutureMs: 5000 });
  assert.equal(r.ok, true);
});

test('validate: scheduled_for wordt genormaliseerd naar ISO-string', () => {
  const now = new Date('2026-07-30T10:00:00Z').getTime();
  // Input in andere timezone-notatie → toISOString normaliseert naar Z.
  const r = validateSnoozeInput({
    id: UUID_OK,
    scheduled_for: '2026-08-06T11:00:00+02:00', // 09:00 UTC
    now,
  });
  assert.equal(r.ok, true);
  assert.equal(r.scheduledForIso, '2026-08-06T09:00:00.000Z');
});

// ── checkCanSnooze ──────────────────────────────────────────────────────

test('checkCanSnooze: null row → NOT_FOUND', () => {
  const r = checkCanSnooze(null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('checkCanSnooze: undefined row → NOT_FOUND', () => {
  const r = checkCanSnooze(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('checkCanSnooze: status=PENDING → OK', () => {
  const r = checkCanSnooze({ id: UUID_OK, status: 'PENDING' });
  assert.equal(r.ok, true);
});

test('checkCanSnooze: status=pending (lowercase) → OK (case-insensitive)', () => {
  const r = checkCanSnooze({ id: UUID_OK, status: 'pending' });
  assert.equal(r.ok, true);
});

for (const badStatus of ['APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED']) {
  test(`checkCanSnooze: status=${badStatus} → NOT_PENDING`, () => {
    const r = checkCanSnooze({ id: UUID_OK, status: badStatus });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_PENDING');
    assert.equal(r.current_status, badStatus);
  });
}

test('checkCanSnooze: onbekende status → NOT_PENDING', () => {
  const r = checkCanSnooze({ id: UUID_OK, status: 'GESNOOZEDD' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_PENDING');
});

test('checkCanSnooze: status is leeg-string → NOT_PENDING', () => {
  const r = checkCanSnooze({ id: UUID_OK, status: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_PENDING');
});
