// tests/pending-actions-mark-executed-body.test.js
//
// Bewijst de body-shape voor /api/pending-actions-mark-executed die callers
// vanuit modules/finance.html (Acties-werkcentrum "Afhandelen"-knoppen)
// moeten sturen. Endpoint eist strict `body.execution_result.outcome` +
// `body.execution_result.manual_notes` (min 10 chars).
//
// Achtergrond: tot en met #1008 stuurde _awnDoApprove een top-level
// { id, outcome } — endpoint gaf dan 400 "execution_result (object) vereist"
// en het afhandelen van een MANUAL_FOLLOWUP-bel-taak faalde. Fix in deze PR
// wrapped alles in execution_result via buildMarkExecutedBody; deze test
// bewaakt dat de wrapper NIET meer wegvalt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkExecutedBody } from '../api/_lib/pending-actions-mark-executed-body.js';

// ── Basis-shape ──────────────────────────────────────────────────────

test('body.execution_result is ALTIJD een object met outcome + manual_notes', () => {
  const body = buildMarkExecutedBody({
    id: 'abc',
    outcome: 'closed_manually',
    fallbackNotes: 'Handmatig afgesloten via acties-werkcentrum',
  });
  assert.equal(body.id, 'abc');
  assert.equal(typeof body.execution_result, 'object');
  assert.equal(body.execution_result.outcome, 'closed_manually');
  assert.equal(typeof body.execution_result.manual_notes, 'string');
  assert.ok(body.execution_result.manual_notes.length >= 10,
    'manual_notes moet ≥ 10 chars zijn (endpoint-eis)');
});

test('geen reason meegegeven → fallbackNotes vult manual_notes', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'closed_manually',
    fallbackNotes: 'Handmatig afgesloten via acties-werkcentrum',
  });
  assert.equal(body.execution_result.manual_notes,
    'Handmatig afgesloten via acties-werkcentrum');
});

// ── Reden-lengte gedrag ──────────────────────────────────────────────

test('reason ≥ 10 chars → gebruikt reason letterlijk (trimmed)', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'resolved',
    reason: '  Klant heeft alles betaald op 14 juli  ',
    fallbackNotes: 'FALLBACK',
  });
  assert.equal(body.execution_result.manual_notes,
    'Klant heeft alles betaald op 14 juli');
});

test('reason < 10 chars → valt terug op fallbackNotes', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'closed_manually',
    reason: 'ok',                                       // 2 chars < 10
    fallbackNotes: 'Handmatig afgesloten via acties-werkcentrum',
  });
  assert.equal(body.execution_result.manual_notes,
    'Handmatig afgesloten via acties-werkcentrum');
});

test('reason exact 10 chars (grens-conditie) → gebruikt reason', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'closed_manually',
    reason: '0123456789',                               // exact 10
    fallbackNotes: 'FALLBACK',
  });
  assert.equal(body.execution_result.manual_notes, '0123456789');
});

test('reason whitespace-only → valt terug', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'closed_manually',
    reason: '            ',
    fallbackNotes: 'FALLBACK-tekst-die-genoeg-lang-is',
  });
  assert.equal(body.execution_result.manual_notes,
    'FALLBACK-tekst-die-genoeg-lang-is');
});

// ── Extra velden ─────────────────────────────────────────────────────

test('extra velden komen mee in execution_result', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'confirmed_paid',
    fallbackNotes: 'Handmatig gecheckt via bank-export',
    extra: {
      matched_transaction_id: 'TL-12345',
      call_log_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
  });
  assert.equal(body.execution_result.matched_transaction_id, 'TL-12345');
  assert.equal(body.execution_result.call_log_id,
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('lege/null/undefined extra-velden worden overgeslagen', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'ongoing',
    fallbackNotes: 'Voortgang gelogd via acties-werkcentrum',
    extra: {
      handed_over_to: '',
      call_log_id: null,
      matched_transaction_id: undefined,
    },
  });
  assert.ok(!('handed_over_to' in body.execution_result));
  assert.ok(!('call_log_id' in body.execution_result));
  assert.ok(!('matched_transaction_id' in body.execution_result));
});

// ── Regressie-guard ──────────────────────────────────────────────────

test('REGRESSIE: outcome staat NOOIT op top-level (moet in execution_result)', () => {
  const body = buildMarkExecutedBody({
    id: 'x', outcome: 'closed_manually',
    fallbackNotes: 'REGRESSIE-fallback-tekst-is-langer-dan-10-chars',
  });
  assert.ok(!('outcome' in body),
    'outcome op top-level → endpoint faalt met "execution_result (object) vereist"');
  assert.ok(!('reason' in body),
    'reason op top-level wordt door endpoint genegeerd — moet als manual_notes in execution_result');
});
