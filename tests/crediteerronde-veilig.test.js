// tests/crediteerronde-veilig.test.js
//
// DE CREDITEERRONDE MOCHT NOOIT LIVE ZOALS HIJ WAS.
//
// Pre-flight 29 september: de execute crediteerde per klant ÁLLE open
// facturen (ook nog niet vervallen: 21 stuks, € 5.206), telde 1 factuur als
// 1 maand ongeacht de billing_cycle, meldde "verlengd" zonder dat Teamleader
// het bevestigde, hing aan de systeembrede dunning_dry_run (die het hele
// aanmaansysteem stillegt) en draaide alles in één aanroep die na 30 s wordt
// afgebroken. Een creditnota is in Teamleader niet terug te draaien.
//
// Deze tests draaien de ECHTE execute tegen een nep-database. Alleen de randen
// (creditInvoiceCore, postponeSubscription, auth) zijn gemockt.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const TODAY = '2026-09-29';

// LET OP: de kern importeert '../supabase.js'. Die moet gemockt zijn VÓÓR de
// eerste import, anders zit de echte client in de module-cache en probeert de
// dry-run-check een echte host te bereiken. Daarom staan alle mocks hieronder
// en wordt alles pas daarna dynamisch geïmporteerd.
const credits = [];
const postpones = [];
const restores = [];
const volgorde = [];               // 'postpone' | 'credit' | 'restore' in aanroepvolgorde
let postponeGedrag = 'ok';         // 'ok' | 'tl-weigert' | 'db-na-tl'
let restoreGedrag = 'ok';          // 'ok' | 'tl-weigert'
let failCredits = new Set();       // factuur-ids waarvoor creditInvoiceCore faalt
const db = { tables: {}, inserts: [], updates: [], reads: [] };

function nepAdmin() {
  return {
    from(tabel) {
      db.reads.push(tabel);
      let rows = [...(db.tables[tabel] || [])];
      let op = 'select';
      const k = {
        select: () => k,
        eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return k; },
        in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return k; },
        is: (c, v) => { rows = rows.filter((r) => (r[c] ?? null) === v); return k; },
        order: () => k, limit: () => k, range: () => k,
        insert(v) { op = 'insert'; db.inserts.push({ tabel, rows: v }); return k; },
        update(v) { op = 'update'; db.updates.push({ tabel, patch: v }); return k; },
        maybeSingle: async () => ({ data: op === 'select' ? rows[0] ?? null : null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r, j) => Promise.resolve({ data: op === 'select' ? rows : null, error: null }).then(r, j),
      };
      return k;
    },
  };
}

mock.module(url('api/supabase.js'), {
  namedExports: {
    supabaseAdmin: nepAdmin(),
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  },
});
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/audit-customer.js'), { namedExports: { getClientIp: () => '127.0.0.1' } });
mock.module(url('api/_lib/invoice-credit.js'), {
  namedExports: {
    creditInvoiceCore: async (id) => {
      volgorde.push('credit');
      if (failCredits.has(id)) { const e = new Error('Teamleader weigerde de creditnota (HTTP 400).'); e.code = 'TL_REFUSED'; throw e; }
      credits.push(id); return { tl_credit_note_id: 'cn-' + id };
    },
  },
});
mock.module(url('api/_lib/subscription-postpone.js'), {
  namedExports: {
    postponeSubscription: async (sub, months, opts) => {
      volgorde.push('postpone');
      postpones.push({ sub: sub.id, months, tlFirst: opts?.tlFirst });
      if (postponeGedrag === 'tl-weigert') { const e = new Error('Teamleader weigerde (HTTP 400)'); e.code = 'TL_NOT_CONFIRMED'; throw e; }
      if (postponeGedrag === 'db-na-tl') { const e = new Error('Teamleader is verlengd maar de database-update faalde'); e.code = 'DB_AFTER_TL'; throw e; }
      return { tl: { pushed: true }, extended: true, snapshot: { end_date: sub.end_date, start_date: sub.start_date, term_count: 12 }, subscription: { ...sub, end_date: 'verlengd' } };
    },
    restoreSubscription: async (sub, snapshot) => {
      volgorde.push('restore');
      restores.push({ sub: sub.id, naar: snapshot.end_date });
      if (restoreGedrag === 'tl-weigert') { const e = new Error('Terugdraaien: Teamleader weigerde'); e.code = 'TL_NOT_CONFIRMED'; throw e; }
      return { subscription: { ...sub, end_date: snapshot.end_date } };
    },
  },
});
const { selectCreditable, planExtension, hasScope, isUsableSubscription } = await import(url('api/_lib/crediteer-ronde-core.js'));
const { default: execute } = await import(url('api/crediteer-ronde-execute.js'));
const { default: preview } = await import(url('api/crediteer-ronde-preview.js'));

// ═══════════════════════════════════════════════════════════════════════════
// 1 · PURE KERN
// ═══════════════════════════════════════════════════════════════════════════

const INV = (id, due, extra = {}) => ({ id, invoice_number: id, status: 'open', is_test: false, tl_invoice_id: 'tl-' + id,
  amount_total: 100, amount_paid: 0, credited_amount: 0, due_date: due, ...extra });

test('zonder scope geen selectie: "alle open facturen" bestaat niet meer', () => {
  assert.equal(hasScope({ invoiceIds: null, onlyOverdue: false }), false);
  assert.equal(hasScope({ invoiceIds: [], onlyOverdue: false }), false);
  assert.equal(hasScope({ invoiceIds: ['x'], onlyOverdue: false }), true);
  assert.equal(hasScope({ invoiceIds: null, onlyOverdue: true }), true);
});

test('only_overdue laat nog-niet-vervallen facturen weg', () => {
  const { creditable } = selectCreditable([INV('a', '2026-09-01'), INV('b', '2026-10-15'), INV('c', TODAY)], { onlyOverdue: true, today: TODAY });
  assert.deepEqual(creditable.map((i) => i.id), ['a']);
});

test('invoice_ids is een whitelist; afwijzingen krijgen een reden', () => {
  const invs = [INV('a', '2026-09-01'), INV('b', '2026-09-02', { amount_paid: 100 }), INV('c', '2026-09-03', { tl_invoice_id: null })];
  const { creditable, rejected } = selectCreditable(invs, { invoiceIds: ['a', 'b', 'c', 'vreemd'], today: TODAY });
  assert.deepEqual(creditable.map((i) => i.id), ['a']);
  assert.deepEqual(Object.fromEntries(rejected.map((r) => [r.invoice_id, r.reden])), {
    b: 'niets meer open', c: 'geen Teamleader-id', vreemd: 'hoort niet bij deze klant of bestaat niet',
  });
});

test('verlengplan: per_month = aantal facturen; onbekende cyclus wordt NIET gegokt', () => {
  assert.deepEqual(planExtension({ billing_cycle: 'per_month' }, 4), { months: 4, basis: 'per_month', error: null, cycle: 'per_month' });
  assert.equal(planExtension({ billing_cycle: null }, 4).error, 'CYCLE_UNSUPPORTED');
  assert.equal(planExtension({ billing_cycle: 'per_quarter' }, 4).error, 'CYCLE_UNSUPPORTED');
  assert.deepEqual(planExtension({ billing_cycle: null }, 4, 6), { months: 6, basis: 'override', error: null, cycle: null });
  assert.equal(planExtension({ billing_cycle: 'per_month' }, 4, 0).error, 'MONTHS_OVERRIDE_INVALID');
  assert.equal(planExtension({ billing_cycle: 'per_month' }, 4, 37).error, 'MONTHS_OVERRIDE_INVALID');
});

test('bruikbaar abonnement = actief én Teamleader-id', () => {
  assert.equal(isUsableSubscription({ status: 'active', teamleader_subscription_id: 'x' }), true);
  assert.equal(isUsableSubscription({ status: 'cancelled', teamleader_subscription_id: 'x' }), false);
  assert.equal(isUsableSubscription({ status: 'active', teamleader_subscription_id: null }), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE ECHTE EXECUTE, TEGEN EEN NEP-DATABASE
// ═══════════════════════════════════════════════════════════════════════════

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const S_MONTH = '33333333-3333-4333-8333-333333333333';
const S_NULL  = '44444444-4444-4444-8444-444444444444';
const LATE    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOTDUE  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LATE2   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function resetDb({ dryRunRow }) {
  db.inserts = []; db.updates = []; db.reads = [];
  db.tables = {
    app_settings: dryRunRow === undefined ? [] : [{ key: 'crediteer_ronde_dry_run', value: dryRunRow }],
    customers: [{ id: C1, first_name: 'Anna', last_name: 'Test', is_test: false }, { id: C2, first_name: 'Bram', last_name: 'Test', is_test: false }],
    invoices: [
      { id: LATE,   customer_id: C1, invoice_number: 'F-1', status: 'open', is_test: false, tl_invoice_id: 'tl1', amount_total: 100, amount_paid: 0, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-01' },
      { id: NOTDUE, customer_id: C1, invoice_number: 'F-2', status: 'open', is_test: false, tl_invoice_id: 'tl2', amount_total: 100, amount_paid: 0, credited_amount: 0, vat_amount: 17.36, due_date: '2099-01-01' },
      { id: LATE2,  customer_id: C2, invoice_number: 'F-3', status: 'open', is_test: false, tl_invoice_id: 'tl3', amount_total: 250, amount_paid: 0, credited_amount: 0, vat_amount: 43.39, due_date: '2026-07-01' },
    ],
    deals: [{ id: 'd1', customer_id: C1 }, { id: 'd2', customer_id: C2 }],
    subscriptions: [
      { id: S_MONTH, deal_id: 'd1', status: 'active', teamleader_subscription_id: 'tls1', billing_cycle: 'per_month', end_date: '2027-01-01', start_date: '2026-01-01' },
      { id: S_NULL,  deal_id: 'd2', status: 'active', teamleader_subscription_id: 'tls2', billing_cycle: null,        end_date: '2027-06-01', start_date: '2026-06-01' },
    ],
  };
}
async function roep(body, handler = execute) {
  credits.length = 0; postpones.length = 0; restores.length = 0; volgorde.length = 0;
  let status = 0, out = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { out = b; return this; } };
  await handler({ method: 'POST', body: { confirm: true, ...body }, headers: {} }, res);
  return { status, out };
}

test('zonder scope → 400 en er wordt niets gecrediteerd', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { status } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }] });
  assert.equal(status, 400);
  assert.equal(credits.length, 0);
});

test('meer dan 5 klanten in één aanroep → 400 (batchen verplicht)', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const items = Array.from({ length: 6 }, (_, i) => ({ customer_id: `0000000${i}-0000-4000-8000-000000000000`, invoice_ids: [LATE] }));
  const { status } = await roep({ items, only_overdue: true });
  assert.equal(status, 400);
});

test('eigen dry-run: ontbrekende instelling = dry-run AAN, niets geboekt of verlengd', async () => {
  resetDb({ dryRunRow: undefined });
  const { status, out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
  assert.equal(status, 200);
  assert.equal(out.dry_run, true);
  assert.equal(credits.length, 0, 'geen creditInvoiceCore in dry-run');
  assert.equal(postpones.length, 0, 'geen postpone in dry-run');
  assert.equal(db.inserts.filter((i) => i.tabel === 'dunning_credited_debt').length, 0);
  assert.equal(out.summary.credited_invoices, 1, 'zou alleen de te-late factuur crediteren');
  assert.equal(out.customers[0].extended.would_extend, true);
  assert.ok(db.inserts.some((i) => i.tabel === 'audit_log' && i.rows.action === 'crediteer_ronde.batch_start'), 'batch-start audit');
});

test('live + only_overdue: alleen de te-late factuur, verlengen met Teamleader-eerst', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
  assert.equal(out.dry_run, false);
  assert.deepEqual(credits, [LATE], 'NOTDUE mag niet mee');
  assert.deepEqual(postpones, [{ sub: S_MONTH, months: 1, tlFirst: true }]);
  assert.equal(out.customers[0].extended.extended, true);
  const debt = db.inserts.find((i) => i.tabel === 'dunning_credited_debt');
  assert.equal(debt.rows[0].subscription_id, S_MONTH);
  assert.equal(debt.rows[0].months_extended, 1);
});

test('onbekende billing_cycle zonder months_override → geblokkeerd VÓÓR crediteren', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C2, subscription_id: S_NULL }], only_overdue: true });
  assert.equal(credits.length, 0, 'geen credit zonder verlengplan');
  assert.equal(postpones.length, 0, 'ook geen verlenging');
  assert.equal(out.summary.status_counts.geblokkeerd, 1);
  assert.equal(out.customers[0].status, 'geblokkeerd');
  assert.equal(out.customers[0].errors[0].code, 'CYCLE_UNSUPPORTED');
});

test('onbekende cyclus mét months_override → crediteren + verlengen met die maanden', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C2, subscription_id: S_NULL, months_override: 3 }], only_overdue: true });
  assert.deepEqual(credits, [LATE2]);
  assert.deepEqual(postpones, [{ sub: S_NULL, months: 3, tlFirst: true }]);
  assert.equal(out.customers[0].extended.basis, 'override');
});

test('VOLGORDE: eerst verlengen (TL-bevestigd), pas daarna crediteren', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
  assert.deepEqual(volgorde, ['postpone', 'credit']);
  assert.equal(out.customers[0].status, 'verlengd_en_gecrediteerd');
});

test('verlenging faalt (Teamleader weigert) → 0 credits voor die klant, status geblokkeerd', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  postponeGedrag = 'tl-weigert';
  try {
    const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
    const c = out.customers[0];
    assert.equal(credits.length, 0, 'GEEN credit zonder bevestigde verlenging');
    assert.deepEqual(volgorde, ['postpone']);
    assert.equal(c.status, 'geblokkeerd');
    assert.equal(c.extended.extended, false);
    assert.ok(c.errors.some((e) => e.code === 'TL_NOT_CONFIRMED' && /NIETS gecrediteerd/.test(e.message)));
    assert.equal(db.inserts.filter((i) => i.tabel === 'dunning_credited_debt').length, 0);
    assert.equal(out.summary.extended_subscriptions, 0);
  } finally { postponeGedrag = 'ok'; }
});

test('TL verlengd maar DB niet (DB_AFTER_TL) → 0 credits, status fout met instructie', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  postponeGedrag = 'db-na-tl';
  try {
    const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
    assert.equal(credits.length, 0);
    assert.equal(out.customers[0].status, 'fout');
    assert.match(out.customers[0].errors[0].message, /ends_on terug naar 2027-01-01/);
  } finally { postponeGedrag = 'ok'; }
});

test('crediteren faalt ná geslaagde verlenging → verlenging exact teruggezet, status geblokkeerd', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  failCredits = new Set([LATE]);
  try {
    const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
    const c = out.customers[0];
    assert.deepEqual(volgorde, ['postpone', 'credit', 'restore']);
    assert.deepEqual(restores, [{ sub: S_MONTH, naar: '2027-01-01' }], 'terug naar de exacte oude einddatum');
    assert.equal(c.status, 'geblokkeerd');
    assert.equal(c.reverted.ok, true);
    assert.equal(c.extended.extended, false);
    assert.equal(db.inserts.filter((i) => i.tabel === 'dunning_credited_debt').length, 0);
    assert.equal(out.summary.extended_subscriptions, 0);
  } finally { failCredits = new Set(); }
});

test('terugzetten mislukt → status fout met exacte handmatige instructie', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  failCredits = new Set([LATE]); restoreGedrag = 'tl-weigert';
  try {
    const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
    const c = out.customers[0];
    assert.equal(c.status, 'fout');
    assert.equal(c.reverted.ok, false);
    assert.ok(c.errors.some((e) => e.code === 'REVERT_FAILED' && /terug naar 2027-01-01/.test(e.message)));
  } finally { failCredits = new Set(); restoreGedrag = 'ok'; }
});

test('per_month deels gecrediteerd → terugzetten + opnieuw verlengen met het aantal WEL gecrediteerd', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const EXTRA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  db.tables.invoices.push({ id: EXTRA, customer_id: C1, invoice_number: 'F-5', status: 'open', is_test: false, tl_invoice_id: 'tl5', amount_total: 100, amount_paid: 0, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-10' });
  failCredits = new Set([EXTRA]);
  try {
    const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
    const c = out.customers[0];
    assert.deepEqual(volgorde, ['postpone', 'credit', 'credit', 'restore', 'postpone']);
    assert.deepEqual(postpones.map((p) => p.months), [2, 1], 'eerst +2 (gepland), na terugzetten +1 (werkelijk)');
    assert.equal(c.status, 'deels_gecrediteerd');
    assert.equal(c.extended.months, 1);
    assert.equal(c.extended.adjusted_from, 2);
    const debt = db.inserts.find((i) => i.tabel === 'dunning_credited_debt');
    assert.equal(debt.rows.length, 1);
    assert.equal(debt.rows[0].months_extended, 1);
  } finally { failCredits = new Set(); }
});

test('override-basis deels gecrediteerd → verlenging blijft, status deels + expliciete melding', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const EXTRA = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  db.tables.invoices.push({ id: EXTRA, customer_id: C2, invoice_number: 'F-6', status: 'open', is_test: false, tl_invoice_id: 'tl6', amount_total: 100, amount_paid: 0, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-10' });
  failCredits = new Set([EXTRA]);
  try {
    const { out } = await roep({ items: [{ customer_id: C2, subscription_id: S_NULL, months_override: 4 }], only_overdue: true });
    const c = out.customers[0];
    assert.equal(restores.length, 0);
    assert.equal(c.status, 'deels_gecrediteerd');
    assert.ok(c.errors.some((e) => e.code === 'OVERRIDE_PARTIAL'));
  } finally { failCredits = new Set(); }
});

test('"alleen crediteren" (bewust) → geen verlenging, status alleen_gecrediteerd', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C1, subscription_id: null, credit_without_extension: true }], only_overdue: true });
  assert.deepEqual(volgorde, ['credit']);
  assert.equal(out.customers[0].status, 'alleen_gecrediteerd');
});

test('eindstatus per klant + batch_done-audit met status per klant', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }, { customer_id: C2, subscription_id: S_NULL }], only_overdue: true });
  assert.deepEqual(out.customers.map((c) => c.status), ['verlengd_en_gecrediteerd', 'geblokkeerd']);
  assert.equal(out.summary.status_counts.verlengd_en_gecrediteerd, 1);
  assert.equal(out.summary.status_counts.geblokkeerd, 1);
  const done = db.inserts.find((i) => i.tabel === 'audit_log' && i.rows.action === 'crediteer_ronde.batch_done');
  assert.deepEqual(done.rows.after_json.customers.map((c) => c.status), ['verlengd_en_gecrediteerd', 'geblokkeerd']);
  assert.ok(done.rows.after_json.run_id);
});

test('geen abonnement gekozen → geblokkeerd, tenzij credit_without_extension expliciet', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  let r = await roep({ items: [{ customer_id: C1, subscription_id: null }], only_overdue: true });
  assert.equal(credits.length, 0);
  assert.equal(r.out.customers[0].errors[0].code, 'NO_SUBSCRIPTION');
  r = await roep({ items: [{ customer_id: C1, subscription_id: null, credit_without_extension: true }], only_overdue: true });
  assert.deepEqual(credits, [LATE]);
  assert.equal(postpones.length, 0);
});

test('invoice_ids: exact die facturen, ook als er nog andere te-late zijn', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  db.tables.invoices.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', customer_id: C1, invoice_number: 'F-4', status: 'open', is_test: false, tl_invoice_id: 'tl4', amount_total: 50, amount_paid: 0, credited_amount: 0, vat_amount: 8, due_date: '2026-08-15' });
  const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH, invoice_ids: [LATE, NOTDUE] }], only_overdue: true });
  assert.deepEqual(credits, [LATE], 'F-4 niet gevraagd, NOTDUE niet vervallen');
  assert.ok(out.customers[0].rejected.some((r) => r.invoice_id === NOTDUE && r.reden === 'nog niet vervallen'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b · MODE credit_only — ALLEEN crediteren, NOOIT verlengen
// ═══════════════════════════════════════════════════════════════════════════
//
// Kwartaaleinde 2026-Q3: Jeffrey crediteert alleen, zonder abonnementen aan te
// raken. Deze modus mag postpone/restore onder GEEN enkele omstandigheid
// bereiken — ook niet als de klant een bruikbaar per_month-abonnement heeft.

const PAID = '99999999-9999-4999-8999-999999999999';
const CO = (extra = {}) => ({ mode: 'credit_only', ...extra });
const debtInserts = () => db.inserts.filter((i) => i.tabel === 'dunning_credited_debt');

test('credit_only live: crediteert exact de gevraagde facturen en roept postpone/restore NOOIT aan', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { status, out } = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE] }, { customer_id: C2, invoice_ids: [LATE2] }] }));
  assert.equal(status, 200);
  assert.equal(out.mode, 'credit_only');
  assert.deepEqual(credits, [LATE, LATE2]);
  assert.deepEqual(volgorde, ['credit', 'credit'], 'alleen credits — geen postpone, geen restore');
  assert.equal(postpones.length, 0);
  assert.equal(restores.length, 0);
  assert.ok(!db.reads.includes('subscriptions') && !db.reads.includes('deals'), 'abonnementen/deals worden niet eens gelezen');
  assert.deepEqual(out.customers.map((c) => c.status), ['gecrediteerd', 'gecrediteerd']);
  assert.equal(out.customers[0].extended, null);
  const rows = debtInserts().flatMap((i) => i.rows);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.subscription_id === null && r.months_extended === 0));
  assert.equal(out.summary.extended_subscriptions, 0);
  assert.equal(out.summary.status_counts.gecrediteerd, 2);
});

test('credit_only: ook bij een deels mislukte credit wordt er NIETS verlengd of teruggezet', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const EXTRA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  db.tables.invoices.push({ id: EXTRA, customer_id: C1, invoice_number: 'F-5', status: 'open', is_test: false, tl_invoice_id: 'tl5', amount_total: 100, amount_paid: 0, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-10' });
  failCredits = new Set([EXTRA]);
  try {
    const { out } = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE, EXTRA] }] }));
    assert.deepEqual(volgorde, ['credit', 'credit']);
    assert.equal(out.customers[0].status, 'deels_gecrediteerd');
    assert.equal(debtInserts()[0].rows.length, 1);
  } finally { failCredits = new Set(); }
});

test('credit_only: alle credits mislukken → geblokkeerd, geen schuldregels, nog steeds geen postpone', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  failCredits = new Set([LATE]);
  try {
    const { out } = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE] }] }));
    assert.deepEqual(volgorde, ['credit']);
    assert.equal(out.customers[0].status, 'geblokkeerd');
    assert.equal(debtInserts().length, 0);
    assert.equal(out.customers[0].invoices[0].status, 'mislukt');
    assert.match(out.customers[0].invoices[0].reden, /weigerde/);
  } finally { failCredits = new Set(); }
});

test('credit_only zonder invoice_ids → 400, ook met only_overdue; niets gecrediteerd, geen audit', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  for (const body of [
    CO({ items: [{ customer_id: C1 }] }),
    CO({ items: [{ customer_id: C1 }], only_overdue: true }),
    CO({ items: [{ customer_id: C1, invoice_ids: [] }], only_overdue: true }),
    CO({ items: [{ customer_id: C1, invoice_ids: [LATE] }, { customer_id: C2 }] }),
  ]) {
    const { status, out } = await roep(body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(out.error, /invoice_ids verplicht/);
  }
  assert.equal(credits.length, 0);
  assert.equal(db.inserts.length, 0, 'geen audit, geen schuld — er is niets gestart');
});

test('credit_only met subscription_id of months_override → 400 (tegenstrijdige intentie)', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  let r = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE], subscription_id: S_MONTH }] }));
  assert.equal(r.status, 400);
  r = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE], months_override: 2 }] }));
  assert.equal(r.status, 400);
  assert.equal(credits.length + postpones.length, 0);
});

test('onbekende mode → 400', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { status } = await roep({ mode: 'alles', items: [{ customer_id: C1, invoice_ids: [LATE] }] });
  assert.equal(status, 400);
  assert.equal(credits.length, 0);
});

test('credit_only dry-run (instelling ontbreekt): 0 credits, per factuur "zou_crediteren", dry-run-audit met mode', async () => {
  resetDb({ dryRunRow: undefined });
  const { out } = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE] }] }));
  assert.equal(out.dry_run, true);
  assert.equal(credits.length + postpones.length + restores.length, 0);
  assert.equal(debtInserts().length, 0);
  assert.equal(out.customers[0].status, 'gecrediteerd');
  assert.deepEqual(out.customers[0].invoices.map((i) => i.status), ['zou_crediteren']);
  assert.equal(out.summary.credited_invoices, 1);
  const done = db.inserts.find((i) => i.tabel === 'audit_log' && i.rows.action === 'crediteer_ronde.batch_done_dry_run');
  assert.equal(done.rows.after_json.mode, 'credit_only');
  assert.deepEqual(done.rows.after_json.customers[0].invoices.map((i) => i.status), ['zou_crediteren']);
});

test('credit_only: eindstatus per factuur — gecrediteerd / geweigerd met reden (al betaald, niet van klant)', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  db.tables.invoices.push({ id: PAID, customer_id: C1, invoice_number: 'F-9', status: 'paid', is_test: false, tl_invoice_id: 'tl9', amount_total: 100, amount_paid: 100, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-01' });
  const { out } = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE, PAID, LATE2] }] }));
  assert.deepEqual(credits, [LATE]);
  const st = Object.fromEntries(out.customers[0].invoices.map((i) => [i.invoice_number || i.invoice_id, [i.status, i.reden]]));
  assert.deepEqual(st['F-1'], ['gecrediteerd', null]);
  assert.deepEqual(st['F-9'], ['geweigerd', 'status paid']);
  assert.deepEqual(st[LATE2], ['geweigerd', 'hoort niet bij deze klant of bestaat niet']);
});

test('credit_only: niets in scope over → overgeslagen, geen credits', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  db.tables.invoices.push({ id: PAID, customer_id: C1, invoice_number: 'F-9', status: 'paid', is_test: false, tl_invoice_id: 'tl9', amount_total: 100, amount_paid: 100, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-01' });
  const { out } = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [PAID] }] }));
  assert.equal(credits.length, 0);
  assert.equal(out.customers[0].status, 'overgeslagen');
});

test('preview credit_only: scope verplicht, geen abonnementen, afwijsreden klopt, preview == execute', async () => {
  resetDb({ dryRunRow: undefined });
  let r = await roep(CO({ items: [{ customer_id: C1 }] }), preview);
  assert.equal(r.status, 400);
  db.tables.invoices.push({ id: PAID, customer_id: C1, invoice_number: 'F-9', status: 'paid', is_test: false, tl_invoice_id: 'tl9', amount_total: 100, amount_paid: 100, credited_amount: 0, vat_amount: 17.36, due_date: '2026-08-01' });
  db.reads = [];
  r = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE, PAID] }], only_overdue: true }), preview);
  assert.equal(r.status, 200);
  assert.equal(r.out.mode, 'credit_only');
  assert.equal(r.out.dry_run, true);
  const item = r.out.items[0];
  assert.deepEqual(item.invoices.map((i) => i.id), [LATE]);
  assert.deepEqual(item.subscriptions, []);
  assert.deepEqual(item.rejected, [{ invoice_id: PAID, invoice_number: 'F-9', reden: 'status paid' }]);
  assert.ok(!db.reads.includes('subscriptions') && !db.reads.includes('deals'));
  const ex = await roep(CO({ items: [{ customer_id: C1, invoice_ids: [LATE, PAID] }], only_overdue: true }));
  assert.deepEqual(ex.out.customers[0].credited.map((c) => c.invoice_id), item.invoices.map((i) => i.id), 'preview == execute');
});

test('preview credit_only: test-/onbekende klant staat in skipped_customers', async () => {
  resetDb({ dryRunRow: undefined });
  db.tables.customers.push({ id: '55555555-5555-4555-8555-555555555555', first_name: 'Test', is_test: true });
  const { out } = await roep(CO({ items: [
    { customer_id: C1, invoice_ids: [LATE] },
    { customer_id: '55555555-5555-4555-8555-555555555555', invoice_ids: [LATE] },
    { customer_id: '66666666-6666-4666-8666-666666666666', invoice_ids: [LATE] },
  ] }), preview);
  assert.deepEqual(out.items.map((i) => i.customer_id), [C1]);
  assert.deepEqual(out.skipped_customers.map((s) => s.reden).sort(), ['klant niet gevonden', 'test-klant']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · STRUCTUUR
// ═══════════════════════════════════════════════════════════════════════════

const bron = (p) => readFileSync(join(ROOT, p), 'utf8');

test('preview en execute gebruiken de eigen dry-run-vlag, niet dunning_dry_run', () => {
  for (const f of ['api/crediteer-ronde-preview.js', 'api/crediteer-ronde-execute.js']) {
    const s = bron(f);
    assert.ok(!s.includes('dunning-dry-run'), `${f} mag dunning-dry-run niet meer importeren`);
    assert.ok(s.includes('isCrediteerRondeDryRun'), `${f} gebruikt isCrediteerRondeDryRun`);
  }
});

test('execute heeft een eigen maxDuration van 300 s', () => {
  const vj = JSON.parse(bron('vercel.json'));
  assert.equal(vj.functions['api/crediteer-ronde-execute.js']?.maxDuration, 300);
});

test('de UI stuurt per batch hooguit 5 klanten met factuur-ids + only_overdue', () => {
  const s = bron('modules/shared/finance-crediteer.js');
  assert.match(s, /const BATCH_SIZE = 5;/);
  assert.match(s, /invoice_ids\s*:\s*\(it\.invoices/);
  assert.match(s, /only_overdue: true, run_id/);
});

test('UI credit_only: stuurt mode mee en strips abonnementvelden vóór de execute', () => {
  const s = bron('modules/shared/finance-crediteer.js');
  assert.match(s, /mode: MODE_CREDIT_ONLY/);
  assert.match(s, /delete i\.subscription_id; delete i\.months_override; delete i\.credit_without_extension;/);
  assert.match(s, /Server bevestigde de modus "alleen crediteren" niet/);
  assert.match(bron('modules/finance.html'), /finance-crediteer\.js\?v=3/);
});
