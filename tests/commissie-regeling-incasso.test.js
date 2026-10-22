// tests/commissie-regeling-incasso.test.js
//
// Wanbetalers en de mentorcommissie (api/_lib/commissie-regeling.js + engine
// + bonus-overzicht + cockpit-acties):
//   - regeling na creditering: één sale (auto), twee sales (handmatig
//     koppelen), korting (commissie naar verhouding van wat betaald is);
//   - geen dubbele telling tussen klantbreed en koppeltabel;
//   - conceptfactuur telt nooit;
//   - incasso: vrijgave stopt vanaf de datum, al vrijgegeven blijft, opheffen
//     laat weer meetellen; projectie toont "incasso" en wat vervalt.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async () => ({ ok: true }) } });
const engine = await import(url('api/_lib/mentor-ledger-engine.js'));
const { computeBonusOverview } = await import(url('api/mentor-bonus-overview.js'));
const core = await import(url('api/_lib/commissie-core.js'));
const reg = await import(url('api/_lib/commissie-regeling.js'));

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001'; // event-sale
const D2 = 'd2000000-0000-4000-8000-000000000002'; // tweede sale (toewijzing)
const GHOST = 'd9000000-0000-4000-8000-000000000009';
const X = 'a0000000-0000-4000-8000-00000000000a';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const B = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const EV = 'e0000000-0000-4000-8000-0000000000e1';
const R1 = 'f0000000-0000-4000-8000-0000000000f1';
const R2 = 'f0000000-0000-4000-8000-0000000000f2';
const C1 = 'c0000000-0000-4000-8000-0000000000c1';

const fact = (id, extra) => ({ id, customer_id: K, deal_id: null, tl_subscription_id: null, amount_paid: 0, credited_amount: 0,
  status: 'open', paid_date: null, due_date: '2026-11-01', created_at: '2026-10-01T10:00:00Z', ...extra });

function zet({ facturen = [], tweeSales = false, incasso = [], koppeling = [], missing = [], payments = [], kids = [] } = {}) {
  db.reset({
    events: [{ id: EV, title: 'Event', starts_at: '2026-01-10T09:00:00Z' }],
    customers: [{ id: K, first_name: 'Jan', last_name: 'P' }],
    deals: [{ id: D1, customer_id: K, tl_quotation_status: 'accepted' }, { id: GHOST, customer_id: K, tl_quotation_status: 'no_quotation' },
      ...(tweeSales ? [{ id: D2, customer_id: K, tl_quotation_status: 'accepted' }] : [])],
    subscriptions: [{ id: 's', deal_id: GHOST, teamleader_subscription_id: 'tl', amount: 1000, vat_percentage: 0, term_count: 3,
      billing_cycle: 'per_month', start_date: '2026-08-01', status: 'cancelled' }],
    invoices: [
      fact(C1, { tl_subscription_id: 'tl', amount_total: 1000, credited_amount: 1000, status: 'credited', due_date: '2026-08-08', created_at: '2026-08-01T00:00:00Z' }),
      ...facturen,
    ],
    payments,
    dunning_credited_debt: [{ customer_id: K, invoice_id: C1, amount_incl: 1000, credited_on: '2026-09-29' }],
    mentor_sale_attributions: tweeSales ? [{ id: X, deal_id: D2, customer_id: K, reden: 'verlenging', status: 'actief' }] : [],
    mentor_commissie_incasso: incasso,
    commissie_factuur_koppeling: koppeling,
    mentor_payouts: [], mentor_payout_adjustments: [],
    mentor_ledger_entries: [
      { id: 'p-ev', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 3000, pct: 3, amount: 90,
        original_amount: null, status: 'pending', parent_entry_id: null, source_quote_id: D1, idempotency_key: `${EV}:bonus:a:${A}`, created_at: '2026-01-10T00:00:00Z' },
      ...(tweeSales ? [{ id: 'p-attr', mentor_user_id: B, event_id: null, attribution_id: X, entry_type: 'bonus', customer_id: K, basis: 1000, pct: 3, amount: 30,
        original_amount: null, status: 'pending', parent_entry_id: null, source_quote_id: D2, idempotency_key: `attr:${X}:${B}`, created_at: '2026-09-01T00:00:00Z' }] : []),
      ...kids,
    ],
  }, missing);
}
const kids = (pid) => db.rows('mentor_ledger_entries').filter((e) => e.parent_entry_id === pid);
const som = (rows) => Math.round(rows.reduce((t, r) => t + Number(r.amount), 0) * 100) / 100;

/* ── Pure helpers ─────────────────────────────────────────────────────── */
test('koppelregel: één sale → auto, twee sales → onbekend, handmatig wint, concept nooit', () => {
  const ctx = { krediet: new Map([[K, { eerste: '2026-09-29', invoiceIds: new Set([C1]) }]]), handmatig: new Map(), incasso: [] };
  const inv = fact(R1, { amount_total: 2000 });
  assert.deepEqual(reg.koppelDeal(inv, ctx, new Map([[K, new Set([D1])]])), { deal: D1, bron: 'auto' });
  assert.deepEqual(reg.koppelDeal(inv, ctx, new Map([[K, new Set([D1, D2])]])), { onbekend: true });
  ctx.handmatig.set(R1, { deal_id: D2 });
  assert.deepEqual(reg.koppelDeal(inv, ctx, new Map([[K, new Set([D1, D2])]])), { deal: D2, bron: 'handmatig' });
  assert.equal(reg.koppelDeal({ ...inv, id: 'x', status: 'concept' }, ctx, new Map([[K, new Set([D1])]])), undefined);
  // Gewone factuur (met abonnement) of van vóór de creditering: geen koppelregel.
  assert.equal(reg.koppelDeal({ ...inv, id: 'y', tl_subscription_id: 'tl' }, ctx, new Map([[K, new Set([D1])]])), undefined);
  assert.equal(reg.koppelDeal({ ...inv, id: 'z', created_at: '2026-09-01T00:00:00Z' }, ctx, new Map([[K, new Set([D1])]])), undefined);
});

test('betaaldVoor: met en zonder betalingsregels', () => {
  const inv = { amount_total: 300, amount_paid: 300, credited_amount: 0, status: 'paid', paid_date: '2026-11-10' };
  assert.equal(reg.betaaldVoor(inv, [], '2026-11-01'), 0);
  assert.equal(reg.betaaldVoor(inv, [], '2026-12-01'), 300);
  assert.equal(reg.betaaldVoor(inv, [{ amount: 100, payment_date: '2026-10-20' }, { amount: 200, payment_date: '2026-11-10' }], '2026-11-01'), 100);
  assert.equal(reg.betaaldVoor({ ...inv, status: 'concept' }, [], null), 0);
});

/* ── Engine (vrijgave) ────────────────────────────────────────────────── */
test('regeling, één sale: betaalde regelingsfactuur geeft vrij (gecrediteerd telt niet)', async () => {
  zet({ facturen: [fact(R1, { amount_total: 1500, amount_paid: 1500, status: 'paid', paid_date: '2026-10-05' })] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-ev')), 45, '1500/3000 × 90');
});

test('korting: regeling lager dan de schuld → commissie naar verhouding van wat betaald is, nooit meer', async () => {
  // 1000 gecrediteerd, regeling van 600 volledig betaald → 600/3000 × 90 = 18.
  zet({ facturen: [fact(R1, { amount_total: 600, amount_paid: 600, status: 'paid', paid_date: '2026-10-05' })] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-ev')), 18);
  // Overbetaald (rente/kosten) → gecapt op de volle commissie.
  zet({ facturen: [fact(R1, { amount_total: 5000, amount_paid: 5000, status: 'paid', paid_date: '2026-10-05' })] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-ev')), 90);
});

test('twee sales: regelingsfactuur zonder keuze telt niet voor de toewijzing; gekoppeld → alleen daar, niet dubbel', async () => {
  const betaald = fact(R1, { amount_total: 500, amount_paid: 500, status: 'paid', paid_date: '2026-10-05' });
  zet({ tweeSales: true, facturen: [betaald] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(kids('p-attr').length, 0, 'toewijzing ziet een ongekoppelde factuur niet');
  assert.equal(som(kids('p-ev')), 15, 'oude klantbrede gedrag voor de event-sale blijft');

  zet({ tweeSales: true, facturen: [betaald], koppeling: [{ invoice_id: R1, customer_id: K, deal_id: D2, bron: 'handmatig' }] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-attr')), 15, '500/1000 × 30');
  assert.equal(kids('p-ev').length, 0, 'gekoppeld aan de andere sale → niet klantbreed voor de event-sale');
});

test('bewust "geen sale" gekoppeld → telt nergens', async () => {
  zet({ facturen: [fact(R1, { amount_total: 500, amount_paid: 500, status: 'paid', paid_date: '2026-10-05' })],
    koppeling: [{ invoice_id: R1, customer_id: K, deal_id: null, bron: 'handmatig' }] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(kids('p-ev').length, 0);
});

test('conceptfactuur telt nooit als betaald', async () => {
  zet({ facturen: [fact(R1, { amount_total: 3000, amount_paid: 3000, status: 'concept', paid_date: '2026-10-05' })] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(kids('p-ev').length, 0);
});

test('incasso: alleen betalingen vóór de datum tellen; al vrijgegeven blijft; opheffen telt weer mee', async () => {
  const facturen = [
    fact(R1, { amount_total: 1000, amount_paid: 1000, status: 'paid', paid_date: '2026-10-05', due_date: '2026-10-01' }),
    fact(R2, { amount_total: 1000, amount_paid: 1000, status: 'paid', paid_date: '2026-11-20', due_date: '2026-11-01' }),
  ];
  const al = [{ id: 'kid-oud', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, amount: 30, status: 'uitbetaald',
    parent_entry_id: 'p-ev', idempotency_key: 'p-ev:paidamount:100000' }];
  const mark = { id: 'm1', customer_id: K, deal_id: null, sinds: '2026-11-01', reden: 'bureau', opgeheven_op: null };
  zet({ facturen, incasso: [mark], kids: al });
  db.tables.mentor_ledger_entries[0].amount = 60; // 30 al uitbetaald
  db.tables.mentor_ledger_entries[0].original_amount = 90;
  const r = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(r.simulations[0].totaal_betaald, 1000, 'betaling van 20 nov telt niet');
  assert.equal(r.released_children, 0, 'doel 30 = al vrijgegeven');
  assert.equal(som(kids('p-ev')), 30, 'al uitbetaald blijft staan');
  // Opheffen → de november-betaling telt weer mee.
  db.tables.mentor_commissie_incasso[0].opgeheven_op = '2026-11-25T00:00:00Z';
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-ev')), 60);
});

test('incasso per sale raakt de andere sale van de klant niet', async () => {
  zet({ tweeSales: true, facturen: [fact(R1, { amount_total: 500, amount_paid: 500, status: 'paid', paid_date: '2026-10-05' })],
    koppeling: [{ invoice_id: R1, customer_id: K, deal_id: D2, bron: 'handmatig' }],
    incasso: [{ id: 'm1', customer_id: K, deal_id: D1, sinds: '2026-01-01', reden: 'x', opgeheven_op: null }] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-attr')), 15);
});

test('zonder migratie (tabellen ontbreken): automatische koppeling werkt, geen fout', async () => {
  zet({ facturen: [fact(R1, { amount_total: 1500, amount_paid: 1500, status: 'paid', paid_date: '2026-10-05' })],
    missing: ['mentor_commissie_incasso', 'commissie_factuur_koppeling'] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-ev')), 45);
});

/* ── Overzicht (projectie) ────────────────────────────────────────────── */
test('overzicht: gecrediteerd → vervangen, regelingsfactuur als eigen termijn met eigen bedrag', async () => {
  zet({ facturen: [fact(R1, { amount_total: 2000, due_date: '2027-01-15' })] });
  const out = await computeBonusOverview(A);
  const sale = out.per_event[0].sales[0];
  const t = sale.termijnen;
  assert.equal(t[0].status, 'gecrediteerd');
  assert.equal(t[0].vervangen, true);
  assert.equal(t[0].amount, 0);
  assert.equal(t[1].due_date, '2027-01-15');
  assert.equal(t[1].amount, 60, '2000/3000 × 90');
  assert.equal(sale.regeling.niet_gedekt, 30);
  assert.notEqual(sale.status, 'geannuleerd', 'regeling loopt, ook al is het abonnement stopgezet');
  const jan = out.projection_12m.find((m) => m.month === '2027-01');
  if (jan) assert.equal(jan.expected, 60);
});

test('overzicht: conceptfactuur verschijnt nergens (geen termijn, geen achterstand)', async () => {
  zet({ facturen: [fact(R1, { amount_total: 3000, status: 'concept', due_date: '2026-09-17' })] });
  const out = await computeBonusOverview(A);
  const sale = out.per_event[0].sales[0];
  assert.equal(sale.has_overdue, false);
  assert.ok(!sale.termijnen.some((t) => t.due_date === '2026-09-17'));
});

test('overzicht: incasso → termijnen na de datum vervallen, uit projectie en KPI', async () => {
  zet({ facturen: [
      fact(R1, { amount_total: 1000, amount_paid: 1000, status: 'paid', paid_date: '2026-10-05', due_date: '2026-10-01' }),
      fact(R2, { amount_total: 2000, due_date: '2027-02-01' }),
    ],
    incasso: [{ id: 'm1', customer_id: K, deal_id: null, sinds: '2026-11-01', reden: 'bureau', opgeheven_op: null }] });
  const out = await computeBonusOverview(A);
  const sale = out.per_event[0].sales[0];
  assert.equal(sale.status, 'incasso');
  assert.deepEqual(sale.incasso, { sinds: '2026-11-01', vervallen: 60 });
  assert.equal(sale.termijnen.find((t) => t.due_date === '2027-02-01').status, 'incasso');
  assert.equal(sale.termijnen.find((t) => t.due_date === '2026-10-01').status, 'betaald');
  const feb = out.projection_12m.find((m) => m.month === '2027-02');
  if (feb) assert.equal(feb.expected, 0);
  assert.equal(out.totals.earned_total, 30, '90 − 60 vervallen');
  assert.equal(out.totals.cf_expected, 0, 'openstaand deel komt niet meer');
});

/* ── Cockpit-acties ───────────────────────────────────────────────────── */
test('incasso markeren / dubbel / opheffen; zonder migratie 503', async () => {
  zet();
  const r = await core.incassoActie({ actie: 'markeren', customer_id: K, sinds: '2026-11-01', reden: 'naar bureau' }, { actorId: A });
  assert.equal(r.ok, true);
  await assert.rejects(core.incassoActie({ actie: 'markeren', customer_id: K, sinds: '2026-11-01', reden: 'nog eens' }, { actorId: A }),
    (e) => e.code === 'AL_GEMARKEERD' || e.status === 409 || /23505|duplicate/.test(e.message));
  const o = await core.incassoActie({ actie: 'opheffen', id: r.id }, { actorId: A });
  assert.equal(o.ok, true);
  assert.ok(db.rows('mentor_commissie_incasso')[0].opgeheven_op);
  await assert.rejects(core.incassoActie({ actie: 'markeren', customer_id: K, deal_id: D2, sinds: '2026-11-01', reden: 'xx x' }, {}), (e) => e.code === 'DEAL_ONBEKEND');
  zet({ missing: ['mentor_commissie_incasso'] });
  await assert.rejects(core.incassoActie({ actie: 'markeren', customer_id: K, sinds: '2026-11-01', reden: 'naar bureau' }, {}), (e) => e.code === 'MIGRATIE_ONTBREEKT');
});

test('factuur koppelen: alleen sales met commissie, concept geweigerd, wissen kan', async () => {
  zet({ tweeSales: true, facturen: [fact(R1, { amount_total: 500 }), fact(R2, { amount_total: 500, status: 'concept' })] });
  await assert.rejects(core.factuurKoppelen({ invoice_id: R1, deal_id: GHOST }, {}), (e) => e.code === 'DEAL_ONBEKEND');
  await assert.rejects(core.factuurKoppelen({ invoice_id: R2, deal_id: D1 }, {}), (e) => e.code === 'CONCEPT');
  await core.factuurKoppelen({ invoice_id: R1, deal_id: D2 }, { actorId: A });
  assert.equal(db.rows('commissie_factuur_koppeling')[0].deal_id, D2);
  await core.factuurKoppelen({ invoice_id: R1, deal_id: D1 }, { actorId: A });
  assert.equal(db.rows('commissie_factuur_koppeling').length, 1, 'vervangt, geen tweede rij');
  await core.factuurKoppelen({ invoice_id: R1, actie: 'wissen' }, {});
  assert.equal(db.rows('commissie_factuur_koppeling').length, 0);
});

test('cockpitlijsten: niet-gekoppelde regelingsfactuur en "Mogelijk incasso"', async () => {
  zet({ tweeSales: true, facturen: [fact(R1, { amount_total: 500 })] });
  db.tables.dunning_incasso_dossiers = [{ customer_id: K, status: 'aangemeld', opened_at: '2026-10-10T08:00:00Z' }];
  db.tables.dunning_pipeline_customers = [];
  db.tables.onboardings = [];
  const regels = db.rows('mentor_ledger_entries');
  const l = await core.wanbetalingLijsten({ regels, sales: [] });
  assert.equal(l.niet_gekoppeld.length, 1);
  assert.equal(l.niet_gekoppeld[0].invoice_id, R1);
  assert.equal(l.niet_gekoppeld[0].opties.length, 2);
  assert.equal(l.mogelijk_incasso.length, 1);
  assert.equal(l.mogelijk_incasso[0].voorstel_sinds, '2026-10-10');
  // Na markeren verdwijnt de klant uit "Mogelijk incasso".
  db.tables.mentor_commissie_incasso = [{ id: 'm1', customer_id: K, deal_id: null, sinds: '2026-10-10', reden: 'x', bron: 'voorstel', opgeheven_op: null }];
  const l2 = await core.wanbetalingLijsten({ regels, sales: [] });
  assert.equal(l2.mogelijk_incasso.length, 0);
  assert.equal(l2.incasso_markeringen.length, 1);
});
