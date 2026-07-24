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
    // Echte customers-schema: first_name/last_name/is_company/company_name.
    // GEEN 'name'-kolom (dat was de bug uit fix/customer-dossier-schema).
    // Display-name wordt door de handler samengesteld via customerDisplayName
    // en meegegeven als input.customerDisplayName; we simuleren dat hier ook.
    customer: {
      id: 'c1', first_name: 'Jan', last_name: 'Jansen',
      is_company: false, company_name: null,
      email: 'j@x.nl', phone: '+31612345678',
      archived_at: null, anonymized_at: null,
    },
    customerDisplayName: 'Jan Jansen',
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

// ── Free-tasks (PR D: taken_items.customer_id gekoppeld) ─────────────────

test('free_tasks: leeg (geen input.freeTasks) → granted:true, items:[]', () => {
  const resp = buildDossierResponse(baseInput(), { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const ft = resp.blocks.nog_te_doen.data.free_tasks;
  // LEEG (geen taken gekoppeld), niet GEBLOKKEERD.
  assert.equal(ft.granted, true);
  assert.deepEqual(ft.items, []);
});

test('free_tasks: input met taken → items met velden + days_open berekend', () => {
  const input = baseInput();
  input.freeTasks = [
    {
      id: 't1',
      titel: 'Bel klant terug',
      omschrijving: 'context',
      prioriteit: 'Hoog',
      categorie: 'Wanbetalers',
      status: 'todo',
      deadline: '2026-08-01',
      assigned_to_id: 'u1',
      assigned_to_name: 'Jeffrey',
      aangemaakt: iso(-3 * 86400000),
    },
    {
      id: 't2',
      titel: 'Notitie updaten',
      status: 'progress',
      assigned_to_id: null,
      assigned_to_name: null,
      aangemaakt: iso(-10 * 86400000),
    },
  ];
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const ft = resp.blocks.nog_te_doen.data.free_tasks;
  assert.equal(ft.granted, true);
  assert.equal(ft.items.length, 2);
  assert.equal(ft.items[0].titel, 'Bel klant terug');
  assert.equal(ft.items[0].assigned_to_name, 'Jeffrey');
  assert.equal(ft.items[0].days_open, 3);
  assert.equal(ft.items[1].days_open, 10);
});

test('free_tasks: canBase=true canFinance=false → nog steeds granted:true', () => {
  // Taken zijn operationeel, geen financiële data — geen extra permissie-gate.
  // Een user met alleen customer.module.access moet de taken kunnen zien.
  const input = baseInput();
  input.freeTasks = [{ id: 't1', titel: 'x', status: 'todo', aangemaakt: iso(-1 * 86400000) }];
  const resp = buildDossierResponse(input, { canBase: true, canFinance: false, canAdmin: false }, { nowMs: NOW_MS });
  const ft = resp.blocks.nog_te_doen.data.free_tasks;
  assert.equal(ft.granted, true);
  assert.equal(ft.items.length, 1);
});

test('free_tasks: taak zonder aangemaakt → days_open=null (geen crash)', () => {
  const input = baseInput();
  input.freeTasks = [{ id: 't1', titel: 'x', status: 'todo', aangemaakt: null }];
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.nog_te_doen.data.free_tasks.items[0].days_open, null);
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

// ── Klant-basis: is_company, is_archived, is_anonymized ──────────────────

test('nu-blok: B2B klant → customer.name = company_name (via customerDisplayName)', () => {
  const input = baseInput();
  input.customer = {
    id: 'c1', first_name: '', last_name: '', is_company: true,
    company_name: 'Bouwonderneming Helsmoortel BV',
    email: 'x@y.nl', phone: null, archived_at: null, anonymized_at: null,
  };
  input.customerDisplayName = 'Bouwonderneming Helsmoortel BV';
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.nu.data.customer.name, 'Bouwonderneming Helsmoortel BV');
  assert.equal(resp.blocks.nu.data.customer.is_company, true);
  assert.equal(resp.blocks.nu.data.customer.company, 'Bouwonderneming Helsmoortel BV');
});

test('nu-blok: gearchiveerde klant → is_archived=true zichtbaar in customer-blok', () => {
  const input = baseInput();
  input.customer = {
    ...input.customer,
    archived_at: iso(-30 * 86400000),
    anonymized_at: null,
  };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.nu.data.customer.is_archived, true);
  assert.equal(resp.blocks.nu.data.customer.is_anonymized, false);
  assert.ok(resp.blocks.nu.data.customer.archived_at);
});

test('nu-blok: geanonimiseerde klant → is_anonymized=true zichtbaar', () => {
  const input = baseInput();
  input.customer = {
    ...input.customer,
    archived_at: null,
    anonymized_at: iso(-5 * 86400000),
  };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  assert.equal(resp.blocks.nu.data.customer.is_anonymized, true);
});

// ── ERROR-STATE per blok (LEEG vs GEBLOKKEERD vs MISLUKT) ────────────────

test('financial: invoices-fetch faalde → status=error met foutmelding', () => {
  const input = baseInput();
  input.fetchErrors = { invoices: 'column customers.name does not exist' };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const fin = resp.blocks.nu.data.financial;
  assert.equal(fin.granted, true);
  assert.equal(fin.status, 'error');
  assert.match(fin.message, /facturen:/);
  assert.match(fin.message, /column customers.name does not exist/);
  // GEEN open_total_amount / live_arrangement / subscription — die zouden
  // misleidend leeg zijn.
  assert.equal(fin.open_total_amount, undefined);
  assert.equal(fin.live_arrangement, undefined);
});

test('open_invoices in blok 3: invoices-fetch faalde → status=error, geen items', () => {
  const input = baseInput();
  input.fetchErrors = { invoices: 'timeout' };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const oi = resp.blocks.nog_te_doen.data.open_invoices;
  assert.equal(oi.granted, true);
  assert.equal(oi.status, 'error');
  assert.match(oi.message, /Kon facturen niet laden/);
  assert.equal(oi.items, undefined);
});

test('open_actions in blok 3: pending_actions-fetch faalde → status=error', () => {
  const input = baseInput();
  input.fetchErrors = { pendingActions: 'RLS denied' };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const oa = resp.blocks.nog_te_doen.data.open_actions;
  assert.equal(oa.status, 'error');
  assert.match(oa.message, /RLS denied/);
});

test('signals: één financial-bron faalde → signals status=error (incompleet beeld)', () => {
  const input = baseInput();
  input.signals = [{ code: 'X', severity: 'warning', message: 'x', evidence: {} }];
  input.fetchErrors = { runs: 'network fail' };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const sig = resp.blocks.nog_te_doen.data.signals;
  assert.equal(sig.status, 'error');
  assert.match(sig.message, /incompleet/);
  // Geen items — beter helemaal geen signalen tonen dan misleidende gedeeltelijke.
  assert.equal(sig.items, undefined);
});

test('free_tasks: fetch faalde → status=error', () => {
  const input = baseInput();
  input.fetchErrors = { freeTasks: 'permission denied' };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const ft = resp.blocks.nog_te_doen.data.free_tasks;
  assert.equal(ft.granted, true);
  assert.equal(ft.status, 'error');
  assert.match(ft.message, /permission denied/);
});

test('notes: admin met notes-fetch fout → status=error (niet reason=admin_only)', () => {
  const input = baseInput();
  input.fetchErrors = { customerNotes: 'timeout' };
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const n = resp.blocks.gebeurd.data.notes;
  assert.equal(n.granted, true);
  assert.equal(n.status, 'error');
});

test('drie-way onderscheid: leeg ≠ geblokkeerd ≠ mislukt (canFinance=true, geen fout, lege lijsten)', () => {
  const input = baseInput();
  input.invoices = [];
  input.pendingActions = [];
  input.freeTasks = [];
  input.fetchErrors = {};  // GEEN fouten
  const resp = buildDossierResponse(input, { canBase: true, canFinance: true, canAdmin: true }, { nowMs: NOW_MS });
  const b3 = resp.blocks.nog_te_doen.data;
  // LEEG: granted:true + items:[], géén status:error
  assert.equal(b3.open_invoices.granted, true);
  assert.equal(b3.open_invoices.status, undefined);
  assert.deepEqual(b3.open_invoices.items, []);
  assert.equal(b3.free_tasks.status, undefined);
  assert.deepEqual(b3.free_tasks.items, []);
});
