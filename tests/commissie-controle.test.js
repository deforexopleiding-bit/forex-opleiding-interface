// tests/commissie-controle.test.js
//
// PR 5 — controlescherm (alleen lezen):
//   * "zou moeten zijn" = factuurmotor (commissie × betaald / basis) per sale;
//   * te veel vrijgegeven (trajectgeval) en achterlopend grootboek;
//   * event-sale zonder commissie wordt gevonden;
//   * niet omgezet traject wordt gemeld;
//   * rapportkant uit het overzicht (bron van het mentorrapport);
//   * schrijft NIETS.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async () => ({ ok: true }) } });
const { commissieControle, telRapportSale } = await import(url('api/_lib/commissie-controle.js'));

const K1 = '11111111-1111-4111-8111-111111111111'; // gewone sale, grootboek achter
const K2 = '22222222-2222-4222-8222-222222222222'; // omgezet traject, te veel vrijgegeven
const K3 = '33333333-3333-4333-8333-333333333333'; // sale zonder commissie
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const D3 = 'd3000000-0000-4000-8000-000000000003';
const EV = 'e0000000-0000-4000-8000-0000000000e1';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const T = 'c636d9fa-94b2-48c3-9390-7d3b078655ef';
const T2 = 'bade0c7f-a945-4c54-88f1-05f5b7c3835c';

function zet() {
  const getekend = (id, k) => ({ id, customer_id: k, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-03-01T10:00:00Z' });
  const f = (id, k, paid, extra = {}) => ({ id, customer_id: k, deal_id: null, tl_subscription_id: null, amount_total: 400, amount_paid: paid, credited_amount: 0,
    status: paid >= 400 ? 'paid' : 'open', due_date: '2026-06-01', paid_date: paid ? '2026-06-03' : null, created_at: '2026-06-01T00:00:00Z', invoice_number: id, ...extra });
  db.reset({
    customers: [{ id: K1, first_name: 'Een' }, { id: K2, first_name: 'Paul' }, { id: K3, first_name: 'Jimco' }],
    events: [{ id: EV, title: 'Masterclass', starts_at: '2026-03-01T09:00:00Z' }],
    event_mentors: [{ event_id: EV, team_member_id: 'tm', was_present: true }],
    team_members: [{ id: 'tm', user_id: A, name: 'Seppe' }],
    event_attendees: [{ id: 'att3', event_id: EV, customer_id: K3, deal_id: D3, first_name: 'Jimco', status: 'aangemeld', bonus_excluded: false, is_test: false }],
    deals: [getekend(D1, K1), getekend(D2, K2), getekend(D3, K3)],
    subscriptions: [],
    invoices: [f('i1', K1, 400), f('i2', K1, 400), f('p1', K2, 400), f('x3', K3, 400)],
    payments: [], mentor_sale_attributions: [], dunning_credited_debt: [], commissie_factuur_koppeling: [], mentor_commissie_incasso: [],
    mentor_payouts: [{ id: 'pay-jun', mentor_user_id: A, period_month: '2026-06-01', status: 'goedgekeurd', generated_at: '2026-06-02' }],
    mentor_payout_adjustments: [], app_settings: [], mentor_cash_trajects: [{ id: T2, client_label: 'Noorulhaq', status: 'paused', event_id: EV, bonus_total: 216, total_amount: 7200 }],
    mentor_ledger_entries: [
      { id: 'p1', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K1, basis: 4000, pct: 3, amount: 120, original_amount: null,
        status: 'pending', parent_entry_id: null, source_quote_id: D1, idempotency_key: `${EV}:bonus:att1:${A}`, attendee_id: 'att1', created_at: '2026-03-01' },
      { id: 'p2', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K2, basis: 4200, pct: 3, amount: 34.4, original_amount: 126,
        status: 'pending', parent_entry_id: null, source_quote_id: D2, idempotency_key: `cashtraject:${T}:sale:${A}`, created_at: '2026-11-03' },
      { id: 'k2a', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K2, amount: 45.8, status: 'vrijgegeven', parent_entry_id: 'p2',
        idempotency_key: `cashtraject:${T}:term:1:mentor:${A}`, payout_id: 'pay-jun', released_at: '2026-05-01T00:00:00Z' },
      { id: 'k2b', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K2, amount: 45.8, status: 'vrijgegeven', parent_entry_id: 'p2',
        idempotency_key: `cashtraject:${T}:term:2:mentor:${A}`, payout_id: null, released_at: '2026-10-01T00:00:00Z' },
      { id: 'oud', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: null, amount: 6, status: 'vrijgegeven', parent_entry_id: null,
        idempotency_key: `cashtraject:${T2}:term:1:mentor:${A}`, payout_id: 'pay-jun', released_at: '2026-05-01T00:00:00Z' },
    ],
  });
}

test('controle: zou moeten zijn, grootboek achter, te veel vrijgegeven, sale zonder commissie, traject niet omgezet', async () => {
  zet();
  const voor = JSON.stringify(db.tables);
  const c = await commissieControle(db.client);
  assert.equal(JSON.stringify(db.tables), voor, 'alleen lezen: niets geschreven');
  const per = Object.fromEntries(c.rijen.map((r) => [r.klant, r]));

  assert.equal(per.Een.betaald, 800);
  assert.equal(per.Een.zou_moeten_zijn, 24, '120 × 800 / 4000');
  assert.equal(per.Een.vrijgegeven, 0);
  assert.ok(per.Een.afwijkingen.includes('achter'));

  // Rekenregel 9 nov 2026: zou moeten zijn = wat het rapport uitkeert of zal
  // uitkeren. 45,80 zat al in het junirapport (bevroren); de factuur van juni
  // (open maand) geeft 126 × 400 / 4200 = 12, volledig verrekend met dat
  // voorschot → 0 nieuw. Grootboek open maanden: 45,80 (regel van oktober,
  // in geen rapport) tegenover 0 stukken → 45,80 te veel.
  assert.equal(per.Paul.zou_moeten_zijn, 45.8);
  assert.equal(per.Paul.vrijgegeven, 91.6);
  assert.equal(per.Paul.grootboek_open, 45.8);
  assert.equal(per.Paul.stukken_open, 0);
  assert.equal(per.Paul.verschil, 45.8);
  assert.equal(per.Paul.bevroren_verschil, 0, 'afgesloten maanden: grootboek = rapport');
  assert.ok(per.Paul.afwijkingen.includes('te_veel_vrijgegeven'));
  assert.ok(per.Paul.afwijkingen.includes('vrijgegeven_niet_in_rapport'), 'de termijn zonder rapport wordt apart gemeld');
  assert.equal(per.Paul.vrijgegeven_niet_in_rapport, 45.8);

  assert.deepEqual(per.Jimco.afwijkingen, ['geen_commissie']);
  assert.match(per.Jimco.uitleg, /aangemeld/);

  assert.ok(per.Noorulhaq.afwijkingen.includes('traject_niet_omgezet'));
  assert.equal(per.Noorulhaq.vrijgegeven, 6);
  assert.equal(per.Noorulhaq.werkelijk_uitbetaald, 6, 'rapport juni (goedgekeurd) = werkelijk uitbetaald');

  assert.ok(c.totalen.met_afwijking >= 4);
  assert.equal(typeof per.Een.rapport_vrijgegeven, 'number', 'rapportkant uit het overzicht');
});

test('controle: een geannuleerde sale (gearchiveerde offerte, zoals Jimco Schepens) is geen "sale zonder commissie"', async () => {
  zet();
  db.tables.deals.find((d) => d.id === D3).archived_at = '2026-10-29T16:08:50Z';
  const c = await commissieControle(db.client);
  assert.equal(c.rijen.find((r) => r.klant === 'Jimco'), undefined, 'annulatie: niet als afwijking getoond');
});

test('controle: de betaalmethode staat bij elke factuur van de sale (cashbetaling, 6 nov)', async () => {
  zet();
  db.tables.payments = [{ id: 'pay1', invoice_id: 'i1', amount: 400, payment_date: '2026-06-03', payment_method: 'cash', source: 'manual' }];
  const c = await commissieControle(db.client);
  const een = c.rijen.find((r) => r.klant === 'Een');
  const fs = Object.fromEntries(een.facturen.map((f) => [f.id, f.betaalmethode]));
  assert.equal(fs.i1, 'Contant');
  assert.equal(fs.i2, 'Teamleader', 'betaald zonder payments-rij = via Teamleader');
});

// 6 nov 2026 (Maxim): de trajectregels en de rapporten juni–september staan in
// de database op uitbetaald, maar het scherm meldde "waarvan status nog niet
// uitbetaald 141,80" en "Uitbetaald, status loopt achter".
test('controle: trajectregels op uitbetaald in een uitbetaald rapport → geen "status loopt achter"', async () => {
  zet();
  db.tables.mentor_payouts.find((p) => p.id === 'pay-jun').status = 'uitbetaald';
  const k = db.tables.mentor_ledger_entries.find((e) => e.id === 'k2a');
  k.status = 'uitbetaald';
  const c = await commissieControle(db.client);
  const paul = c.rijen.find((r) => r.klant === 'Paul');
  assert.equal(paul.werkelijk_uitbetaald, 45.8, 'de regel zat in een rapport: werkelijk uitbetaald');
  assert.equal(paul.verschil_status_werkelijkheid, 0, 'status klopt al: geen verschil');
  assert.ok(!paul.afwijkingen.includes('status_achter'));
});

test('controle: trajectregel nog op vrijgegeven in een goedgekeurd rapport t/m de grens → wél "status loopt achter"', async () => {
  zet();
  const c = await commissieControle(db.client);
  const paul = c.rijen.find((r) => r.klant === 'Paul');
  assert.equal(paul.verschil_status_werkelijkheid, 45.8);
  assert.ok(paul.afwijkingen.includes('status_achter'));
});

test('telRapportSale: reeds_status_uitbetaald telt als status uitbetaald, nooit meer dan reeds_in_rapport; oude vorm = oud gedrag', () => {
  const st = new Map();
  const a = telRapportSale(null, { vrijgegeven_rapport: 141.8, termijnen: [], verrekening: { reeds_in_rapport: 141.8, reeds_status_uitbetaald: 141.8 } }, 'u', st, '2026-09');
  assert.deepEqual([a.werkelijk, a.statusUit], [141.8, 141.8]);
  const b = telRapportSale(null, { termijnen: [], verrekening: { reeds_in_rapport: 50, reeds_status_uitbetaald: 80 } }, 'u', st, '2026-09');
  assert.equal(b.statusUit, 50);
  const c = telRapportSale(null, { termijnen: [], verrekening: { reeds_in_rapport: 50 } }, 'u', st, '2026-09');
  assert.deepEqual([c.werkelijk, c.statusUit], [50, 0]);
});
