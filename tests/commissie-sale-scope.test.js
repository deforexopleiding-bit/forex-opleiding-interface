// tests/commissie-sale-scope.test.js
//
// Drie inconsistenties (22 okt):
//   1. "vrijgegeven" = wat in het rapport komt (betaalde termijnen), niet het
//      grootboek — cockpit, zijpaneel en mentorzicht tonen één getal;
//   2. welke factuur bij welke SALE hoort is één regel (factuurVanSale) voor
//      engine, overzicht én wizard: facturen zonder deal_id/tl_subscription_id
//      (klant met één getekende deal) en TL-abonnementen op een ghost-deal;
//   3. de preview van "Sale toewijzen" plaatst termijnen in de maand van
//      betaling (PR5): betaald → betaalmaand, onbetaald + vervallen →
//      huidige maand (achterstallig).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';
import { maakSaleScope, factuurVanSale } from '../api/_lib/commissie-toewijzing.js';
import { maakAfsluiting } from '../api/_lib/commissie-maand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async () => ({ ok: true }) } });
const core = await import(url('api/_lib/commissie-core.js'));
const engine = await import(url('api/_lib/mentor-ledger-engine.js'));
const { computeBonusOverview } = await import(url('api/mentor-bonus-overview.js'));

const K = '11111111-1111-4111-8111-111111111111';
const S = '5a000000-0000-4000-8000-000000000001';   // getekende sale
const G = '6b000000-0000-4000-8000-000000000002';   // ghost-deal (TL-import)
const E = '7c000000-0000-4000-8000-000000000003';   // oudere getekende event-sale
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const X = 'a0000000-0000-4000-8000-00000000000a';
const EV = 'e0000000-0000-4000-8000-0000000000e1';

const getekend = (id, op) => ({ id, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: op + 'T10:00:00Z', created_at: op + 'T09:00:00Z' });
const ghost = (id, op) => ({ id, customer_id: K, tl_quotation_status: 'no_quotation', source: 'tl_import', created_at: op + 'T09:00:00Z' });

/* ── 2. De regel zelf ───────────────────────────────────────────────────── */
test('ghost-abonnement kort na de getekende sale hoort bij die sale; een latere verlenging niet', () => {
  const deals = [getekend(S, '2026-08-05'), ghost(G, '2026-08-27'), ghost('g-later', '2027-02-20')];
  const subs = [
    { id: 'sc', deal_id: S, teamleader_subscription_id: 'tl-s', start_date: '2026-09-01', status: 'cancelled' },
    { id: 'sg', deal_id: G, teamleader_subscription_id: 'tl-g', start_date: '2026-09-01', status: 'active' },
    { id: 'sl', deal_id: 'g-later', teamleader_subscription_id: 'tl-l', start_date: '2027-03-01', status: 'active' },
  ];
  const sc = maakSaleScope({ deals, subs });
  assert.equal(sc.dealVanSub(subs[1]), S, 'start 27 dagen na tekenen → zelfde sale');
  assert.equal(sc.dealVanSub(subs[2]), null, 'start 7 maanden later → verlenging, geen sale');
  assert.deepEqual(sc.subsVan(S).map((s) => s.id).sort(), ['sc', 'sg']);
  assert.equal(factuurVanSale({ customer_id: K, tl_subscription_id: 'tl-g' }, S, sc), true);
  assert.equal(factuurVanSale({ customer_id: K, deal_id: G }, S, sc), true);
  assert.equal(factuurVanSale({ customer_id: K, tl_subscription_id: 'tl-l' }, S, sc), false);
});

test('factuur zonder deal en zonder abonnement: alleen bij precies één getekende deal', () => {
  const inv = { customer_id: K, deal_id: null, tl_subscription_id: null };
  const een = maakSaleScope({ deals: [getekend(S, '2026-08-26')], subs: [] });
  assert.equal(factuurVanSale(inv, S, een), true);
  const twee = maakSaleScope({ deals: [getekend(S, '2026-08-26'), getekend(E, '2025-01-05')], subs: [] });
  assert.equal(factuurVanSale(inv, S, twee), false, 'twee sales → niet raden');
  assert.equal(factuurVanSale({ ...inv, deal_id: E, _k: { deal: S, bron: 'handmatig' } }, S, twee), true, 'handmatige koppeling wint');
});

/* ── Engine: toegewezen sale met ongekoppelde facturen (Miguel Claeys) ──── */
function mc({ eventOpE = false } = {}) {
  db.reset({
    customers: [{ id: K, first_name: 'Miguel', last_name: 'C' }],
    deals: [getekend(S, '2026-08-26'), ...(eventOpE ? [getekend(E, '2025-01-05')] : [])],
    deal_line_items: [{ deal_id: S, quantity: 1, unit_price: 2160, vat_percentage: 21, price_includes_vat: true }],
    subscriptions: [{ id: 'sm', deal_id: S, teamleader_subscription_id: 'tl-m', amount: 60, vat_percentage: 0, term_count: 36,
      billing_cycle: 'per_month', start_date: '2026-08-28', status: 'active' }],
    invoices: [
      { id: 'm1', customer_id: K, deal_id: null, tl_subscription_id: null, amount_total: 60, amount_paid: 60, credited_amount: 0, status: 'paid', due_date: '2026-08-28', paid_date: '2026-08-29', created_at: '2026-08-28T00:00:00Z' },
      { id: 'm2', customer_id: K, deal_id: null, tl_subscription_id: null, amount_total: 60, amount_paid: 60, credited_amount: 0, status: 'paid', due_date: '2026-09-28', paid_date: '2026-09-28', created_at: '2026-09-28T00:00:00Z' },
    ],
    team_members: [{ id: 'tm-a', name: 'Anna', user_id: A, is_active: true }],
    profiles: [],
    events: [],
    mentor_sale_attributions: [],
    mentor_ledger_entries: [],
  });
}

test('engine: toegewezen sale geeft vrij op facturen zonder deal/abonnement (één getekende deal)', async () => {
  mc();
  db.rows('mentor_sale_attributions').push({ id: X, deal_id: S, customer_id: K, reden: 'verlenging', pct: 3, basis: 2160, status: 'actief' });
  db.rows('mentor_ledger_entries').push({ id: 'p', mentor_user_id: A, event_id: null, attribution_id: X, entry_type: 'bonus', customer_id: K,
    basis: 2160, amount: 64.8, status: 'pending', parent_entry_id: null, source_quote_id: S, idempotency_key: `attr:${X}:${A}`, created_at: '2026-10-22T00:00:00Z' });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  const som = db.rows('mentor_ledger_entries').filter((e) => e.parent_entry_id === 'p').reduce((s, e) => s + Number(e.amount), 0);
  assert.equal(Math.round(som * 100) / 100, 3.6, '120/2160 × 64,80');
});

/* ── Wizard: zoeken + preview zien dezelfde facturen (punt 2 + 3) ───────── */
test('zoeken + preview: betaald € 120 en 2 betaalde termijnen, niet € 0', async () => {
  mc();
  const z = await core.zoekOffertes({ q: S });
  assert.equal(z.resultaten[0].betaald, 120);
  const p = await core.previewToewijzing({ deal_id: S, mentor_user_ids: [A], pct: 3 });
  assert.equal(p.betaald_op_deal, 120);
  assert.equal(p.betaalde_termijnen, 2);
  assert.equal(p.valt_meteen_vrij_per_mentor, 3.6, '2 × 1,80');
  assert.equal(p.termijnen.filter((t) => t.status === 'betaald').length, 2);
  assert.equal(db.rows('mentor_ledger_entries').length, 0, 'preview schrijft niets');
});

test('termijnSchema: maand van betaling — betaald later, achterstallig naar huidige maand', () => {
  const subs = [{ id: 's', teamleader_subscription_id: 'tl', amount: 100, vat_percentage: 0, term_count: 4, billing_cycle: 'per_month', start_date: '2026-08-05', status: 'active' }];
  const facturen = [
    { id: 'a', tl_subscription_id: null, amount_total: 100, amount_paid: 100, credited_amount: 0, status: 'paid', due_date: '2026-08-05', paid_date: '2026-09-12' },
    { id: 'b', tl_subscription_id: 'tl', amount_total: 100, amount_paid: 0, credited_amount: 0, status: 'open', due_date: '2026-09-05' },
  ];
  const t = core.termijnSchema({ subs, facturen, basis: 400, aandeel: 12, vandaagIso: '2026-10-22', afsluiting: maakAfsluiting([]) });
  assert.deepEqual(t.map((x) => [x.status, x.maand]), [
    ['betaald', '2026-09'],         // vervalt aug, betaald sep → sep
    ['achterstallig', '2026-10'],   // vervalt sep, onbetaald → huidige maand
    ['achterstallig', '2026-10'],   // vervalt 5 okt (geen factuur), onbetaald
    ['open', '2026-11'],
  ]);
  const pm = core.perMaand(t);
  assert.deepEqual(pm.map((m) => m.month), ['2026-09', '2026-10', '2026-11'], 'geen "verwacht" meer in augustus');
  assert.equal(pm[1].verwacht, 6);
  assert.equal(pm[1].achterstallig, 6);
});

test('termijnSchema: betaald in een al afgesloten maand → inhaal, in geen enkele maand', () => {
  const subs = [{ id: 's', teamleader_subscription_id: 'tl', amount: 100, vat_percentage: 0, term_count: 1, billing_cycle: 'per_month', start_date: '2026-07-05', status: 'active' }];
  const facturen = [{ id: 'a', tl_subscription_id: 'tl', amount_total: 100, amount_paid: 100, credited_amount: 0, status: 'paid', due_date: '2026-07-05', paid_date: '2026-08-12' }];
  const afs = maakAfsluiting([{ period_month: '2026-09-01', status: 'goedgekeurd', generated_at: '2026-09-02T06:00:00Z' }]);
  const t = core.termijnSchema({ subs, facturen, basis: 100, aandeel: 3, vandaagIso: '2026-10-22', afsluiting: afs });
  assert.equal(t[0].inhaal, true);
  assert.deepEqual(core.perMaand(t), []);
});

/* ── Event-bonus ziet het ghost-abonnement van een toegewezen sale niet ─── */
test('engine: ghost-abonnement van de toegewezen sale telt niet voor de oude event-bonus', async () => {
  db.reset({
    deals: [getekend(E, '2025-01-05'), getekend(S, '2026-08-05'), ghost(G, '2026-08-27')],
    subscriptions: [
      { id: 'se', deal_id: E, teamleader_subscription_id: 'tl-e', start_date: '2025-01-10' },
      { id: 'sg', deal_id: G, teamleader_subscription_id: 'tl-g', start_date: '2026-09-01' },
    ],
    invoices: [
      { id: 'e1', customer_id: K, deal_id: E, tl_subscription_id: 'tl-e', amount_total: 1000, amount_paid: 500, credited_amount: 0, status: 'partially_paid', paid_date: '2025-02-01' },
      { id: 'g1', customer_id: K, deal_id: null, tl_subscription_id: 'tl-g', amount_total: 300, amount_paid: 300, credited_amount: 0, status: 'paid', paid_date: '2026-10-02' },
    ],
    mentor_sale_attributions: [{ id: X, deal_id: S, customer_id: K, reden: 'verlenging', pct: 3, basis: 900, status: 'actief' }],
    mentor_ledger_entries: [
      { id: 'p-ev', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 1000, amount: 30, status: 'pending', parent_entry_id: null, source_quote_id: E, idempotency_key: 'ev', created_at: '2025-01-10T00:00:00Z' },
      { id: 'p-at', mentor_user_id: A, event_id: null, attribution_id: X, entry_type: 'bonus', customer_id: K, basis: 900, amount: 27, status: 'pending', parent_entry_id: null, source_quote_id: S, idempotency_key: `attr:${X}:${A}`, created_at: '2026-10-01T00:00:00Z' },
    ],
  });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  const som = (id) => Math.round(db.rows('mentor_ledger_entries').filter((e) => e.parent_entry_id === id).reduce((s, e) => s + Number(e.amount), 0) * 100) / 100;
  assert.equal(som('p-at'), 9, '300/900 × 27');
  assert.equal(som('p-ev'), 15, 'alleen 500/1000 × 30, niet (500+300)/1000');
});

/* ── 1. Eén getal "vrijgegeven" = het rapport ───────────────────────────── */
test('overzicht: vrijgegeven_rapport = betaalde termijnen (zoals projection paid), ook zonder grootboek-children', async () => {
  const nu = new Date();
  const ym = (off) => { const d = new Date(Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth() + off, 1)); return d.toISOString().slice(0, 7); };
  db.reset({
    events: [{ id: EV, title: 'Event', starts_at: '2026-01-10T09:00:00Z' }],
    customers: [{ id: K, company_name: 'Chamano BV', is_company: true }],
    deals: [getekend(S, `${ym(-3)}-01`)],
    subscriptions: [{ id: 's', deal_id: S, teamleader_subscription_id: 'tl', amount: 100, vat_percentage: 0, term_count: 3, billing_cycle: 'per_month', start_date: `${ym(-3)}-05`, status: 'active' }],
    invoices: [-3, -2, -1].map((o, i) => ({ id: 'f' + i, customer_id: K, deal_id: null, tl_subscription_id: 'tl', amount_total: 100, amount_paid: 100, credited_amount: 0, status: 'paid', due_date: `${ym(o)}-05`, paid_date: `${ym(o)}-06` })),
    mentor_ledger_entries: [{ id: 'p', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 300, amount: 9, status: 'pending', parent_entry_id: null, source_quote_id: S, idempotency_key: 'k', created_at: '2026-01-10T00:00:00Z' }],
  });
  const out = await computeBonusOverview(A);
  const cel = out.per_event[0].sales[0];
  assert.equal(cel.released_share, 0, 'grootboek: nooit vrijgegeven (geen sync gedraaid)');
  assert.equal(cel.vrijgegeven_rapport, 9);
  const paid = out.projection_12m.reduce((s, m) => s + m.paid, 0);
  assert.equal(Math.round(paid * 100) / 100, cel.vrijgegeven_rapport, 'zelfde getal als het rapport');

  const ov = core.bouwOverzicht({ mentoren: [{ user_id: A, naam: 'Seppe' }], overzichten: new Map([[A, out]]) });
  const s = ov.sales[0];
  assert.equal(s.vrijgegeven, 9);
  assert.equal(s.vrijgegeven_grootboek, 0);
  assert.equal(s.status, 'volledig', 'niet meer "wacht op betaling"');
  assert.equal(s.mentoren[0].vrijgegeven, 9, 'zijpaneel per mentor');
});
