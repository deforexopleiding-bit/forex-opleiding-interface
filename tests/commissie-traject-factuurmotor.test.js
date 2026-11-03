// tests/commissie-traject-factuurmotor.test.js
//
// PR 1 mentorcommissie — handmatige trajecten naar de factuurmotor.
//   * de cron/knop schrijft NOOIT meer een termijn op datum (ook niet voor een
//     actief traject waarvan de vrijvaldatum al lang voorbij is);
//   * omzetten = parents per aanwezige mentor met de oorspronkelijke
//     commissie; bestaande vrijgegeven termijnregels worden children
//     (bedrag/status/payout_id onaangeroerd);
//   * daarna geeft de factuurmotor NIETS vrij zolang betaald × % < vrijgegeven
//     (verrekening), en precies het verschil zodra de betalingen het inhalen;
//     nooit dubbel;
//   * dry-run: vrijgegeven vs werkelijk uitbetaald (rapporten jun–sep staan
//     nog op goedgekeurd maar zijn betaald) — gemeten cijfers van 3 nov.
// Echte engine, nep-database.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client } });
const core = await import(url('api/_lib/mentor-cash-release-core.js'));
const omz = await import(url('api/_lib/cash-traject-omzetten.js'));
const engine = await import(url('api/_lib/mentor-ledger-engine.js'));
const uitb = await import(url('api/_lib/commissie-uitbetaald.js'));

// Shaliwal-achtig traject: 2 mentoren, 7 termijnen × € 6 vrijgegeven elk.
const T = '2c4f9308-59f8-48c3-b8a3-7157ad151d29';
const EV = '9dd5d3f7-ec7d-4cf5-93a6-58959edff704';
const K = '2404a8e2-9a9b-412c-ba59-ff3ec3c503fd';
const D = 'ced18cac-6d96-4805-8bbe-55a3df9de30d';
const SEPPE = '162994ff-a21d-446f-bf0b-eea8e7978967';
const DANNY = '1aa012d4-81df-4510-81dd-38af6ef2888e';
const PAY = { 1: 'p-jun', 2: 'p-jul', 3: 'p-aug', 4: 'p-sep' }; // termijn → rapport

function regels() {
  const out = [];
  for (const uid of [SEPPE, DANNY]) {
    for (let n = 1; n <= 7; n++) {
      out.push({
        id: `r-${uid.slice(0, 4)}-${n}`, mentor_user_id: uid, event_id: EV, entry_type: 'bonus',
        customer_id: null, amount: 6, status: 'vrijgegeven', parent_entry_id: null,
        released_at: `2026-${String(4 + n).padStart(2, '0')}-01T00:00:00+00:00`,
        payout_id: PAY[n] ? `${PAY[n]}-${uid.slice(0, 4)}` : null,
        idempotency_key: `cashtraject:${T}:term:${n}:mentor:${uid}`,
      });
    }
  }
  return out;
}
function payouts() {
  const out = [];
  for (const uid of [SEPPE, DANNY]) {
    ['06', '07', '08', '09'].forEach((m, i) => out.push({ id: `${PAY[i + 1]}-${uid.slice(0, 4)}`, mentor_user_id: uid, period_month: `2026-${m}-01`, status: 'goedgekeurd' }));
  }
  return out;
}
const factuur = (id, paid, extra = {}) => ({ id, customer_id: K, deal_id: '3e44cb25-ghost', tl_subscription_id: '759bbb4b',
  amount_total: 400, amount_paid: paid, credited_amount: 0, status: paid >= 400 ? 'paid' : 'open', paid_date: '2026-05-16', due_date: '2026-05-08', ...extra });

function basis({ status = 'paused', facturen = [factuur('i-835', 440, { amount_total: 400 })] } = {}) {
  db.reset({
    mentor_cash_trajects: [{ id: T, event_id: EV, customer_id: null, client_label: 'Mohammad Shoaib Shaliwal',
      total_amount: 7200, term_count: 18, pct: 3, bonus_total: 216, start_month: '2026-05-01', release_day: 1, status }],
    event_mentors: [
      { event_id: EV, team_member_id: 'tm-seppe', was_present: true, team_members: { id: 'tm-seppe', user_id: SEPPE } },
      { event_id: EV, team_member_id: 'tm-danny', was_present: true, team_members: { id: 'tm-danny', user_id: DANNY } },
    ],
    deals: [{ id: D, customer_id: K, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-04-08T17:34:37Z' },
      { id: '3e44cb25-ghost', customer_id: K, tl_quotation_status: 'no_quotation', created_at: '2026-07-02T00:00:00Z' }],
    subscriptions: [{ id: 's1', deal_id: '3e44cb25-ghost', teamleader_subscription_id: '759bbb4b', term_count: 18, start_date: '2026-05-01', status: 'cancelled' }],
    invoices: facturen,
    payments: [],
    mentor_payouts: payouts(),
    mentor_ledger_entries: regels(),
    app_settings: [],
  });
}
const L = () => db.rows('mentor_ledger_entries');
const inserts = () => db.log.filter((l) => l.op === 'insert' && l.tabel === 'mentor_ledger_entries').flatMap((l) => l.rows);

test('cron: een actief, niet omgezet traject krijgt NOOIT een termijn op datum', async () => {
  basis({ status: 'active' });
  const s = await core.releaseCashTrajectTerms({});
  assert.equal(inserts().length, 0, 'geen enkele grootboekregel geschreven');
  assert.equal(s.skipped_zonder_factuurcheck, 1);
  assert.match(s.warnings.join(' '), /geen vrijgave zonder factuurcheck/);
});

test('cron: een gepauzeerd traject blijft stil (geen schrijfacties, geen waarschuwing)', async () => {
  basis({ status: 'paused' });
  const s = await core.releaseCashTrajectTerms({});
  assert.equal(inserts().length, 0);
  assert.equal(s.warnings.length, 0);
});

test('omzetten zonder klant of sale: geweigerd, niets geschreven', async () => {
  basis();
  const r = await omz.omzetTraject({ trajectId: T, dryRun: false });
  assert.equal(r.ok, false);
  assert.match(r.reden, /klant ontbreekt/);
  assert.equal(inserts().length, 0);
});

test('dry-run: oorspronkelijke commissie, doel op betaalde facturen, vrijgegeven vs werkelijk uitbetaald', async () => {
  basis();
  const r = await omz.omzetTraject({ trajectId: T, customerId: K, dealId: D, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(inserts().length, 0, 'dry-run schrijft niets');
  assert.equal(r.betaald_crm, 440, 'factuur 2026/835: 440 betaald op 400 (afwijking, gemeld)');
  for (const m of r.per_mentor) {
    assert.equal(m.oorspronkelijk, 108);
    assert.equal(m.reeds_vrijgegeven, 42);
    assert.equal(m.doel_op_betaalde_facturen, 6.6, '108 × 440 / 7200');
    assert.equal(m.te_veel_vrijgegeven_t_o_v_doel, 35.4);
    assert.equal(m.werkelijk_uitbetaald, 24, 'rapporten jun–sep (goedgekeurd) tellen als uitbetaald');
    assert.equal(m.status_uitbetaald, 0, 'status zegt nog niets uitbetaald');
    assert.equal(m.verschil_status_werkelijkheid, 24);
    assert.equal(m.vrijgegeven_niet_in_rapport, 18, 'termijnen 5–7 zitten in geen rapport');
    assert.equal(m.te_veel_uitbetaald_t_o_v_doel, 17.4);
  }
});

test('omzetten: parents met de oorspronkelijke commissie, termijnregels worden children, bedragen onaangeroerd', async () => {
  basis();
  const voor = JSON.stringify(regels().map((e) => [e.id, e.amount, e.status, e.released_at, e.payout_id]));
  const r = await omz.omzetTraject({ trajectId: T, customerId: K, dealId: D, dryRun: false });
  assert.equal(r.ok, true);
  const parents = L().filter((e) => omz.isTrajectParentKey(e.idempotency_key));
  assert.equal(parents.length, 2);
  for (const p of parents) {
    assert.equal(p.original_amount, 108);
    assert.equal(p.amount, 66, '108 − 42');
    assert.equal(p.status, 'pending');
    assert.equal(p.customer_id, K);
    assert.equal(p.source_quote_id, D);
    assert.equal(p.basis, 7200);
    const kinderen = L().filter((e) => e.parent_entry_id === p.id);
    assert.equal(kinderen.length, 7);
    assert.ok(kinderen.every((e) => e.mentor_user_id === p.mentor_user_id));
  }
  const na = JSON.stringify(L().filter((e) => omz.isTrajectTermKey(e.idempotency_key)).map((e) => [e.id, e.amount, e.status, e.released_at, e.payout_id]));
  assert.equal(na, voor, 'bedrag, status, released_at en payout_id ongewijzigd');
  assert.equal(db.rows('mentor_cash_trajects')[0].status, 'omgezet');

  // Tweede keer: idempotent, geen extra parents.
  await omz.omzetTraject({ trajectId: T, customerId: K, dealId: D, dryRun: false });
  assert.equal(L().filter((e) => omz.isTrajectParentKey(e.idempotency_key)).length, 2);
});

test('factuurmotor na omzetten: niets vrij zolang te veel vrijgegeven (verrekening)', async () => {
  basis();
  await omz.omzetTraject({ trajectId: T, customerId: K, dealId: D, dryRun: false });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(r.total_released, 0);
  assert.ok(r.simulations.every((s) => s.skip_reason === 'no_delta'), JSON.stringify(r.simulations));
  // Ook via de cron (die nu de factuurmotor draait): niets.
  const s = await core.releaseCashTrajectTerms({});
  assert.equal(s.mentor_entries_count, 0);
});

test('factuurmotor na omzetten: zodra de betalingen het inhalen, precies het verschil — en nooit dubbel', async () => {
  // 3200 betaald → doel 108 × 3200/7200 = 48 per mentor; reeds 42 → 6 erbij.
  basis({ facturen: [factuur('i-1', 400), ...Array.from({ length: 7 }, (_, i) => factuur(`i-${i + 2}`, 400, { paid_date: `2026-1${i % 2}-0${i + 1}` }))] });
  await omz.omzetTraject({ trajectId: T, customerId: K, dealId: D, dryRun: false });
  const r1 = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(r1.total_released, 12, '2 mentoren × 6');
  for (const uid of [SEPPE, DANNY]) {
    const p = L().find((e) => e.idempotency_key === omz.saleParentKey(T, uid));
    const vrij = L().filter((e) => e.parent_entry_id === p.id).reduce((s, e) => s + Number(e.amount), 0);
    assert.equal(Math.round(vrij * 100) / 100, 48, 'reeds 42 + 6 = doel 48, niet meer');
  }
  const r2 = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(r2.total_released, 0, 'tweede run: niets dubbel');
});

test('maakVerrekenaar: eerst het reeds vergoede bedrag, daarna telt alles', () => {
  const v = omz.maakVerrekenaar(15);
  assert.equal(v.neem(6), 6);
  assert.equal(v.neem(6), 6);
  assert.equal(v.neem(6), 3, 'deels verrekend');
  assert.equal(v.neem(6), 0);
  assert.equal(v.rest(), 0);
});

test('rapportstand: goedgekeurd t/m september = werkelijk uitbetaald, oktober niet', () => {
  const ps = new Map([['a', { id: 'a', status: 'goedgekeurd', period_month: '2026-09-01' }], ['b', { id: 'b', status: 'goedgekeurd', period_month: '2026-10-01' }]]);
  assert.equal(uitb.regelStand({ status: 'vrijgegeven', payout_id: 'a' }, ps), 'uitbetaald_status_achter');
  assert.equal(uitb.regelStand({ status: 'vrijgegeven', payout_id: 'b' }, ps), 'in_rapport');
  assert.equal(uitb.regelStand({ status: 'vrijgegeven', payout_id: null }, ps), 'niet_in_rapport');
  assert.equal(uitb.regelStand({ status: 'uitbetaald', payout_id: 'b' }, ps), 'uitbetaald');
});
