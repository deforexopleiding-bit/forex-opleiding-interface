// tests/commissie-soort-abonnement.test.js
//
// PR 2 mentorcommissie — soort abonnement (beslissing Maxim, 3 nov 2026):
//   * een nieuwe offerte zonder commissie geeft NIETS vrij op een oude
//     event-bonus (ook niet via facturen zonder deal/abonnement);
//   * uitstel van meer dan 92 dagen laat de commissie niet wegvallen;
//   * een lager maandbedrag blijft correct en onder het maximum;
//   * engine en overzicht (= rapport) tellen hetzelfde.
// Echte engine en echt overzicht, nep-database.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';
import { valideerSoort, stelSoortVoor, saleVanSoort } from '../api/_lib/subscription-soort.js';
import { maakSaleScope, factuurVanSale } from '../api/_lib/commissie-toewijzing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async () => ({ ok: true }) } });
const engine = await import(url('api/_lib/mentor-ledger-engine.js'));
const { computeBonusOverview } = await import(url('api/mentor-bonus-overview.js'));

const K = '11111111-1111-4111-8111-111111111111';
const S = '5a000000-0000-4000-8000-000000000001';   // getekende event-sale (feb 2026)
const G = '6b000000-0000-4000-8000-000000000002';   // ghost-deal van het originele abonnement
const U = '6b000000-0000-4000-8000-000000000003';   // ghost-deal van het uitgestelde/aangepaste abonnement
const N = '7c000000-0000-4000-8000-000000000004';   // nieuwe offerte (okt 2026)
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const EV = 'e0000000-0000-4000-8000-0000000000e1';

const getekend = (id, op) => ({ id, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: op + 'T10:00:00Z', created_at: op + 'T09:00:00Z' });
const ghost = (id, op) => ({ id, customer_id: K, tl_quotation_status: 'no_quotation', source: 'tl_import', created_at: op + 'T09:00:00Z' });
const fact = (id, extra) => ({ id, customer_id: K, deal_id: null, tl_subscription_id: null, amount_total: 400, amount_paid: 400,
  credited_amount: 0, status: 'paid', paid_date: '2026-03-05', due_date: '2026-03-01', created_at: '2026-03-01T00:00:00Z', ...extra });

function zet({ deals = [], subs = [], facturen = [] } = {}) {
  db.reset({
    customers: [{ id: K, first_name: 'Klaas', last_name: 'T' }],
    events: [{ id: EV, title: 'Event feb', starts_at: '2026-02-10T09:00:00Z' }],
    deals: [getekend(S, '2026-02-12'), ghost(G, '2026-02-20'), ...deals],
    subscriptions: subs,
    invoices: facturen,
    payments: [],
    mentor_sale_attributions: [],
    mentor_payouts: [],
    mentor_payout_adjustments: [],
    dunning_credited_debt: [],
    mentor_ledger_entries: [{
      id: 'p', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 4800, pct: 3,
      amount: 144, original_amount: null, status: 'pending', parent_entry_id: null, source_quote_id: S,
      idempotency_key: `${EV}:bonus:att:${A}`, created_at: '2026-02-12T00:00:00Z',
    }],
  });
}
const vrij = () => Math.round(db.rows('mentor_ledger_entries').filter((e) => e.parent_entry_id === 'p').reduce((s, e) => s + Number(e.amount), 0) * 100) / 100;
const sub = (id, deal, tl, start, extra = {}) => ({ id, deal_id: deal, teamleader_subscription_id: tl, amount: 400, vat_percentage: 0,
  term_count: 12, billing_cycle: 'per_month', start_date: start, status: 'active', ...extra });

/* ── 1. Nieuwe offerte zonder commissie ─────────────────────────────────── */
test('nieuwe offerte zonder commissie: geeft NIETS vrij op de oude event-bonus', async () => {
  zet({
    deals: [getekend(N, '2026-10-01')],
    subs: [sub('so', G, 'tl-o', '2026-03-01', { soort: 'origineel', sale_deal_id: S }),
      sub('sn', N, 'tl-n', '2026-10-15', { soort: 'nieuwe_offerte', sale_deal_id: N })],
    facturen: [
      fact('o1', { tl_subscription_id: 'tl-o' }),                                   // oude sale: telt
      fact('n1', { tl_subscription_id: 'tl-n', paid_date: '2026-10-20' }),          // nieuwe offerte: nooit
      fact('n2', { deal_id: N, paid_date: '2026-11-01' }),                          // nieuwe offerte via deal_id: nooit
      fact('l1', { paid_date: '2026-10-25' }),                                      // los (geen deal/abonnement): onbekend
    ],
  });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(vrij(), 12, 'enkel 400 van de oude sale: 144 × 400 / 4800');
  assert.deepEqual(r.simulations.filter((x) => x.would_release).map((x) => x.invoice_id), ['o1'], 'enkel de factuur van de oude sale');
});

test('nieuwe offerte die WEL toegewezen is: telt voor de toewijzing, niet voor de oude bonus', () => {
  const deals = [getekend(S, '2026-02-12'), getekend(N, '2026-10-01')];
  const subs = [sub('sn', N, 'tl-n', '2026-10-15', { soort: 'nieuwe_offerte', sale_deal_id: N })];
  const sc = maakSaleScope({ deals, subs, commissieSales: new Map([[K, new Set([S, N])]]) });
  const inv = { customer_id: K, tl_subscription_id: 'tl-n' };
  assert.equal(factuurVanSale(inv, N, sc, K), true);
  assert.equal(factuurVanSale(inv, S, sc, K), false);
});

/* ── 2. Uitstel van meer dan 92 dagen ───────────────────────────────────── */
test('uitstel > 92 dagen (aanpassing): commissie valt NIET weg — engine en overzicht', async () => {
  // Abonnement uitgesteld tot sept (start 7 maanden na tekenen). Met de oude
  // 92-dagenregel hoorde het bij geen enkele sale. Een nieuwe offerte bij de
  // klant zorgt dat ook de overgangsregel ("enige commissie-sale") niet redt:
  // enkel de soort beslist.
  zet({
    deals: [ghost(U, '2026-08-20'), getekend(N, '2026-10-01')],
    subs: [sub('su', U, 'tl-u', '2026-09-01', { soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: S, postponed_months: 6 }),
      sub('sn', N, 'tl-n', '2026-10-15', { soort: 'nieuwe_offerte', sale_deal_id: N })],
    facturen: [fact('u1', { tl_subscription_id: 'tl-u', paid_date: '2026-09-03', due_date: '2026-09-01' }),
      fact('u2', { tl_subscription_id: 'tl-u', paid_date: '2026-10-02', due_date: '2026-10-01' })],
  });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(vrij(), 24, '144 × 800 / 4800');

  const o = await computeBonusOverview(A);
  const cel = o.per_event.flatMap((e) => e.sales)[0];
  assert.equal(cel.schema_unknown, false, 'het uitgestelde abonnement hoort bij de sale');
  assert.equal(cel.paid_term_count, 2);
  assert.equal(cel.termijnen.filter((t) => t.status === 'betaald').length, 2);
});

test('zonder soort (overgang): uitstel > 92 dagen valt terug op de enige commissie-sale', async () => {
  zet({
    deals: [ghost(U, '2026-08-20')],
    subs: [sub('su', U, 'tl-u', '2026-09-01')],
    facturen: [fact('u1', { tl_subscription_id: 'tl-u', paid_date: '2026-09-03' })],
  });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(vrij(), 12, 'zoals het klantbrede optellen deed — gemeld als "soort ontbreekt"');
});

/* ── 3. Lager maandbedrag ──────────────────────────────────────────────── */
test('lager maandbedrag (aanpassing): commissie volgt wat betaald is en blijft onder het maximum', async () => {
  // Sale 4800 (12 × 400); aanpassing naar 12 × 250 = 3000. Volledig betaald.
  const facturen = Array.from({ length: 12 }, (_, i) => fact(`a${i}`, { tl_subscription_id: 'tl-a', amount_total: 250, amount_paid: 250,
    due_date: `2027-${String(i + 1).padStart(2, '0')}-01`, paid_date: `2027-${String(i + 1).padStart(2, '0')}-02` }));
  zet({ deals: [ghost(U, '2026-12-20')], subs: [sub('sa', U, 'tl-a', '2027-01-01', { amount: 250, soort: 'aanpassing', aanpassing_type: 'lager_bedrag', sale_deal_id: S })], facturen });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(vrij(), 90, '144 × 3000 / 4800 = 90 (< maximum 144)');

  // Komt er later méér binnen dan de basis, dan nooit boven het maximum.
  db.tables.invoices.push(fact('x1', { tl_subscription_id: 'tl-a', amount_total: 3000, amount_paid: 3000, paid_date: '2027-12-20' }));
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(vrij(), 144, 'gecapt op de oorspronkelijke commissie');
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(vrij(), 144, 'nooit dubbel');
});

/* ── Pure regels ───────────────────────────────────────────────────────── */
test('valideerSoort: verplicht, aanpassing vraagt type, sale moet een getekende deal van de klant zijn', () => {
  const deals = [getekend(S, '2026-02-12'), ghost(G, '2026-02-20'), { id: 'vreemd', customer_id: 'ander', tl_quotation_status: 'accepted' }];
  assert.equal(valideerSoort({}, { dealsVanKlant: deals }).ok, false);
  assert.equal(valideerSoort({ soort: 'aanpassing', sale_deal_id: S }, { dealsVanKlant: deals, customerId: K }).ok, false);
  assert.deepEqual(valideerSoort({ soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: S }, { eigenDealId: G, dealsVanKlant: deals, customerId: K }).waarde,
    { soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: S });
  assert.equal(valideerSoort({ soort: 'incasso_regeling', sale_deal_id: 'vreemd' }, { dealsVanKlant: deals, customerId: K }).ok, false);
  assert.equal(valideerSoort({ soort: 'incasso_regeling', sale_deal_id: G }, { eigenDealId: U, dealsVanKlant: deals, customerId: K }).ok, false, 'ghost is geen sale');
  assert.equal(valideerSoort({ soort: 'origineel' }, { eigenDealId: S, dealsVanKlant: deals, customerId: K }).waarde.sale_deal_id, S);
  assert.equal(valideerSoort({ soort: 'nieuwe_offerte', sale_deal_id: S }, { eigenDealId: 'nieuw', dealsVanKlant: deals }).waarde.sale_deal_id, 'nieuw');
});

test('stelSoortVoor: zeker bij één sale ≤ 92 d of uitstel; anders melden, niet gokken', () => {
  const deals = [getekend(S, '2026-02-12'), ghost(G, '2026-02-20'), ghost(U, '2026-08-20'), getekend(N, '2026-10-01')];
  assert.deepEqual(
    (({ soort, sale_deal_id, zeker }) => ({ soort, sale_deal_id, zeker }))(stelSoortVoor({ deal_id: G, start_date: '2026-03-01' }, { deals })),
    { soort: 'origineel', sale_deal_id: S, zeker: true });
  const laat = stelSoortVoor({ deal_id: U, start_date: '2026-09-01' }, { deals: deals.filter((d) => d.id !== N) });
  assert.equal(laat.zeker, false);
  assert.match(laat.reden, /92 dagen/);
  const uitstel = stelSoortVoor({ deal_id: U, start_date: '2026-09-01', postponed_months: 6 }, { deals: deals.filter((d) => d.id !== N) });
  assert.equal(uitstel.soort, 'aanpassing');
  assert.equal(uitstel.zeker, true);
  assert.equal(stelSoortVoor({ deal_id: N, start_date: '2026-10-15' }, { deals }).soort, 'nieuwe_offerte');
  assert.equal(stelSoortVoor({ deal_id: U, start_date: '2026-11-01' }, { deals }).zeker, false, 'twee getekende sales vóór de start');
  assert.equal(saleVanSoort({ soort: null }), undefined);
});
