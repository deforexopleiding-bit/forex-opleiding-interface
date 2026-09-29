// tests/gecrediteerd-niet-betaald.test.js
//
// GECREDITEERD ≠ BETAALD.
//
// 29 september 2026: 281 van de 282 gecrediteerde facturen stonden als
// status 'paid' met amount_paid = het volledige bedrag. Teamleader verrekent
// een creditnota met de factuur (due = 0, paid = true) en de sync nam dat over
// als betaling. Gevolg: mentorbonus, onboarding-spiegel, sales-bonus en
// rapporten telden creditnota's als betalingen (≈ € 146k).
//
// Deze tests draaien de ECHTE sync (invoice-upsert), de creditnota-
// herberekening en de terugdraai-endpoint tegen een nep-database met een
// nagebootst Teamleader.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const bron = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── nep-database ──────────────────────────────────────────────────────────
const db = { tables: {}, updates: [], inserts: [] };
function parseOr(expr) {
  // "col.eq.val,col2.eq.val2" → [[col,val],...]
  return expr.split(',').map((p) => { const [c, op, ...v] = p.split('.'); return op === 'eq' ? [c, v.join('.')] : null; }).filter(Boolean);
}
function nepAdmin() {
  return {
    from(tabel) {
      let rows = [...(db.tables[tabel] || [])];
      let op = 'select', patch = null, headCount = false;
      const k = {
        select: (_c, o) => { if (o?.head) headCount = true; return k; },
        eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return k; },
        neq: (c, v) => { rows = rows.filter((r) => r[c] !== v); return k; },
        in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return k; },
        or: (expr) => { const conds = parseOr(expr); rows = rows.filter((r) => conds.some(([c, v]) => r[c] === v)); return k; },
        order: () => k, limit: () => k,
        insert(v) { op = 'insert'; db.inserts.push({ tabel, rows: v }); return k; },
        update(v) { op = 'update'; patch = v; return k; },
        delete() { op = 'delete'; return k; },
        maybeSingle: async () => k._done(true),
        single: async () => k._done(true),
        then: (r, j) => Promise.resolve(k._done(false)).then(r, j),
        _done(single) {
          if (op === 'update') {
            for (const r of rows) { db.updates.push({ tabel, id: r.id, patch }); Object.assign(r, patch); }
            return { data: single ? (rows[0] ?? null) : rows, error: null };
          }
          if (op === 'insert') return { data: single ? { id: 'nieuw' } : null, error: null };
          if (op === 'delete') return { data: null, error: null };
          if (headCount) return { data: null, count: rows.length, error: null };
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        },
      };
      return k;
    },
  };
}

// ── nagebootst Teamleader ─────────────────────────────────────────────────
let tlInvoice = null;
const tlCalls = [];
mock.module(url('api/supabase.js'), {
  namedExports: {
    supabaseAdmin: nepAdmin(),
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  },
});
mock.module(url('api/_lib/teamleader-token.js'), {
  namedExports: {
    tlFetch: async (path) => {
      tlCalls.push(path);
      const body = JSON.stringify({ data: tlInvoice });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    },
  },
});
const hooks = [];
mock.module(url('api/_lib/sales-bonus.js'), {
  namedExports: {
    earnBonusForPaidInvoice: async (inv) => { hooks.push(['earn', inv.id]); return { ok: true }; },
    voidBonusForCreditedInvoice: async (inv) => { hooks.push(['void', inv.id]); return { ok: true }; },
  },
});
mock.module(url('api/_lib/factuurstand-spiegel.js'), { namedExports: { spiegelFactuurstandNaWijziging: async () => {} } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/audit-customer.js'), { namedExports: { getClientIp: () => '127.0.0.1' } });

const { upsertInvoiceFromTl } = await import(url('api/_lib/invoice-upsert.js'));
const { recomputeCreditedAmount } = await import(url('api/_lib/creditnote-upsert.js'));
const { default: removePayment } = await import(url('api/finance-invoice-remove-payment.js'));
const { bepaalBetaalstand, telAlsBetaald, betaaldBedrag, openBedrag, isVolledigGecrediteerd } = await import(url('api/_lib/factuur-betaald.js'));

const TL = 'tl-inv-1';
const INV = '11111111-1111-4111-8111-111111111111';
const KLANT = '22222222-2222-4222-8222-222222222222';

function reset({ bestaand = null, creditnotas = [], betalingen = [] } = {}) {
  db.updates = []; db.inserts = []; hooks.length = 0; tlCalls.length = 0;
  db.tables = {
    customers: [{ id: KLANT, tl_contact_id: 'tl-contact', archived_at: null, anonymized_at: null, created_at: '2026-01-01' }],
    subscriptions: [],
    invoices: bestaand ? [{ id: INV, tl_invoice_id: TL, customer_id: KLANT, deal_id: null, ...bestaand }] : [],
    credit_notes: creditnotas.map((c, i) => ({ id: 'cn' + i, tl_invoice_id: TL, invoice_id: bestaand ? INV : null, ...c })),
    payments: betalingen.map((p, i) => ({ id: 'p' + i, invoice_id: INV, ...p })),
    audit_log: [],
  };
}
// Teamleader na verrekening van een volledige creditnota: payable = totaal, due = 0, paid.
const tlGecrediteerd = (totaal) => ({ id: TL, status: 'matched', paid: true, paid_at: '2026-09-29T00:00:00+02:00', updated_at: '2026-09-29T10:00:00+02:00',
  invoice_number: '2026 / 1393', invoice_date: '2026-07-16', due_on: '2026-07-23',
  total: { tax_inclusive: { amount: totaal }, tax_exclusive: { amount: totaal / 1.21 }, payable: { amount: totaal }, due: { amount: 0 } },
  invoicee: { customer: { id: 'tl-contact', type: 'contact' } } });
const laatsteInvoiceWrite = () => [...db.updates].reverse().find((u) => u.tabel === 'invoices')?.patch || db.inserts.find((i) => i.tabel === 'invoices')?.rows;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE REGEL (pure functie)
// ═══════════════════════════════════════════════════════════════════════════

test('bron-regel: zonder creditnota exact zoals altijd', () => {
  assert.deepEqual(bepaalBetaalstand({ totaal: 100, tlBetaald: 100, gecrediteerd: 0, tlStatus: 'paid' }), { status: 'paid', betaald: 100 });
  assert.deepEqual(bepaalBetaalstand({ totaal: 100, tlBetaald: 40, gecrediteerd: 0, tlStatus: 'partially_paid' }), { status: 'partially_paid', betaald: 40 });
  assert.deepEqual(bepaalBetaalstand({ totaal: 100, tlBetaald: 0, gecrediteerd: 0, tlStatus: 'open' }), { status: 'open', betaald: 0 });
});

test('bron-regel: volledig gecrediteerd zonder betaling → credited, 0 betaald', () => {
  assert.deepEqual(bepaalBetaalstand({ totaal: 99.99, tlBetaald: 99.99, gecrediteerd: 99.99, tlStatus: 'paid' }), { status: 'credited', betaald: 0 });
});

test('bron-regel: echte betaling in payments náást een credit blijft betaald', () => {
  assert.deepEqual(bepaalBetaalstand({ totaal: 605, tlBetaald: 605, gecrediteerd: 605, echteBetalingen: 605, tlStatus: 'paid' }), { status: 'paid', betaald: 605 });
  // Teamleader die betaling én creditnota verrekent (due negatief → tlBetaald 2×):
  assert.deepEqual(bepaalBetaalstand({ totaal: 300, tlBetaald: 600, gecrediteerd: 300, tlStatus: 'paid' }), { status: 'paid', betaald: 300 });
});

test('bron-regel: deels gecrediteerd — voldaan wordt paid (echt deel), open rest blijft open voor de aanmaning', () => {
  // 300, € 100 gecrediteerd, € 200 betaald → voldaan; amount_paid = alleen het echte deel.
  assert.deepEqual(bepaalBetaalstand({ totaal: 300, tlBetaald: 300, gecrediteerd: 100, tlStatus: 'paid' }), { status: 'paid', betaald: 200 });
  // 300, € 100 gecrediteerd, niets betaald → € 200 staat open, dus 'open' (niet 'partially_credited').
  assert.deepEqual(bepaalBetaalstand({ totaal: 300, tlBetaald: 100, gecrediteerd: 100, tlStatus: 'partially_paid' }), { status: 'open', betaald: 0 });
  // 300, € 100 gecrediteerd, € 50 betaald → partially_paid 50.
  assert.deepEqual(bepaalBetaalstand({ totaal: 300, tlBetaald: 150, gecrediteerd: 100, tlStatus: 'partially_paid' }), { status: 'partially_paid', betaald: 50 });
});

test('vangnet: oude én nieuwe rij van een gecrediteerde factuur tellen nooit als betaald', () => {
  const oud = { status: 'paid', amount_total: 100, amount_paid: 100, credited_amount: 100 };
  const nieuw = { status: 'credited', amount_total: 100, amount_paid: 0, credited_amount: 100 };
  for (const r of [oud, nieuw]) {
    assert.equal(isVolledigGecrediteerd(r), true);
    assert.equal(telAlsBetaald(r), false);
    assert.equal(betaaldBedrag(r), 0);
    assert.equal(openBedrag(r), 0);
  }
  const deelsVoldaan = { status: 'paid', amount_total: 300, amount_paid: 200, credited_amount: 100 };
  assert.equal(telAlsBetaald(deelsVoldaan), true);
  assert.equal(openBedrag(deelsVoldaan), 0);
  const deelsOpen = { status: 'open', amount_total: 300, amount_paid: 0, credited_amount: 100 };
  assert.equal(telAlsBetaald(deelsOpen), false);
  assert.equal(openBedrag(deelsOpen), 200);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE ECHTE SYNC (invoice-upsert)
// ═══════════════════════════════════════════════════════════════════════════

test('sync: volledig gecrediteerde factuur → status credited, amount_paid 0, geen betaaldatum, bonus INGETROKKEN', async () => {
  reset({ bestaand: { status: 'open', amount_paid: 0, credited_amount: 0 }, creditnotas: [{ amount_total: 99.99 }] });
  tlInvoice = tlGecrediteerd(99.99);
  const uit = await upsertInvoiceFromTl(TL);
  assert.equal(uit.status, 'credited');
  const w = laatsteInvoiceWrite();
  assert.equal(w.status, 'credited');
  assert.equal(w.amount_paid, 0);
  assert.equal(w.credited_amount, 99.99);
  assert.equal(w.paid_date, null);
  assert.deepEqual(hooks, [['void', INV]], 'intrek-tak vuurt; earn NIET');
});

test('sync: credit rechtstreeks in Teamleader (oude rij "paid") → credited + intrek-hook (sales-bonus-gat dicht)', async () => {
  reset({ bestaand: { status: 'paid', amount_paid: 100, credited_amount: 100 }, creditnotas: [{ amount_total: 100 }] });
  tlInvoice = tlGecrediteerd(100);
  await upsertInvoiceFromTl(TL);
  assert.equal(laatsteInvoiceWrite().status, 'credited');
  assert.deepEqual(hooks, [['void', INV]]);
});

test('sync: echte betaling in payments + volledige credit → blijft paid met het betaalde bedrag', async () => {
  reset({ bestaand: { status: 'paid', amount_paid: 605, credited_amount: 605 }, creditnotas: [{ amount_total: 605 }], betalingen: [{ amount: 605 }] });
  tlInvoice = tlGecrediteerd(605);
  await upsertInvoiceFromTl(TL);
  const w = laatsteInvoiceWrite();
  assert.equal(w.status, 'paid');
  assert.equal(w.amount_paid, 605);
});

test('sync: zonder creditnota ongewijzigd gedrag (betaald → paid + earn-hook)', async () => {
  reset({ bestaand: { status: 'open', amount_paid: 0, credited_amount: 0 } });
  tlInvoice = { ...tlGecrediteerd(100), status: 'matched' };
  await upsertInvoiceFromTl(TL);
  const w = laatsteInvoiceWrite();
  assert.equal(w.status, 'paid');
  assert.equal(w.amount_paid, 100);
  assert.equal(w.credited_amount, 0);
  assert.equal(w.paid_date, '2026-09-29');
  assert.deepEqual(hooks, [['earn', INV]]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · CREDITNOTA KOMT NA DE FACTUUR BINNEN (herberekening)
// ═══════════════════════════════════════════════════════════════════════════

test('herberekening: creditnota na de factuur → paid wordt credited, amount_paid 0, intrek-hook', async () => {
  // De uurlijkse sync doet eerst facturen (TL zegt paid), dán creditnota's.
  reset({ bestaand: { status: 'paid', amount_total: 100, amount_paid: 100, credited_amount: 0, paid_date: '2026-09-29', customer_id: KLANT }, creditnotas: [{ amount_total: 100 }] });
  await recomputeCreditedAmount([INV]);
  const w = laatsteInvoiceWrite();
  assert.equal(w.credited_amount, 100);
  assert.equal(w.status, 'credited');
  assert.equal(w.amount_paid, 0);
  assert.equal(w.paid_date, null);
  assert.deepEqual(hooks, [['void', INV]]);
});

test('herberekening: oude rij met ongewijzigd bedrag wordt NIET aangeraakt (daarvoor is de datafix)', async () => {
  reset({ bestaand: { status: 'paid', amount_total: 100, amount_paid: 100, credited_amount: 100, customer_id: KLANT }, creditnotas: [{ amount_total: 100 }] });
  await recomputeCreditedAmount([INV]);
  const w = laatsteInvoiceWrite();
  assert.equal(w.status, undefined, 'geen statuswijziging');
  assert.equal(w.amount_paid, undefined);
  assert.equal(hooks.length, 0);
});

test('herberekening: deels gecrediteerd op open factuur → blijft open (aanmaning op de rest loopt door)', async () => {
  reset({ bestaand: { status: 'open', amount_total: 300, amount_paid: 0, credited_amount: 0, customer_id: KLANT }, creditnotas: [{ amount_total: 100 }] });
  await recomputeCreditedAmount([INV]);
  const w = laatsteInvoiceWrite();
  assert.equal(w.status, 'open');
  assert.equal(w.amount_paid, 0);
  assert.equal(hooks.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · "BETALING TERUGDRAAIEN" OP EEN GECREDITEERDE FACTUUR
// ═══════════════════════════════════════════════════════════════════════════

async function roepRemove(body) {
  let status = 0, out = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { out = b; return this; } };
  await removePayment({ method: 'POST', body, headers: {} }, res);
  return { status, out };
}

test('terugdraaien: gecrediteerd zonder rij in payments → 409, GEEN Teamleader-call', async () => {
  reset({ bestaand: { status: 'paid', amount_total: 100, amount_paid: 100, credited_amount: 100 }, creditnotas: [{ amount_total: 100 }] });
  const { status, out } = await roepRemove({ invoice_id: INV });
  assert.equal(status, 409);
  assert.equal(out.code, 'GECREDITEERD_GEEN_BETALING');
  assert.equal(tlCalls.length, 0);
});

test('terugdraaien: factuur zonder creditnota (betaling in Teamleader geboekt) blijft terug te draaien', async () => {
  reset({ bestaand: { status: 'paid', amount_total: 100, amount_paid: 100, credited_amount: 0 } });
  tlInvoice = { id: TL, status: 'outstanding', paid: false, total: { payable: { amount: 100 }, due: { amount: 100 } } };
  const { status } = await roepRemove({ invoice_id: INV });
  assert.equal(status, 200);
  assert.ok(tlCalls.includes('/invoices.removePayments'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · STRUCTUUR: de geldpaden gebruiken het vangnet
// ═══════════════════════════════════════════════════════════════════════════

test('mentorbonus-overzicht + release-functies tellen via het vangnet (credited_amount mee in de selects)', () => {
  const ov = bron('api/mentor-bonus-overview.js');
  assert.match(ov, /from '\.\/_lib\/factuur-betaald\.js'/);
  assert.match(ov, /telAlsBetaald\(inv\)/);
  assert.match(ov, /isVolledigGecrediteerd\(invForTerm\)/);
  assert.equal((ov.match(/amount_paid, credited_amount/g) || []).length, 3, 'alle drie de factuur-selects halen credited_amount op');
  const eng = bron('api/_lib/mentor-ledger-engine.js');
  assert.match(eng, /from '\.\/factuur-betaald\.js'/);
  assert.ok(!/Number\(i(nv)?\.amount_paid\)\s*\|\|\s*0/.test(eng), 'geen kale amount_paid-som meer in de engine');
  assert.match(eng, /!telAlsBetaald\(inv\)/);
});

test('UI verbergt "Betaling terugdraaien" bij een volledig gecrediteerde factuur', () => {
  for (const f of ['modules/finance.html', 'modules/klanten.html']) {
    const s = bron(f);
    const n = (s.match(/amount_paid\) \|\| 0\) > 0 && !\(\(Number\(inv\.credited_amount\)/g) || []).length;
    assert.equal(n, 2, f);
  }
  assert.match(bron('modules/klanten-v2/views/finance-detail-v2.js'), /canRemove\s+= !isConcept && paidNum > 0 && !volledigGecrediteerd/);
});
