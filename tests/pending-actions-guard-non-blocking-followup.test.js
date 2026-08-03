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
  NON_BLOCKING_SOURCES,
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

test('NON_BLOCKING_SOURCES: alleen dunning_workflow (workflow-task-non-blocking)', () => {
  assert.equal(NON_BLOCKING_SOURCES.size, 1, 'geen ongeplande source-whitelist');
  assert.ok(NON_BLOCKING_SOURCES.has('dunning_workflow'));
});

// ── SOURCE-WHITELIST — kern van de "task-stap blokkeert niet meer"-fix ──

test('dunning_workflow-source + PENDING → NIET blokkerend (workflow-task laat engine door)', () => {
  // Dit is exact de rij die executeTaskStep aanmaakt: MANUAL_FOLLOWUP,
  // status PENDING, payload.source='dunning_workflow'. Voorheen blokkeerde
  // die de engine tot afvinken; nu advanceert de flow direct door.
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'PENDING',
      payload:     { source: 'dunning_workflow', kind: 'call' },
    }),
    false,
  );
});

test('dunning_workflow-source + APPROVED/EXECUTED/FAILED → allemaal NIET blokkerend', () => {
  // Ongeacht workflow-taak-status blijft de flow doorlopen — deze taken zijn
  // discovery-items in Acties, geen approvals.
  for (const status of ['PENDING', 'APPROVED', 'EXECUTED', 'FAILED']) {
    assert.equal(
      isBlockingAction({
        action_type: 'MANUAL_FOLLOWUP',
        status,
        payload:     { source: 'dunning_workflow' },
      }),
      false,
      `dunning_workflow + ${status} moet doorlaten`,
    );
  }
});

test('MANUAL_FOLLOWUP + callback_appointment-source + PENDING → WEL blokkerend', () => {
  // Terugbelafspraken zijn expliciet door de klant gevraagd — daar wacht de
  // engine wél op. Andere source dan 'dunning_workflow' blijft normaal
  // blokkeren.
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'PENDING',
      payload:     { source: 'callback_appointment', kind: 'call' },
    }),
    true,
  );
});

test('MANUAL_FOLLOWUP + joost-source + PENDING → WEL blokkerend', () => {
  // Joost-gedreven follow-up (bv. E1.2 intent-to-task) is menselijk gestuurd
  // en moet de engine wél stilhouden.
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'PENDING',
      payload:     { source: 'joost', joost_suggestion_id: 'abc' },
    }),
    true,
  );
});

test('MANUAL_FOLLOWUP + geen payload → WEL blokkerend (defensief: onbekende bron blokkert)', () => {
  // Backward-compat: taken van vóór de source-conventie of taken die uit
  // een ander pad komen zonder payload.source. Fail-closed op zwijgen.
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'PENDING',
    }),
    true,
  );
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'PENDING',
      payload:     {},
    }),
    true,
  );
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'PENDING',
      payload:     { source: null },
    }),
    true,
  );
});

test('dunning_workflow-source + REJECTED → nog steeds niet blokkerend (rejected wint sowieso)', () => {
  // Rejected zit niet in BLOCKING_ACTION_STATUSES; source-whitelist is
  // irrelevant. Test bewijst dat de nieuwe logica die pad niet breekt.
  assert.equal(
    isBlockingAction({
      action_type: 'MANUAL_FOLLOWUP',
      status:      'REJECTED',
      payload:     { source: 'dunning_workflow' },
    }),
    false,
  );
});

test('contract: TL_INVOICE_UPDATE_DUE + payload.source=dunning_workflow → NIET blokkerend (source-whitelist wint van action_type)', () => {
  // Defensief: als iemand ooit een TL-taak markeert met deze source, mag de
  // whitelist NIET per ongeluk arrangement-uitvoer stilzwijgen. Source-check
  // laat door zonder action_type-check — is dat OK?
  //
  // Bewuste keuze: source-whitelist geldt VOOR ELKE action_type. Reden:
  // 'dunning_workflow' als source is per definitie afkomstig van
  // executeTaskStep, en die INSERT is hardcoded action_type='MANUAL_FOLLOWUP'
  // (zie dunning-step-executors.js:1097). Dus in praktijk kán TL_* +
  // dunning_workflow niet bestaan — als 't wél opduikt is dat een schema-
  // manipulatie waar we ons niet tegen kunnen wapenen op guard-niveau.
  //
  // Deze test documenteert het contract: "source-whitelist wint ongeacht
  // action_type". Als je dit ooit wil beperken tot alleen MANUAL_FOLLOWUP,
  // pas dan isBlockingAction aan en update deze test.
  assert.equal(
    isBlockingAction({
      action_type: 'TL_INVOICE_UPDATE_DUE',
      status:      'PENDING',
      payload:     { source: 'dunning_workflow' },
    }),
    false,
    'source-whitelist wint ongeacht action_type (contract-documentatie)',
  );
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
