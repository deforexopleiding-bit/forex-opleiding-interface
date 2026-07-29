// tests/pending-actions-guard-non-blocking-followup.test.js
//
// Bewijst dat MANUAL_FOLLOWUP:executed DE ENGINE DOORLAAT terwijl alle
// andere action_types op EXECUTED nog steeds BLOKKEREN — de kritieke
// regressie-check voor FIX 3 (belknop). Pure unit-tests op de guard-
// helpers, geen DB, geen HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKING_ACTION_STATUSES,
  NON_BLOCKING_COMBOS,
  isBlockingAction,
  hasOpenBlockingAction,
} from '../api/_lib/pending-actions-guard.js';

// ── Basis-invarianten ────────────────────────────────────────────────

test('BLOCKING_ACTION_STATUSES: onveranderd (pending/approved/executed/failed)', () => {
  assert.equal(BLOCKING_ACTION_STATUSES.size, 4);
  for (const s of ['pending', 'approved', 'executed', 'failed']) {
    assert.ok(BLOCKING_ACTION_STATUSES.has(s), `mist status "${s}"`);
  }
  assert.ok(!BLOCKING_ACTION_STATUSES.has('rejected'), 'rejected mag niet blokkeren');
  assert.ok(!BLOCKING_ACTION_STATUSES.has('rolled_back'), 'rolled_back mag niet blokkeren');
});

test('NON_BLOCKING_COMBOS: alleen MANUAL_FOLLOWUP:executed', () => {
  assert.equal(NON_BLOCKING_COMBOS.size, 1, 'geen ongeplande whitelist-entries');
  assert.ok(NON_BLOCKING_COMBOS.has('MANUAL_FOLLOWUP:executed'));
});

// ── isBlockingAction — de kritieke regressie-matrix ──────────────────

test('MANUAL_FOLLOWUP + EXECUTED → NIET blokkerend (belactie is gedaan, engine mag door)', () => {
  assert.equal(isBlockingAction({ action_type: 'MANUAL_FOLLOWUP', status: 'EXECUTED' }), false);
  // Case-insensitive: uppercase én lowercase moeten hetzelfde gedrag.
  assert.equal(isBlockingAction({ action_type: 'MANUAL_FOLLOWUP', status: 'executed' }), false);
});

test('MANUAL_FOLLOWUP + PENDING/APPROVED/FAILED → wél blokkerend', () => {
  for (const status of ['PENDING', 'APPROVED', 'FAILED']) {
    assert.equal(
      isBlockingAction({ action_type: 'MANUAL_FOLLOWUP', status }),
      true,
      `MANUAL_FOLLOWUP + ${status} moet blokkeren`,
    );
  }
});

test('regressie: MANUAL_VERIFY_PAYMENT + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'MANUAL_VERIFY_PAYMENT', status: 'EXECUTED' }), true);
});

test('regressie: MANUAL_ESCALATION + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'MANUAL_ESCALATION', status: 'EXECUTED' }), true);
});

test('regressie: MANUAL_PROPOSE_ARRANGEMENT + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'MANUAL_PROPOSE_ARRANGEMENT', status: 'EXECUTED' }), true);
});

test('regressie: TL_INVOICE_UPDATE_DUE + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'TL_INVOICE_UPDATE_DUE', status: 'EXECUTED' }), true);
});

test('regressie: TL_INVOICE_SPLIT + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'TL_INVOICE_SPLIT', status: 'EXECUTED' }), true);
});

test('regressie: TL_SUBSCRIPTION_PAUSE + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'TL_SUBSCRIPTION_PAUSE', status: 'EXECUTED' }), true);
});

test('regressie: TL_SUBSCRIPTION_STOP + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'TL_SUBSCRIPTION_STOP', status: 'EXECUTED' }), true);
});

test('regressie: TL_INVOICE_WRITEOFF + EXECUTED blijft blokkerend', () => {
  assert.equal(isBlockingAction({ action_type: 'TL_INVOICE_WRITEOFF', status: 'EXECUTED' }), true);
});

test('regressie: onbekend action_type + EXECUTED blijft blokkerend (defensief)', () => {
  assert.equal(isBlockingAction({ action_type: 'UNKNOWN_FUTURE_TYPE', status: 'EXECUTED' }), true);
  assert.equal(isBlockingAction({ action_type: null, status: 'EXECUTED' }), true);
  assert.equal(isBlockingAction({ action_type: '', status: 'EXECUTED' }), true);
});

test('rejected/rolled_back: nooit blokkerend, ongeacht action_type', () => {
  for (const type of ['MANUAL_FOLLOWUP', 'MANUAL_VERIFY_PAYMENT', 'TL_INVOICE_UPDATE_DUE', 'UNKNOWN']) {
    for (const status of ['REJECTED', 'rejected', 'ROLLED_BACK', 'rolled_back']) {
      assert.equal(
        isBlockingAction({ action_type: type, status }),
        false,
        `${type} + ${status} mag NIET blokkeren`,
      );
    }
  }
});

test('null/undefined action → niet blokkerend (fail-safe)', () => {
  assert.equal(isBlockingAction(null), false);
  assert.equal(isBlockingAction(undefined), false);
  assert.equal(isBlockingAction({}), false);
});

// ── hasOpenBlockingAction: aggregatie over meerdere acties ───────────

test('hasOpenBlockingAction: MANUAL_FOLLOWUP-EXECUTED alleen → GEEN blok', () => {
  const actions = [{ action_type: 'MANUAL_FOLLOWUP', status: 'EXECUTED' }];
  assert.equal(hasOpenBlockingAction(actions), false);
});

test('hasOpenBlockingAction: mix — MANUAL_FOLLOWUP-EXECUTED + andere pending blijft blokken', () => {
  const actions = [
    { action_type: 'MANUAL_FOLLOWUP', status: 'EXECUTED' },
    { action_type: 'MANUAL_VERIFY_PAYMENT', status: 'PENDING' },
  ];
  assert.equal(hasOpenBlockingAction(actions), true, 'de PENDING verify blijft blokken');
});

test('hasOpenBlockingAction: leeg / null → false', () => {
  assert.equal(hasOpenBlockingAction([]), false);
  assert.equal(hasOpenBlockingAction(null), false);
  assert.equal(hasOpenBlockingAction(undefined), false);
});

test('hasOpenBlockingAction: alleen rejected/rolled_back → false', () => {
  const actions = [
    { action_type: 'MANUAL_FOLLOWUP', status: 'REJECTED' },
    { action_type: 'TL_INVOICE_UPDATE_DUE', status: 'ROLLED_BACK' },
  ];
  assert.equal(hasOpenBlockingAction(actions), false);
});
