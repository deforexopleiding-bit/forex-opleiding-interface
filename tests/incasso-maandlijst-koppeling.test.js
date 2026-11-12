// tests/incasso-maandlijst-koppeling.test.js
//
// Wanbetalers › Incasso-abonnementen (opdracht Maxim, 12 nov 2026):
//   1. Een factuur zonder abonnement-id (Teamleader geeft die sinds augustus
//      2026 niet meer mee) hoort bij het incasso-regelingsabonnement als klant,
//      periode en bedrag eenduidig kloppen — in de maandlijst én in de sync.
//      Echte stand Noorulhaq: factuur 2026 / 2317 (€ 400, 6 nov, vervalt
//      20 nov) stond als "nog geen factuur".
//   2. Een maand is pas achterstand als de vervaldag voorbij is; toekomstige
//      maanden zijn neutraal ('gepland'), de lopende maand 'te betalen'.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';
import {
  koppelRegelingFacturen, trajectFacturen, bouwMaandlijst, maandStand, inclPerTermijn,
} from '../api/_lib/incasso-maandlijst.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const KLANT = '39f28f41-2700-4282-94db-b62f8c28b7c9';
const TL_SUB = 'dc8f544a-ca97-08d9-b86d-d342ee15b6ec';
// Het abonnement zoals het in de database staat (15 × € 400 incl. btw).
const SUB = {
  id: '5f205b9f-6d8b-45d0-b002-51ec9a4cba79', deal_id: 'ghost-deal', soort: 'incasso_regeling', status: 'active',
  teamleader_subscription_id: TL_SUB, amount: 342.86, vat_percentage: 21, term_count: 15, start_date: '2026-11-06', billing_cycle: null,
  line_items: [
    { amount: 219.01, vat_percentage: 21, description: '1-op-1 mentorship 12 maanden' },
    { amount: 123.85, vat_percentage: 9, description: 'E-Book' },
  ],
};
const factuur = (extra) => ({
  customer_id: KLANT, deal_id: null, tl_subscription_id: null, amount_paid: 0, credited_amount: 0, status: 'open', ...extra,
});
// Echte facturen van Noorulhaq sinds september.
const F1910 = factuur({ id: 'f1910', invoice_number: '2026 / 1910', amount_total: 400, credited_amount: 400, status: 'credited', issue_date: '2026-09-24', due_date: '2026-10-08' });
const F2135 = factuur({ id: 'f2135', invoice_number: '2026 / 2135', amount_total: 6800, credited_amount: 6800, status: 'credited', issue_date: '2026-10-19', due_date: '2026-10-26' });
const F2317 = factuur({ id: 'f2317', invoice_number: '2026 / 2317', amount_total: 400, issue_date: '2026-11-06', due_date: '2026-11-20' });
const STATUS = { status: 'incasso_regeling', sinds: '2026-11-03' };

// ═══ 1 · KOPPELING (pure regel) ════════════════════════════════════════════

test('termijnbedrag van het abonnement = € 400 incl. btw (lijnen 21 % en 9 %)', () => {
  assert.equal(inclPerTermijn(SUB), 400);
});

test('Noorulhaq: 2026 / 2317 hoort op periode + bedrag bij het regelingsabonnement; gecrediteerde facturen nooit', () => {
  const k = koppelRegelingFacturen({ facturen: [F1910, F2135, F2317], subs: [SUB] });
  assert.deepEqual([...k], [['f2317', TL_SUB]]);
});

test('Noorulhaq in de maandlijst: november toont 2317 (betaalknop mogelijk), geen "nog geen factuur", geen achterstand', () => {
  const traject = trajectFacturen({ facturen: [F1910, F2135, F2317], subs: [SUB], status: STATUS });
  assert.deepEqual(traject.map((f) => f.id), ['f2317'], 'vroeger: leeg (abonnement-id ontbrak)');
  const m = bouwMaandlijst({ facturen: traject, subs: [SUB], vandaag: '2026-11-12' });
  const nov = m.maanden.find((x) => x.maand === '2026-11');
  assert.deepEqual(nov.facturen.map((f) => [f.nummer, f.open, f.gekoppeld_op]), [['2026 / 2317', 400, 'periode_bedrag']]);
  assert.equal(nov.gepland, 0, 'de termijn van november is gefactureerd');
  assert.equal(nov.verwacht, 400, 'niet dubbel: factuur + termijn');
  assert.equal(nov.stand, 'te_betalen');
  assert.equal(nov.achterstand, 0);
  const dec = m.maanden.find((x) => x.maand === '2026-12');
  assert.equal(dec.stand, 'gepland');
  assert.equal(dec.achterstand, 0);
  assert.equal(m.maanden.length, 15);
  assert.ok(m.maanden.slice(1).every((x) => x.stand === 'gepland' && x.achterstand === 0), 'alle toekomstige maanden neutraal');
  assert.deepEqual(m.totaal, { verwacht: 6000, ontvangen: 0, achterstand: 0 });
});

test('vervaldag-maand als terugval: factuur van eind oktober voor de termijn van november', () => {
  const f = factuur({ id: 'x', amount_total: 400, issue_date: '2026-10-31', due_date: '2026-11-07' });
  assert.deepEqual([...koppelRegelingFacturen({ facturen: [f], subs: [SUB] })], [['x', TL_SUB]]);
});

test('bedrag moet kloppen (± max € 1, 1 %)', () => {
  const ok = factuur({ id: 'ok', amount_total: 403.5, issue_date: '2026-12-06', due_date: '2026-12-20' });
  const nok = factuur({ id: 'nok', amount_total: 450, issue_date: '2027-01-06', due_date: '2027-01-20' });
  assert.deepEqual([...koppelRegelingFacturen({ facturen: [ok, nok], subs: [SUB] })], [['ok', TL_SUB]]);
});

test('niet raden: twee facturen voor één termijn, een al gekoppelde termijn, twee passende abonnementen', () => {
  const a = factuur({ id: 'a', amount_total: 400, issue_date: '2026-11-06', due_date: '2026-11-20' });
  const b = factuur({ id: 'b', amount_total: 400, issue_date: '2026-11-08', due_date: '2026-11-22' });
  assert.equal(koppelRegelingFacturen({ facturen: [a, b], subs: [SUB] }).size, 0, 'twee kandidaten');
  const al = factuur({ id: 'al', amount_total: 400, issue_date: '2026-11-06', due_date: '2026-11-20', tl_subscription_id: TL_SUB });
  assert.equal(koppelRegelingFacturen({ facturen: [al, b], subs: [SUB] }).size, 0, 'termijn al bezet');
  const tweede = { ...SUB, id: 's2', teamleader_subscription_id: 'tl-2' };
  assert.equal(koppelRegelingFacturen({ facturen: [a], subs: [SUB, tweede] }).size, 0, 'twee abonnementen passen');
  assert.equal(koppelRegelingFacturen({ facturen: [a], subs: [{ ...SUB, status: 'cancelled' }] }).size, 0, 'geannuleerd abonnement');
});

test('concept en volledig gecrediteerd koppelen nooit; een factuur met abonnement-id blijft zoals ze is', () => {
  const concept = factuur({ id: 'c', amount_total: 400, status: 'concept', issue_date: '2026-11-06' });
  const cred = factuur({ id: 'cr', amount_total: 400, credited_amount: 400, status: 'credited', issue_date: '2026-12-06' });
  const eigen = factuur({ id: 'e', amount_total: 400, issue_date: '2027-01-06', tl_subscription_id: 'ander' });
  assert.equal(koppelRegelingFacturen({ facturen: [concept, cred, eigen], subs: [SUB] }).size, 0);
});

// ═══ 2 · STAND PER MAAND ═══════════════════════════════════════════════════

test('achterstand enkel bij een vervallen, onbetaalde factuur; toekomst neutraal; termijn zonder factuur nooit rood', () => {
  const sub = { ...SUB, start_date: '2026-09-06', term_count: 6 };
  const sep = factuur({ id: 'sep', amount_total: 400, amount_paid: 400, status: 'paid', paid_date: '2026-09-15', issue_date: '2026-09-06', due_date: '2026-09-20', tl_subscription_id: TL_SUB });
  const okt = factuur({ id: 'okt', amount_total: 400, issue_date: '2026-10-06', due_date: '2026-10-20', tl_subscription_id: TL_SUB });
  // november: geen factuur (termijndatum 6 nov voorbij)
  const m = bouwMaandlijst({ facturen: [sep, okt], subs: [sub], vandaag: '2026-11-12' });
  const st = Object.fromEntries(m.maanden.map((x) => [x.maand, [x.stand, x.achterstand]]));
  assert.deepEqual(st['2026-09'], ['betaald', 0]);
  assert.deepEqual(st['2026-10'], ['achterstand', 400]);
  assert.deepEqual(st['2026-11'], ['te_betalen', 400], 'lopende maand: te betalen, de achterstand van oktober loopt door');
  assert.deepEqual(st['2026-12'], ['gepland', 0], 'toekomst draagt geen achterstand');
  assert.deepEqual(st['2027-02'], ['gepland', 0]);
  assert.equal(m.totaal.achterstand, 400, 'de termijn van november zonder factuur telt niet als achterstand');
});

test('voorbije maand met een termijn zonder factuur = factuur_ontbreekt (niet rood)', () => {
  assert.equal(maandStand({ maand: '2026-10', open: 0, open_vervallen: 0, gepland: 400, gepland_voorbij: 400, verwacht: 400 }, '2026-11'), 'factuur_ontbreekt');
  assert.equal(maandStand({ maand: '2026-11', open: 400, open_vervallen: 0, gepland: 0, gepland_voorbij: 0, verwacht: 400 }, '2026-11'), 'te_betalen');
  assert.equal(maandStand({ maand: '2026-11', open: 400, open_vervallen: 400, gepland: 0, gepland_voorbij: 0, verwacht: 400 }, '2026-11'), 'achterstand');
  assert.equal(maandStand({ maand: '2026-12', open: 400, open_vervallen: 0, gepland: 0, gepland_voorbij: 0, verwacht: 400 }, '2026-11'), 'gepland');
});

// ═══ 3 · SYNC (echte invoice-upsert tegen een nep-database) ════════════════

const db = maakNepDb();
let tlInvoice = null;
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/teamleader-token.js'), {
  namedExports: {
    tlFetch: async () => {
      const body = JSON.stringify({ data: tlInvoice });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    },
  },
});
mock.module(url('api/_lib/sales-bonus.js'), { namedExports: { earnBonusForPaidInvoice: async () => ({ ok: true }), voidBonusForCreditedInvoice: async () => ({ ok: true }) } });
mock.module(url('api/_lib/factuurstand-spiegel.js'), { namedExports: { spiegelFactuurstandNaWijziging: async () => {} } });
const { upsertInvoiceFromTl } = await import(url('api/_lib/invoice-upsert.js'));
const { _resetKoppelCache } = await import(url('api/_lib/incasso-factuur-koppeling.js'));

const tl2317 = (extra = {}) => ({
  id: 'tl-2317', status: 'outstanding', paid: false, invoice_number: '2026 / 2317', invoice_date: '2026-11-06', due_on: '2026-11-20',
  total: { tax_inclusive: { amount: 400 }, tax_exclusive: { amount: 350.6 }, payable: { amount: 400 }, due: { amount: 400 } },
  invoicee: { customer: { id: 'tl-contact', type: 'contact' } }, ...extra,
});
function resetDb({ subs = [SUB], invoices = [] } = {}) {
  _resetKoppelCache();
  db.tables = {
    customers: [{ id: KLANT, tl_contact_id: 'tl-contact', archived_at: null, anonymized_at: null, created_at: '2026-01-01' }],
    deals: [{ id: 'ghost-deal', customer_id: KLANT }],
    subscriptions: subs,
    invoices,
    credit_notes: [],
    payments: [],
  };
}
const rij = () => db.tables.invoices.find((i) => i.tl_invoice_id === 'tl-2317');

test('sync: Teamleader geeft geen abonnement-id → gekoppeld op klant + periode + bedrag (+ deal van het abonnement)', async () => {
  resetDb({ invoices: [{ ...F1910 }, { ...F2135 }] });
  tlInvoice = tl2317();
  const r = await upsertInvoiceFromTl('tl-2317');
  assert.equal(r.action, 'inserted');
  assert.equal(rij().tl_subscription_id, TL_SUB);
  assert.equal(rij().deal_id, 'ghost-deal');
});

test('sync: een gekoppelde factuur wordt NIET teruggezet naar NULL als Teamleader geen abonnement-id geeft', async () => {
  resetDb({ subs: [], invoices: [{ id: 'f2317', tl_invoice_id: 'tl-2317', customer_id: KLANT, deal_id: null, tl_subscription_id: TL_SUB, status: 'open', amount_paid: 0 }] });
  tlInvoice = tl2317();
  await upsertInvoiceFromTl('tl-2317');
  assert.equal(rij().tl_subscription_id, TL_SUB);
});

test('sync: een abonnement-id van Teamleader wint altijd', async () => {
  resetDb({ invoices: [{ id: 'f2317', tl_invoice_id: 'tl-2317', customer_id: KLANT, deal_id: null, tl_subscription_id: 'oud', status: 'open', amount_paid: 0 }] });
  tlInvoice = tl2317({ subscription: { id: 'van-tl' } });
  await upsertInvoiceFromTl('tl-2317');
  assert.equal(rij().tl_subscription_id, 'van-tl');
});

test('sync: geen regelingsabonnement, ander bedrag of concept → blijft NULL', async () => {
  resetDb({ subs: [] });
  tlInvoice = tl2317();
  await upsertInvoiceFromTl('tl-2317');
  assert.equal(rij().tl_subscription_id, null, 'klant zonder regelingsabonnement');

  resetDb();
  tlInvoice = tl2317({ total: { tax_inclusive: { amount: 999 }, tax_exclusive: { amount: 825.6 }, payable: { amount: 999 }, due: { amount: 999 } } });
  await upsertInvoiceFromTl('tl-2317');
  assert.equal(rij().tl_subscription_id, null, 'bedrag past niet');

  resetDb();
  tlInvoice = tl2317({ status: 'draft', invoice_number: null });
  await upsertInvoiceFromTl('tl-2317');
  assert.equal(rij().tl_subscription_id, null, 'concept');
});

test('sync: een fout bij het koppelen breekt de sync niet (fail-soft)', async () => {
  resetDb();
  db.missing.add('deals');
  tlInvoice = tl2317();
  try {
    const r = await upsertInvoiceFromTl('tl-2317');
    assert.equal(r.action, 'inserted');
    assert.equal(rij().tl_subscription_id, null);
  } finally {
    db.missing.delete('deals');
  }
});
