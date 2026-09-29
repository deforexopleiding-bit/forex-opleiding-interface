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
let postponeGedrag = 'ok';
const db = { tables: {}, inserts: [], updates: [] };

function nepAdmin() {
  return {
    from(tabel) {
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
  namedExports: { creditInvoiceCore: async (id) => { credits.push(id); return { tl_credit_note_id: 'cn-' + id }; } },
});
mock.module(url('api/_lib/subscription-postpone.js'), {
  namedExports: {
    postponeSubscription: async (sub, months, opts) => {
      postpones.push({ sub: sub.id, months, tlFirst: opts?.tlFirst });
      if (postponeGedrag === 'tl-weigert') { const e = new Error('Teamleader weigerde (HTTP 400)'); e.code = 'TL_NOT_CONFIRMED'; throw e; }
      return { tl: { pushed: true }, extended: true };
    },
  },
});
const { selectCreditable, planExtension, hasScope, isUsableSubscription } = await import(url('api/_lib/crediteer-ronde-core.js'));
const { default: execute } = await import(url('api/crediteer-ronde-execute.js'));

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
  db.inserts = []; db.updates = [];
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
async function roep(body) {
  credits.length = 0; postpones.length = 0;
  let status = 0, out = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { out = b; return this; } };
  await execute({ method: 'POST', body: { confirm: true, ...body }, headers: {} }, res);
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
  assert.equal(out.summary.blocked_customers, 1);
  assert.equal(out.customers[0].errors[0].code, 'CYCLE_UNSUPPORTED');
});

test('onbekende cyclus mét months_override → crediteren + verlengen met die maanden', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  const { out } = await roep({ items: [{ customer_id: C2, subscription_id: S_NULL, months_override: 3 }], only_overdue: true });
  assert.deepEqual(credits, [LATE2]);
  assert.deepEqual(postpones, [{ sub: S_NULL, months: 3, tlFirst: true }]);
  assert.equal(out.customers[0].extended.basis, 'override');
});

test('Teamleader weigert de verlenging → extended:false + expliciete fout, schuld zonder abo-koppeling', async () => {
  resetDb({ dryRunRow: { enabled: false } });
  postponeGedrag = 'tl-weigert';
  try {
    const { out } = await roep({ items: [{ customer_id: C1, subscription_id: S_MONTH }], only_overdue: true });
    const c = out.customers[0];
    assert.equal(c.extended.extended, false);
    assert.ok(c.errors.some((e) => e.code === 'TL_NOT_CONFIRMED' && /NIET verlengd/.test(e.message)));
    assert.equal(out.summary.extended_subscriptions, 0);
    const debt = db.inserts.find((i) => i.tabel === 'dunning_credited_debt');
    assert.equal(debt.rows[0].subscription_id, null);
    assert.equal(debt.rows[0].months_extended, 0);
  } finally { postponeGedrag = 'ok'; }
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
