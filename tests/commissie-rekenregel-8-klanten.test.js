// tests/commissie-rekenregel-8-klanten.test.js
//
// Rekenregel 9 nov 2026 op de ECHTE stand van 9 november (alleen gelezen uit
// productie, ingekort tot voornaam/label: tests/fixtures/commissie-8-klanten.json)
// voor BV Ky, Cedric Van Houtte, Richiano Blondiau, Paul Plantfeber, Shaliwal,
// Alikozai, Rasmussen en De Rubbel. Rapport (overzicht), grootboek (factuurmotor)
// en controlescherm volgen dezelfde berekening; afgesloten maanden (t/m
// september) blijven zoals ze waren; geen inhaal.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, supabase: db.client, createUserClient: () => db.client } });
mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-09T10:00:00Z') });
const { computeBonusOverview } = await import(url('api/mentor-bonus-overview.js'));
const engine = await import(url('api/_lib/mentor-ledger-engine.js'));
const { commissieControle } = await import(url('api/_lib/commissie-controle.js'));
const FX = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/commissie-8-klanten.json'), 'utf8'));

const SEPPE = '162994ff-a21d-446f-bf0b-eea8e7978967';
const DANNY = '1aa012d4-81df-4510-81dd-38af6ef2888e';
const CHESNEY = '9f4cd827-9529-4647-bdd3-2db4cd340bab';
const KJENTO = '876bb8d7-8525-4853-b5e6-79bda9c80c7d';
const K = Object.fromEntries(FX.customers.map((c) => [c.company_name || c.first_name, c.id]));
const r2 = (n) => Math.round(n * 100) / 100;

beforeEach(() => {
  const { _meta, ...t } = FX;
  db.reset({ ...t, app_settings: [], event_attendees: [], event_mentors: [], team_members: [] });
});

async function sale(uid, klant) {
  const o = await computeBonusOverview(uid);
  for (const ev of o.per_event) for (const s of ev.sales) if (s.customer_id === K[klant]) return { o, s };
  throw new Error(`geen sale ${klant} bij ${uid}`);
}
const stukken = (s) => s.vrijgave_stukken.map((x) => [x.datum, x.bedrag]);
const factuur = (nummer) => db.tables.invoices.find((i) => i.invoice_number === nummer);
function nieuweFactuur(vanNummer, extra) {
  const f = { ...factuur(vanNummer), id: `0000000${db.tables.invoices.length}-0000-4000-8000-000000000000`.slice(-36), ...extra };
  db.tables.invoices.push(f);
  return f;
}
const kinderen = (uid, klant) => {
  const p = db.tables.mentor_ledger_entries.filter((e) => e.mentor_user_id === uid && e.customer_id === K[klant] && !e.parent_entry_id).map((e) => e.id);
  return db.tables.mentor_ledger_entries.filter((e) => p.includes(e.parent_entry_id));
};
const somNieuw = (uid, klant) => r2(kinderen(uid, klant).filter((k) => /:stuk:/.test(k.idempotency_key)).reduce((t, k) => t + Number(k.amount), 0));

/* ── Stand 9 november ─────────────────────────────────────────────────── */
test('BV Ky: afgesloten maanden blijven 3 × 6 per mentor (geen inhaal van de aanbetaling); toekomst 6 per factuur', async () => {
  for (const uid of [SEPPE, CHESNEY]) {
    const { o, s } = await sale(uid, 'BV Ky');
    assert.equal(o.laatste_gesloten_maand, '2026-09');
    assert.deepEqual(s.termijnen.filter((t) => t.bevroren).map((t) => [t.maand, t.amount]), [['2026-07', 6], ['2026-08', 6], ['2026-09', 6]]);
    assert.equal(s.vrijgegeven_rapport, 18);
    assert.deepEqual(stukken(s), [], 'nog niets betaald in een open maand');
    assert.equal(s.rekenregel.nieuw_verwacht, 60, '10 resterende facturen/termijnen × 6');
  }
});

test('Cedric: 39,90 bevroren + oktober 7,98 (266 × 216 / 7199,99); de aanbetaling wordt niet ingehaald', async () => {
  const { s } = await sale(DANNY, 'Cedric');
  assert.equal(s.rekenregel.bevroren, 39.9);
  assert.deepEqual(stukken(s), [['2026-10-09', 7.98]]);
  assert.equal(s.vrijgegeven_rapport, 47.88);
  assert.equal(s.rekenregel.grootboek_afgesloten, 127.98, 'oude vrijgave in het grootboek (juli) — begrenst de ruimte');
  assert.equal(s.rekenregel.ruimte, 88.02);
});

test('Richiano: september bevroren 5,93; oktober en november elk 4,50 (300 × 59,25 / 3950,01) — geen gemiddeld termijnbedrag meer', async () => {
  for (const uid of [SEPPE, KJENTO]) {
    const { s } = await sale(uid, 'Richiano');
    assert.equal(s.rekenregel.bevroren, 5.93);
    assert.deepEqual(stukken(s), [['2026-10-06', 4.5], ['2026-11-09', 4.5]]);
    assert.deepEqual(s.vergelijking_open, [{ maand: '2026-10', voor: 5.93, na: 4.5 }, { maand: '2026-11', voor: 5.93, na: 4.5 }]);
  }
});

test('Paul: 45,80 al in rapporten (traject); de oktoberfactuur geeft 12 − 11,45 nog niet verrekend voorschot = 0,55', async () => {
  const { s } = await sale(SEPPE, 'Paul');
  assert.equal(s.rekenregel.bevroren, 45.8);
  assert.deepEqual(stukken(s), [['2026-10-27', 0.55]]);
  assert.equal(s.vrijgegeven_rapport, 46.35);
});

test('Shaliwal (bij_incasso): niets nieuw, niets verwacht; de bureaufactuur 2026/2136 geeft geen commissie', async () => {
  for (const uid of [SEPPE, DANNY]) {
    const { s } = await sale(uid, 'Shaliwal');
    assert.equal(s.rekenregel.bevroren, 24);
    assert.deepEqual(stukken(s), []);
    assert.equal(s.rekenregel.nieuw_verwacht, 0);
  }
});

test('Alikozai (incasso-regeling 15 × 400): 18 te veel via het traject wordt eerst verrekend → 72 verwacht', async () => {
  for (const uid of [SEPPE, DANNY]) {
    const { s } = await sale(uid, 'Noorulhaq');
    assert.equal(s.rekenregel.bevroren, 24);
    assert.equal(s.rekenregel.nieuw_verwacht, 72, '15 × 6 − 18');
  }
});

test('Rasmussen en De Rubbel (bij_incasso, alles gecrediteerd): niets nieuw', async () => {
  for (const uid of [SEPPE, CHESNEY]) {
    for (const k of ['Rasmussen', 'De Rubbel']) {
      const { s } = await sale(uid, k);
      assert.deepEqual(stukken(s), []);
      assert.equal(s.rekenregel.nieuw_verwacht, 0);
    }
  }
  assert.equal((await sale(SEPPE, 'De Rubbel')).s.rekenregel.bevroren, 3.7);
});

/* ── Factuurmotor = exact de stukken van het overzicht ────────────────── */
test('factuurmotor: schrijft precies de stukken (Cedric 7,98, Richiano 2 × 9) en niets anders; tweede run niets', async () => {
  const totaal = {};
  for (const [naam, id] of Object.entries(K)) totaal[naam] = (await engine.releaseProportionalForPaidAmount({ customerId: id })).total_released;
  assert.deepEqual(totaal, { Shaliwal: 0, Cedric: 7.98, Noorulhaq: 0, Richiano: 18, Paul: 0, 'De Rubbel': 0, Rasmussen: 0, 'BV Ky': 0 });
  assert.equal(somNieuw(DANNY, 'Cedric'), 7.98);
  assert.equal(somNieuw(KJENTO, 'Richiano'), 9);
  assert.ok(kinderen(KJENTO, 'Richiano').filter((k) => /:stuk:/.test(k.idempotency_key)).every((k) => k.released_at >= '2026-10-01'), 'enkel open maanden');
  for (const id of Object.values(K)) assert.equal((await engine.releaseProportionalForPaidAmount({ customerId: id })).total_released, 0);
  // Paul: de oude vrijgave van 2,20 in oktober dekt de 0,55 → niets nieuw (te veel wordt verrekend).
  assert.equal(somNieuw(SEPPE, 'Paul'), 0);
});

test('controlescherm na de motor: zou moeten zijn = rapport; grootboek open = stukken; afgesloten verschil apart; voor/na per open maand', async () => {
  for (const id of Object.values(K)) await engine.releaseProportionalForPaidAmount({ customerId: id });
  const c = await commissieControle(db.client);
  const rij = (klant) => c.rijen.find((r) => r.customer_id === K[klant]);
  for (const k of ['Cedric', 'Richiano', 'BV Ky']) {
    assert.equal(rij(k).zou_moeten_zijn, rij(k).rapport_vrijgegeven);
    assert.equal(rij(k).verschil, 0, k + ': grootboek open = stukken');
    assert.ok(!rij(k).afwijkingen.includes('achter') && !rij(k).afwijkingen.includes('te_veel_vrijgegeven'), k);
  }
  assert.equal(rij('Cedric').bevroren_verschil, 88.08, '127,98 in het grootboek vs 39,90 in rapporten: bevroren, geen correctie');
  assert.equal(rij('Paul').verschil, 1.65, '2,20 oud vrijgegeven tegenover 0,55: wordt verrekend');
  assert.ok(rij('Paul').afwijkingen.includes('te_veel_vrijgegeven'));
  const okt = c.vergelijking_open.find((v) => v.maand === '2026-10');
  assert.equal(okt.voor, r2(7.98 + 5.93 * 2), 'oud: Cedric + 2 × Richiano (Paul 0)');
  assert.equal(okt.na, r2(7.98 + 4.5 * 2 + 0.55));
});

/* ── Vanaf nu: waterdicht ──────────────────────────────────────────────── */
test('BV Ky vanaf nu: elke betaalde factuur 6 per mentor, ook de 13e en volgende, nooit boven 108', async () => {
  Object.assign(factuur('2026 / 1969'), { amount_paid: 400, status: 'paid', paid_date: '2026-11-20' });
  let r = await engine.releaseProportionalForPaidAmount({ customerId: K['BV Ky'] });
  assert.equal(r.total_released, 12, '2 mentoren × 6 in november');
  for (let i = 0; i < 16; i++) nieuweFactuur('2026 / 1969', { invoice_number: `X-${i}`, due_date: `2027-${String((i % 12) + 1).padStart(2, '0')}-08`, paid_date: `2027-${String((i % 12) + 1).padStart(2, '0')}-09` });
  Object.assign(factuur('2026 / 2238'), { amount_paid: 400, status: 'paid', paid_date: '2026-11-25' });
  await engine.releaseProportionalForPaidAmount({ customerId: K['BV Ky'] });
  for (const uid of [SEPPE, CHESNEY]) {
    assert.equal(somNieuw(uid, 'BV Ky'), 90, '108 − 18 al uitbetaald');
    const { s } = await sale(uid, 'BV Ky');
    assert.equal(s.vrijgegeven_rapport, 108, 'rapport = grootboek = commissie');
  }
  r = await engine.releaseProportionalForPaidAmount({ customerId: K['BV Ky'] });
  assert.equal(r.total_released, 0, 'nooit dubbel');
});

test('Alikozai: regelingsbetalingen verrekenen eerst de 18 te veel, daarna 6 per betaling', async () => {
  Object.assign(factuur('2026 / 2317'), { amount_paid: 400, status: 'paid', paid_date: '2026-11-20' });
  ['2026-12', '2027-01', '2027-02'].forEach((m, i) => nieuweFactuur('2026 / 2317', { invoice_number: `R-${i}`, due_date: `${m}-20`, amount_paid: 400, status: 'paid', paid_date: `${m}-21` }));
  await engine.releaseProportionalForPaidAmount({ customerId: K.Noorulhaq });
  for (const uid of [SEPPE, DANNY]) {
    const { s } = await sale(uid, 'Noorulhaq');
    assert.deepEqual(stukken(s), [['2027-02-21', 6]], 'nov/dec/jan verrekend (18), februari telt');
    assert.equal(somNieuw(uid, 'Noorulhaq'), 6);
  }
});

test('Shaliwal: de bureaufactuur die op betaald komt terwijl de klant bij_incasso staat, geeft niets', async () => {
  Object.assign(factuur('2026 / 2136'), { amount_paid: 6760, status: 'paid', paid_date: '2026-11-20' });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: K.Shaliwal });
  assert.equal(r.total_released, 0);
});

test('Rasmussen / De Rubbel: betaling tijdens bij_incasso telt niet; na een regeling wél (commissie × betaald / basis)', async () => {
  const oud = db.tables.invoices.find((i) => i.customer_id === K.Rasmussen);
  nieuweFactuur(oud.invoice_number, { invoice_number: 'RAS-1', amount_total: 400, amount_paid: 400, credited_amount: 0, status: 'paid', due_date: '2026-11-15', paid_date: '2026-11-16' });
  assert.equal((await engine.releaseProportionalForPaidAmount({ customerId: K.Rasmussen })).total_released, 0, 'bij_incasso: stilstand');
  const rijen = db.tables.mentor_commissie_incasso.filter((m) => m.customer_id === K.Rasmussen && !m.opgeheven_op);
  for (const m of rijen) m.opgeheven_op = '2026-11-10T00:00:00Z';
  db.tables.mentor_commissie_incasso.push({ id: 'reg-ras', customer_id: K.Rasmussen, deal_id: null, sinds: '2026-11-10', incasso_sinds: '2026-10-19', status: 'incasso_regeling', opgeheven_op: null });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: K.Rasmussen });
  assert.equal(r.total_released, 12, '2 mentoren × 43,20 × 400 / 2880');
});
