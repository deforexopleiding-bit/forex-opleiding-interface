// tests/dunning-engine-open-action-guard.test.js
//
// Echte assertion-tests voor de actie-guard in advanceActiveRuns
// (PR #888): sla dunning-stappen over als er een openstaande handmatige
// actie is voor de klant. Vult de reply-stop-guard uit #875/#876 aan.
//
// Gedekte spec-scenarios:
//   (a) klant met pending action  -> stap NIET uitgevoerd (guard actief).
//   (b) klant met executed action -> idem (mens heeft zaak al opgepakt).
//   (c) klant met alleen rejected action -> stap gaat door (guard laat door).
//   (d) klant zonder acties -> stap gaat door (regressie-anker).
//   (e) reply-stop (#875/#876) blijft naast deze guard functioneel.
//
// De guard-check zelf zit op één centrale plek: hasOpenBlockingAction
// (api/_lib/pending-actions-guard.js). We testen die pure functie op
// exact de scenarios die de engine passeert.
//
// Voor (e) laden we hasReplyAfterLastSend uit dunning-engine met een
// fake-db en verifiëren dat de reply-detection nog werkt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOpenBlockingAction,
  loadOpenActionsByCustomer,
  BLOCKING_ACTION_STATUSES,
} from '../api/_lib/pending-actions-guard.js';
import { hasReplyAfterLastSend } from '../api/_lib/dunning-engine.js';

// ── (a) pending action -> stap wordt overgeslagen ─────────────────────
test('(a) klant met pending action -> guard blokkeert stap-uitvoering', () => {
  const actions = [{ status: 'pending', action_type: 'MANUAL_PROPOSE_ARRANGEMENT' }];
  assert.equal(hasOpenBlockingAction(actions), true);
});

// ── (b) executed action -> stap wordt overgeslagen ────────────────────
test('(b) klant met executed action -> guard blokkeert (mens heeft afgehandeld)', () => {
  const actions = [{ status: 'executed', action_type: 'TL_INVOICE_UPDATE_DUE' }];
  assert.equal(hasOpenBlockingAction(actions), true);
});

test('(b-approved) klant met approved action -> guard blokkeert (wacht op executor)', () => {
  const actions = [{ status: 'approved', action_type: 'TL_INVOICE_SPLIT' }];
  assert.equal(hasOpenBlockingAction(actions), true);
});

test('(b-failed) klant met failed action -> guard blokkeert (executor viel om)', () => {
  const actions = [{ status: 'failed', action_type: 'TL_SUBSCRIPTION_STOP' }];
  assert.equal(hasOpenBlockingAction(actions), true);
});

// ── (c) alleen rejected action -> stap gaat door ──────────────────────
test('(c) klant met alleen rejected action -> guard laat door', () => {
  const actions = [{ status: 'rejected', action_type: 'MANUAL_ESCALATION' }];
  assert.equal(hasOpenBlockingAction(actions), false);
});

test('(c-cancelled) klant met alleen cancelled action -> guard laat door', () => {
  const actions = [{ status: 'cancelled', action_type: 'MANUAL_PROPOSE_ARRANGEMENT' }];
  assert.equal(hasOpenBlockingAction(actions), false);
});

test('(c-mix-safe) rejected + cancelled -> guard laat door', () => {
  const actions = [
    { status: 'rejected',  action_type: 'MANUAL_ESCALATION' },
    { status: 'cancelled', action_type: 'TL_INVOICE_WRITEOFF' },
  ];
  assert.equal(hasOpenBlockingAction(actions), false);
});

// ── (d) geen acties -> stap gaat door (regressie-anker) ───────────────
test('(d) klant zonder acties -> guard laat door (regressie-anker)', () => {
  assert.equal(hasOpenBlockingAction([]),        false);
  assert.equal(hasOpenBlockingAction(null),      false);
  assert.equal(hasOpenBlockingAction(undefined), false);
});

// ── Set-integriteit: dezelfde blocking-set als in #887 ────────────────
test('BLOCKING_ACTION_STATUSES bevat exact pending/approved/executed/failed', () => {
  assert.equal(BLOCKING_ACTION_STATUSES.size, 4);
  for (const s of ['pending', 'approved', 'executed', 'failed']) {
    assert.equal(BLOCKING_ACTION_STATUSES.has(s), true, `blocking set moet ${s} bevatten`);
  }
  for (const s of ['rejected', 'cancelled']) {
    assert.equal(BLOCKING_ACTION_STATUSES.has(s), false, `blocking set mag ${s} NIET bevatten`);
  }
});

// ── loadOpenActionsByCustomer: batch-query + filter ───────────────────
test('loadOpenActionsByCustomer batcht correct + filtert rejected/cancelled', async () => {
  // Fake-db die exact de subset van de Supabase-chain implementeert die
  // loadOpenActionsByCustomer aanroept. Verifieert dat de guard-query
  // rejected/cancelled uitsluit via .not('status','in','(rejected,cancelled)').
  const fakeRows = [
    { customer_id: 'A', status: 'pending',   action_type: 'MANUAL_ESCALATION' },
    { customer_id: 'B', status: 'executed',  action_type: 'TL_INVOICE_UPDATE_DUE' },
    { customer_id: 'C', status: 'rejected',  action_type: 'MANUAL_PROPOSE_ARRANGEMENT' }, // eruit
    { customer_id: 'D', status: 'cancelled', action_type: 'TL_SUBSCRIPTION_PAUSE' },      // eruit
    { customer_id: 'A', status: 'approved',  action_type: 'TL_INVOICE_SPLIT' },
  ];
  const db = {
    from(table) {
      assert.equal(table, 'pending_actions');
      let rows = fakeRows.slice();
      const chain = {
        select()  { return chain; },
        in(col, vals) {
          const s = new Set(vals);
          rows = rows.filter(r => s.has(r[col]));
          return chain;
        },
        not(col, op, val) {
          if (op === 'in') {
            const list = String(val).replace(/[()]/g, '').split(',').map(s => s.trim());
            const s = new Set(list);
            rows = rows.filter(r => !s.has(r[col]));
          }
          return chain;
        },
        then(resolve) { resolve({ data: rows, error: null }); },
      };
      return chain;
    },
  };

  const map = await loadOpenActionsByCustomer(['A', 'B', 'C', 'D'], db);
  assert.equal(map.get('A')?.length, 2, 'klant A heeft pending + approved');
  assert.equal(map.get('B')?.length, 1, 'klant B heeft executed');
  assert.equal(map.has('C'), false, 'klant C had alleen rejected -> geen entry');
  assert.equal(map.has('D'), false, 'klant D had alleen cancelled -> geen entry');
  assert.equal(map.get('A')[0].action_type, 'MANUAL_ESCALATION');
});

test('loadOpenActionsByCustomer: lege input -> lege map (geen DB-call)', async () => {
  let callCount = 0;
  const db = {
    from() { callCount++; throw new Error('should not call'); },
  };
  const map = await loadOpenActionsByCustomer([], db);
  assert.equal(map.size, 0);
  assert.equal(callCount, 0);
});

test('loadOpenActionsByCustomer: DB-error -> lege map (fail-soft)', async () => {
  const db = {
    from() {
      return {
        select() { return this; },
        in()     { return this; },
        not()    { return this; },
        then(resolve) { resolve({ data: null, error: { message: 'boom' } }); },
      };
    },
  };
  const map = await loadOpenActionsByCustomer(['A'], db);
  assert.equal(map.size, 0);
});

// ── (e) reply-stop guard blijft functioneel ───────────────────────────
test('(e) reply-stop (hasReplyAfterLastSend) blijft naast actie-guard werken', async () => {
  // Fake-db voor hasReplyAfterLastSend: klant reageerde NA laatste send.
  const RUN_ID = 'run-e';
  const CUST_ID = 'cust-e';
  const T_SEND = '2026-08-11T09:00:00.000Z';
  const T_LATE = '2026-08-11T12:00:00.000Z';
  const db = {
    from(table) {
      const data = {
        dunning_log: [{ run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND }],
        whatsapp_conversations: [
          { customer_id: CUST_ID, last_inbound_at: T_LATE },
        ],
        customers: [{ id: CUST_ID, email: 'e@e.nl' }],
        email_messages: [],
      };
      let rows = Array.isArray(data[table]) ? data[table].slice() : [];
      const chain = {
        select()          { return chain; },
        eq(col, val)      { rows = rows.filter(r => r[col] === val); return chain; },
        in(col, vals)     { const s = new Set(vals); rows = rows.filter(r => s.has(r[col])); return chain; },
        not(col, op, val) { if (op === 'is' && val === null) rows = rows.filter(r => r[col] != null); return chain; },
        ilike(col, val)   {
          const t = String(val).toLowerCase();
          rows = rows.filter(r => String(r[col] || '').toLowerCase() === t);
          return chain;
        },
        gt(col, val)      { rows = rows.filter(r => r[col] > val); return chain; },
        order()           { return chain; },
        limit(n)          { rows = rows.slice(0, n); return chain; },
        maybeSingle()     { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(resolve)     { resolve({ data: rows, error: null }); },
      };
      return chain;
    },
  };
  const reply = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(reply?.replied, true, 'reply-stop moet inbound NA send detecteren');
  assert.equal(reply?.channel, 'whatsapp');
});
