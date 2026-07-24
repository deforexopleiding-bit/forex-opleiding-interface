// tests/customer-dossier-response.test.js
//
// Unit-test voor api/_lib/customer-dossier-response.js. Focus:
// - Blok-permissies (canBase / canFinance / canAdmin) → response reflects.
// - LEEG vs GEBLOKKEERD onderscheid in response.
// - Timeline-merge + paginering.
// - Onbekende event-types worden humanized (indirect via label-fn).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDossierResponse, buildTimeline } from '../api/_lib/customer-dossier-response.js';

const NOW_MS = Date.parse('2026-07-24T10:00:00Z');
const iso = (offsetMs) => new Date(NOW_MS + offsetMs).toISOString();

function baseInput() {
  return {
    customer: { id: 'c1', name: 'Jan Jansen', email: 'j@x.nl', phone: '+31612345678', company_name: 'ACME BV' },
    invoices: [
      { id: 'inv1', invoice_number: 'F-001', status: 'overdue', due_date: iso(-14 * 86400000),
        amount_total: 200, amount_paid: 0, credited_amount: 0, amount_open: 200 },
    ],
    runs: [{ id: 'r1', status: 'paused', paused_by_conversation_id: null, paused_by_arrangement_id: null, updated_at: iso(-3600000) }],
    arrangements: [
      { id: 'a1', type: 'UITSTEL', status: 'VOORGESTELD',
        created_at: iso(-2 * 86400000), updated_at: iso(-2 * 86400000), approved_at: null,
        proposed_by: 'u1', approved_by: null },
    ],
    subscriptions: [
      { id: 's1', status: 'active', start_date: '2026-01-01', amount: 99, term_count: 12 },
    ],
    conversations: [{ id: 'conv1', status: 'open' }],
    dunningLog: [
      { id: 'dl1', run_id: 'r1', event_type: 'email_sent', created_at: iso(-5 * 86400000), payload: {} },
      { id: 'dl2', run_id: 'r1', event_type: 'paused_customer_replied', created_at: iso(-1 * 86400000), payload: { channel: 'whatsapp' } },
    ],
    pendingActions: [
      { id: 'pa1', action_type: 'TL_INVOICE_UPDATE_DUE', status: 'PENDING',
        created_at: iso(-6 * 86400000), proposed_by_user_id: 'u2' },
    ],
    whatsappMessages: [
      { id: 'm1', direction: 'inbound', body: 'kan pas volgende week', sent_at: iso(-1 * 86400000) },
    ],
    signals: [{ code: 'RUN_PAUSED_NO_OWNER', severity: 'warning', message: 'x', evidence: {} }],
    customerNotes: [{ id: 'n1', body: 'admin-notitie', created_at: iso(-7 * 86400000) }],
  };
}

// ── canBase = false → volledig locked ─────────────────────────────────────

test('canBase=false → alle blokken granted:false met reason=no_permission', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: false });
  assert.equal(resp.blocks.nu.granted, false);
  assert.equal(resp.blocks.nu.reason, 'no_permission');
  assert.equal(resp.blocks.gebeurd.granted, false);
  assert.equal(resp.blocks.nog_te_doen.granted, false);
});

// ── canBase=true, canFinance=false → basis-info wel, financieel afgeschermd ─

test('canBase=true canFinance=false → klant-blok gevuld, financial-subblok geblokkeerd', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: false, canAdmin: false }, { nowMs: NOW_MS });
  const nu = resp.blocks.nu;
  assert.equal(nu.granted, true);
  assert.equal(nu.data.customer.name, 'Jan Jansen');
  // financial-subblok expliciet afgeschermd (LEEG !== GEBLOKKEERD).
  assert.equal(nu.data.financial.granted, false);
  assert.equal(nu.data.financial.reason, 'no_permission');
  // Bedragen mogen NIET meekomen.
  assert.equal(nu.data.financial.open_total_amount, undefined);
  assert.equal(nu.data.financial.live_arrangement,  undefined);
});

test('canFinance=false → open_actions/open_invoices/signals in blok 3 zichtbaar afgeschermd', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: false, canAdmin: false }, { nowMs: NOW_MS });
  const b3 = resp.blocks.nog_te_doen.data;
  assert.equal(b3.open_actions.granted,  false);
  assert.equal(b3.open_invoices.granted, false);
  assert.equal(b3.signals.granted,       false);
  assert.equal(b3.open_actions.reason,  'no_permission');
  assert.equal(b3.open_invoices.reason, 'no_permission');
  assert.equal(b3.signals.reason,       'no_permission');
});

// ── canFinance=true → financial + open actions + signals aanwezig ─────────

test('canFinance=true → bedragen + open_actions + signals meegeleverd', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: true, canAdmin: false }, { nowMs: NOW_MS });
  const nu = resp.blocks.nu.data;
  assert.equal(nu.financial.granted, true);
  assert.equal(nu.financial.open_invoice_count, 1);
  assert.equal(nu.financial.open_total_amount, 200);
  assert.equal(nu.financial.live_arrangement.type, 'UITSTEL');
  assert.equal(nu.financial.live_arrangement.type_label, 'Uitstel');

  const b3 = resp.blocks.nog_te_doen.data;
  assert.equal(b3.open_actions.granted, true);
  assert.equal(b3.open_actions.items.length, 1);
  assert.equal(b3.open_actions.items[0].action_label, 'Factuur — nieuwe vervaldag');
  assert.equal(b3.open_invoices.granted, true);
  assert.equal(b3.open_invoices.items[0].days_overdue, 14);
  assert.equal(b3.signals.granted, true);
  assert.equal(b3.signals.items[0].code, 'RUN_PAUSED_NO_OWNER');
});

// ── canAdmin gate voor customer_notes ─────────────────────────────────────

test('canAdmin=false → notes-subblok in blok 2 geblokkeerd (admin_only)', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: true, canAdmin: false }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.gebeurd.data.notes.granted, false);
  assert.equal(resp.blocks.gebeurd.data.notes.reason, 'admin_only');
});

test('canAdmin=true → notes-subblok gevuld', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.gebeurd.data.notes.granted, true);
  assert.equal(resp.blocks.gebeurd.data.notes.items[0].body, 'admin-notitie');
});

// ── Onderscheid LEEG vs GEBLOKKEERD ───────────────────────────────────────

test('LEEG (canFinance=true, geen facturen) → granted:true met lege items — NIET granted:false', () => {
  const input = baseInput();
  input.invoices = [];
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const b3 = resp.blocks.nog_te_doen.data;
  assert.equal(b3.open_invoices.granted, true);
  assert.deepEqual(b3.open_invoices.items, []);
});

// ── Free-tasks placeholder (taken_items ontbreekt customer_id) ────────────

test('free_tasks: altijd granted:false met reason=not_supported_yet', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const ft = resp.blocks.nog_te_doen.data.free_tasks;
  assert.equal(ft.granted, false);
  assert.equal(ft.reason, 'not_supported_yet');
  assert.match(ft.note, /PR D/);
});

// ── Timeline-merge + paginering ───────────────────────────────────────────

test('buildTimeline: merges alle bronnen, DESC gesorteerd', () => {
  const out = buildTimeline({
    dunningLog: [
      { id: 'dl1', event_type: 'email_sent', created_at: iso(-5 * 86400000) },
      { id: 'dl2', event_type: 'whatsapp_sent', created_at: iso(-1 * 86400000) },
    ],
    whatsappMessages: [
      { id: 'm1', direction: 'inbound', body: 'x', sent_at: iso(-2 * 86400000) },
    ],
    pendingActions: [], arrangements: [],
  }, { limit: 10 });
  // Nieuwste eerst.
  assert.equal(out.items[0].raw_type, 'whatsapp_sent');
  assert.equal(out.items[1].raw_type, 'wa_in');
  assert.equal(out.items[2].raw_type, 'email_sent');
});

test('buildTimeline: paginering met limit=2 → has_more=true + next_cursor', () => {
  const out = buildTimeline({
    dunningLog: [
      { id: 'dl1', event_type: 'email_sent', created_at: iso(-5 * 86400000) },
      { id: 'dl2', event_type: 'email_sent', created_at: iso(-3 * 86400000) },
      { id: 'dl3', event_type: 'email_sent', created_at: iso(-1 * 86400000) },
    ],
    whatsappMessages: [], pendingActions: [], arrangements: [],
  }, { limit: 2 });
  assert.equal(out.items.length, 2);
  assert.equal(out.has_more, true);
  assert.ok(out.next_cursor);
});

test('buildTimeline: before-cursor filtert items ouder dan de cursor', () => {
  const cursor = iso(-2 * 86400000);
  const out = buildTimeline({
    dunningLog: [
      { id: 'dl1', event_type: 'email_sent', created_at: iso(-5 * 86400000) },  // ouder → moet komen
      { id: 'dl2', event_type: 'email_sent', created_at: iso(-1 * 86400000) },  // nieuwer → NIET
    ],
    whatsappMessages: [], pendingActions: [], arrangements: [],
  }, { before: cursor, limit: 10 });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'dlog:dl1');
});

test('buildTimeline: onbekend event_type wordt humanized (geen ruwe code)', () => {
  const out = buildTimeline({
    dunningLog: [{ id: 'x', event_type: 'brand_new_never_seen_type', created_at: iso(-1000) }],
    whatsappMessages: [], pendingActions: [], arrangements: [],
  }, { limit: 5 });
  assert.equal(out.items[0].title, 'Brand new never seen type');
  assert.notEqual(out.items[0].title, 'brand_new_never_seen_type');
});

// ── Pauze-reden ───────────────────────────────────────────────────────────

test('nu-blok: paused run met paused_by_arrangement_id → reden bevat "regeling actief"', () => {
  const input = baseInput();
  input.runs = [{ id: 'r1', status: 'paused', paused_by_arrangement_id: 'a-x', updated_at: iso(-1000) }];
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.nu.data.dunning.state, 'paused');
  assert.match(resp.blocks.nu.data.dunning.reason, /regeling actief/);
});

test('nu-blok: active run → state=active + next_action_at', () => {
  const input = baseInput();
  input.runs = [{ id: 'r1', status: 'active', next_action_at: iso(86400000) }];
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.nu.data.dunning.state, 'active');
  assert.ok(resp.blocks.nu.data.dunning.next_action_at);
});

// ── _meta.permissions is expliciet ────────────────────────────────────────

test('_meta.permissions weerspiegelt de effective permission-vlaggen', () => {
  const resp = buildDossierResponse(baseInput(),
    { canBase: true, canFinance: false, canAdmin: false },
    { nowMs: NOW_MS }
  );
  assert.deepEqual(resp._meta.permissions, { base: true, finance: false, admin: false });
});
