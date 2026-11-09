// tests/incasso-termijnfacturen.test.js
//
// PR 4 mentorcommissie — incasso-termijnfacturen gaan niet naar de klant en
// niet naar het bureau:
//   * BEWIJS Noorulhaq (8 okt via auto:overdue in de pipeline): een vervallen
//     termijnfactuur van een klant met een incasso-regeling (of van een
//     abonnement van soort incasso_regeling) stroomt NIET meer in;
//   * dezelfde uitsluiting zit in aanmaanruns, bulk, bureau-auto en TL-autosend;
//   * de maandlijst: verwacht / ontvangen / achterstand per maand;
//   * betaling ontvangen → factuur betaald → de factuurmotor geeft vrij.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';
import { kiesAutoInstroom } from '../api/_lib/dunning-engine.js';
import { laadIncassoUitsluiting, filterIncassoTermijnfacturen, isIncassoTermijnfactuur } from '../api/_lib/incasso-termijnfacturen.js';
import { bouwMaandlijst, trajectFacturen } from '../api/_lib/incasso-maandlijst.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const NOOR = '39f28f41-2700-4282-94db-b62f8c28b7c9';
const ANDER = '22222222-2222-4222-8222-222222222222';

test('BEWIJS: vervallen incasso-termijnfactuur → geen auto:overdue in de wanbetalers-pipeline', async () => {
  const db = maakNepDb();
  db.reset({
    mentor_commissie_incasso: [{ id: 'm', customer_id: NOOR, deal_id: null, sinds: '2026-09-23', status: 'incasso_regeling', opgeheven_op: null }],
    subscriptions: [],
  });
  // Zoals op 8 okt: 2026/1910 (400, vervallen 08-10, geen deal/abonnement) + een gewone klant.
  const overdue = [{ customer_id: NOOR, tl_subscription_id: null }, { customer_id: ANDER, tl_subscription_id: null }];
  const open = [...overdue];

  const zonder = kiesAutoInstroom({ overdueRows: overdue, openRows: open });
  assert.deepEqual(zonder.toevoegen, [NOOR, ANDER], 'het oude gedrag: Noorulhaq zou instromen');

  const uitsl = await laadIncassoUitsluiting(db.client);
  const met = kiesAutoInstroom({
    overdueRows: filterIncassoTermijnfacturen(overdue, uitsl).over,
    openRows: filterIncassoTermijnfacturen(open, uitsl).over,
  });
  assert.deepEqual(met.toevoegen, [ANDER], 'Noorulhaq stroomt niet meer in; een gewone wanbetaler wel');
});

test('ook bij incasso (stilstand) en voor facturen van een incasso_regeling-abonnement', async () => {
  const db = maakNepDb();
  db.reset({
    mentor_commissie_incasso: [
      { id: 'a', customer_id: 'k-bij', deal_id: null, sinds: '2026-10-01', status: 'bij_incasso', opgeheven_op: null },
      { id: 'b', customer_id: 'k-af', deal_id: null, sinds: '2026-10-01', status: 'afgesloten', afgesloten_als: 'betaald', opgeheven_op: null },
      { id: 'c', customer_id: 'k-oud', deal_id: null, sinds: '2026-08-01', status: 'bij_incasso', opgeheven_op: '2026-09-01T00:00:00Z' },
    ],
    subscriptions: [{ id: 's', teamleader_subscription_id: 'tl-reg', soort: 'incasso_regeling' }, { id: 's2', teamleader_subscription_id: 'tl-gewoon', soort: 'origineel' }],
  });
  const u = await laadIncassoUitsluiting(db.client);
  assert.equal(isIncassoTermijnfactuur({ customer_id: 'k-bij' }, u), true, 'bij incasso: geen aanmaning');
  assert.equal(isIncassoTermijnfactuur({ customer_id: 'k-af' }, u), false, 'afgesloten: gewone flow');
  assert.equal(isIncassoTermijnfactuur({ customer_id: 'k-oud' }, u), false, 'opgeheven status telt niet');
  assert.equal(isIncassoTermijnfactuur({ customer_id: 'x', tl_subscription_id: 'tl-reg' }, u), true, 'factuur van een incasso_regeling-abonnement');
  assert.equal(isIncassoTermijnfactuur({ customer_id: 'x', tl_subscription_id: 'tl-gewoon' }, u), false);
});

test('uitsluiting zit in alle paden: aanmaanruns, bulk, bureau-auto, TL-autosend, betaalhook', () => {
  const engine = lees('api/_lib/dunning-engine.js');
  assert.match(engine, /async function fetchOpenInvoices[\s\S]*?laadIncassoUitsluiting[\s\S]*?filterIncassoTermijnfacturen/, 'aanmaanruns');
  assert.match(engine, /laadIncassoUitsluiting\(supabaseAdmin\);[\s\S]*?kiesAutoInstroom/, 'auto-instroom');
  assert.match(lees('api/cron-dunning-bulk-send.js'), /skip_reason : 'incasso_termijnfactuur'/, 'bulkaanmaning');
  assert.match(lees('api/_lib/incasso-auto.js'), /filterIncassoTermijnfacturen\(invRows/, 'geen bureaudossier');
  assert.match(lees('api/sales-subscription-create.js'), /soort === 'incasso_regeling' \? \{ action: 'book' \}/, 'TL boekt enkel, mailt niet');
  const hook = lees('api/_lib/register-payment-internal.js');
  assert.match(hook, /await releaseProportionalForPaidAmount\(\{ customerId: inv\.customer_id \}\)/, 'betaling → factuurmotor');
  assert.doesNotMatch(hook, /await releaseProportionalForPayment\(/, 'het oude per-betaling-pad is weg');
});

test('maandlijst: verwacht, ontvangen en lopende achterstand per maand', () => {
  const sub = { id: 's', teamleader_subscription_id: 'tl', amount: 100, vat_percentage: 0, term_count: 4, start_date: '2026-09-01', status: 'active' };
  const facturen = [
    { id: 'f1', customer_id: NOOR, tl_subscription_id: 'tl', invoice_number: 'R1', amount_total: 100, amount_paid: 100, credited_amount: 0, status: 'paid', due_date: '2026-09-01', paid_date: '2026-09-04' },
    { id: 'f2', customer_id: NOOR, tl_subscription_id: 'tl', invoice_number: 'R2', amount_total: 100, amount_paid: 40, credited_amount: 0, status: 'partially_paid', due_date: '2026-10-01', paid_date: null },
    { id: 'bureau', customer_id: NOOR, tl_subscription_id: 'tl', invoice_number: 'B', amount_total: 900, amount_paid: 0, credited_amount: 0, status: 'concept', due_date: '2026-10-01' },
  ];
  const traject = trajectFacturen({ facturen, subs: [sub], status: null });
  assert.equal(traject.length, 2, 'de bureaufactuur (concept) telt nooit');
  const betalingen = new Map([['f2', [{ amount: 40, payment_date: '2026-10-20' }]]]);
  const m = bouwMaandlijst({ facturen: traject, subs: [sub], betalingen, vandaag: '2026-11-03' });
  const per = Object.fromEntries(m.maanden.map((r) => [r.maand, r]));
  assert.equal(per['2026-09'].verwacht, 100); assert.equal(per['2026-09'].ontvangen, 100); assert.equal(per['2026-09'].achterstand, 0);
  assert.equal(per['2026-10'].verwacht, 100); assert.equal(per['2026-10'].ontvangen, 40); assert.equal(per['2026-10'].achterstand, 60);
  assert.equal(per['2026-11'].verwacht, 100, 'termijn zonder factuur: uit het abonnement');
  assert.equal(per['2026-11'].achterstand, 160, '1 nov vervallen en nog niets ontvangen');
  assert.equal(per['2026-12'].verwacht, 100);
  assert.equal(m.totaal.achterstand, 160);
  assert.equal(per['2026-10'].facturen.find((f) => f.id === 'f2').open, 60, 'knop "betaling ontvangen" op 60 open');
});

const dbMotor = maakNepDb();

test('regeling zonder abonnement: de facturen vanaf de regeling vormen het traject', () => {
  const facturen = [
    { id: 'oud', customer_id: NOOR, amount_total: 400, credited_amount: 400, status: 'credited', issue_date: '2026-06-01', due_date: '2026-06-08' },
    { id: 'r1', customer_id: NOOR, amount_total: 200, amount_paid: 0, credited_amount: 0, status: 'open', issue_date: '2026-11-01', due_date: '2026-11-15' },
  ];
  const t = trajectFacturen({ facturen, subs: [], status: { status: 'incasso_regeling', sinds: '2026-10-20' } });
  assert.deepEqual(t.map((f) => f.id), ['r1']);
});

test('betaling ontvangen op een termijnfactuur → de factuurmotor geeft de commissie vrij (regeling)', async () => {
  const db = dbMotor; // één database voor de motortests: het overzicht (dat de motor gebruikt) blijft gecachet
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
  const engine = await import(url('api/_lib/mentor-ledger-engine.js') + '?t=' + Date.now());
  const D = 'd1000000-0000-4000-8000-000000000001';
  db.reset({
    deals: [{ id: D, customer_id: NOOR, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-04-04T12:36:07Z' }],
    subscriptions: [{ id: 's', deal_id: D, teamleader_subscription_id: 'tl-reg', soort: 'incasso_regeling', sale_deal_id: D, start_date: '2026-11-01', status: 'active' }],
    invoices: [{ id: 'f', customer_id: NOOR, tl_subscription_id: 'tl-reg', amount_total: 300, amount_paid: 300, credited_amount: 0, status: 'paid', paid_date: '2026-11-03', due_date: '2026-11-01' }],
    payments: [], mentor_sale_attributions: [], dunning_credited_debt: [], commissie_factuur_koppeling: [],
    mentor_commissie_incasso: [{ id: 'm', customer_id: NOOR, deal_id: null, sinds: '2026-11-01', incasso_sinds: '2026-10-01', status: 'incasso_regeling', opgeheven_op: null }],
    mentor_ledger_entries: [{ id: 'p', mentor_user_id: 'u', event_id: 'ev', entry_type: 'bonus', customer_id: NOOR, basis: 7200, amount: 108,
      original_amount: 108, status: 'pending', parent_entry_id: null, source_quote_id: D, idempotency_key: 'ev:bonus:a:u', created_at: '2026-07-06T00:00:00Z' }],
  });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: NOOR });
  assert.equal(r.total_released, 4.5, '108 × 300 / 7200 — op wat effectief binnenkwam');
  mock.reset();
});

// ── Beslissing Maxim (3 nov): bureaufacturen zoals Shaliwal 2026/2136 blijven
// open; bij een regeling crediteert Maxim ze zelf. Een klant op bij_incasso
// krijgt daarvoor GEEN aanmaning en zo'n factuur geeft GEEN commissie.
const SHAL = '2404a8e2-9a9b-412c-ba59-ff3ec3c503fd';
const bureau = { id: 'b2136', customer_id: SHAL, deal_id: null, tl_subscription_id: null, invoice_number: '2026 / 2136',
  amount_total: 6760, amount_paid: 0, credited_amount: 0, status: 'open', issue_date: '2026-10-19', due_date: '2026-10-26', created_at: '2026-10-19T00:00:00Z' };

test('bij_incasso: de open bureaufactuur krijgt geen aanmaning (auto-instroom, runs, bulk, bureau-auto)', async () => {
  const db = maakNepDb();
  db.reset({ mentor_commissie_incasso: [{ id: 'm', customer_id: SHAL, deal_id: null, sinds: '2026-10-19', status: 'bij_incasso', opgeheven_op: null }], subscriptions: [] });
  const u = await laadIncassoUitsluiting(db.client);
  assert.equal(isIncassoTermijnfactuur(bureau, u), true);
  const rijen = [{ customer_id: SHAL, tl_subscription_id: null }];
  assert.deepEqual(kiesAutoInstroom({ overdueRows: filterIncassoTermijnfacturen(rijen, u).over, openRows: filterIncassoTermijnfacturen(rijen, u).over }).toevoegen, []);
  // Een al lopende aanmaanrun stopt met reden incasso_status — niet 'paid'.
  assert.match(lees('api/_lib/dunning-engine.js'), /uitsl\.klanten\.has\(run\.customer_id\)[\s\S]{0,400}completion_reason: 'incasso_status'/);
});

test('bij_incasso: ook als de bureaufactuur later op betaald komt, geeft ze geen commissie', async () => {
  const db = dbMotor; // één database voor de motortests: het overzicht (dat de motor gebruikt) blijft gecachet
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
  const engine = await import(url('api/_lib/mentor-ledger-engine.js') + '?b=' + Date.now());
  const D = 'ced18cac-6d96-4805-8bbe-55a3df9de30d';
  db.reset({
    deals: [{ id: D, customer_id: SHAL, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-04-08T17:34:37Z' }],
    subscriptions: [],
    invoices: [{ ...bureau, amount_paid: 6760, status: 'paid', paid_date: '2026-11-20' }],
    payments: [], mentor_sale_attributions: [], dunning_credited_debt: [], commissie_factuur_koppeling: [],
    mentor_commissie_incasso: [{ id: 'm', customer_id: SHAL, deal_id: null, sinds: '2026-10-19', status: 'bij_incasso', opgeheven_op: null }],
    mentor_ledger_entries: [{ id: 'p', mentor_user_id: 'u', event_id: 'ev', entry_type: 'bonus', customer_id: SHAL, basis: 7200, amount: 108,
      original_amount: 108, status: 'pending', parent_entry_id: null, source_quote_id: D, idempotency_key: 'ev:bonus:s:u', created_at: '2026-07-06T00:00:00Z' }],
  });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: SHAL });
  assert.equal(r.total_released, 0, 'betaling vanaf de incassodatum telt niet (stilstand)');
  // Met een regeling crediteert Maxim de bureaufactuur zelf → telt als 0 betaald.
  db.tables.mentor_commissie_incasso[0].opgeheven_op = '2026-12-01T00:00:00Z';
  db.tables.mentor_commissie_incasso.push({ id: 'm2', customer_id: SHAL, deal_id: null, sinds: '2026-12-01', incasso_sinds: '2026-10-19', status: 'incasso_regeling', opgeheven_op: null });
  db.tables.invoices[0] = { ...bureau, amount_paid: 0, credited_amount: 6760, status: 'credited' };
  const r2 = await engine.releaseProportionalForPaidAmount({ customerId: SHAL });
  assert.equal(r2.total_released, 0, 'gecrediteerde bureaufactuur geeft niets');
  mock.reset();
});
