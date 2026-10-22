// tests/commissie-vrijgave-eigen-deal.test.js
//
// Multi-deal-fix in de vrijgave-engine (mentor-ledger-engine.js):
//   (a) een handmatig toegewezen sale (verlenging) geeft ALLEEN vrij op de
//       facturen van zijn eigen deal — nooit klantbreed;
//   (b) een event-bonus telt de facturen van een toegewezen deal niet mee;
//   gecrediteerd = niet betaald; idempotent; zonder migratie exact het oude
//   gedrag. Echte engine, nep-database.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client } });
const engine = await import(url('api/_lib/mentor-ledger-engine.js'));
const hulp = await import(url('api/_lib/commissie-toewijzing.js'));

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001'; // event-sale
const D2 = 'd2000000-0000-4000-8000-000000000002'; // verlenging
const X = 'a0000000-0000-4000-8000-00000000000a';  // toewijzing op D2
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';  // mentor
const EV = 'e0000000-0000-4000-8000-0000000000e1';

function basis({ facturen = [], toewijzing = true, missing = [] } = {}) {
  db.reset({
    deals: [
      { id: D1, customer_id: K },
      { id: D2, customer_id: K },
    ],
    subscriptions: [
      { id: 's1', deal_id: D1, teamleader_subscription_id: 'tl-1', term_count: 12, start_date: '2025-01-01' },
      { id: 's2', deal_id: D2, teamleader_subscription_id: 'tl-2', term_count: 6, start_date: '2026-09-01' },
    ],
    invoices: facturen,
    mentor_sale_attributions: toewijzing
      ? [{ id: X, deal_id: D2, customer_id: K, reden: 'verlenging', pct: 3, basis: 3000, status: 'actief' }]
      : [],
    mentor_ledger_entries: [
      { id: 'p-event', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K,
        basis: 6000, amount: 180, original_amount: null, status: 'pending', parent_entry_id: null,
        source_quote_id: D1, idempotency_key: `${EV}:bonus:att1:${A}`, created_at: '2025-01-01T00:00:00Z' },
      ...(toewijzing ? [{ id: 'p-attr', mentor_user_id: A, event_id: null, attribution_id: X, entry_type: 'bonus',
        customer_id: K, basis: 3000, amount: 90, original_amount: null, status: 'pending', parent_entry_id: null,
        source_quote_id: D2, idempotency_key: hulp.attrIdempotencyKey(X, A), created_at: '2026-09-01T00:00:00Z' }] : []),
    ],
  }, missing);
}
const kids = (parentId) => db.rows('mentor_ledger_entries').filter((e) => e.parent_entry_id === parentId);
const som = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;

const fOud = (bedrag, extra = {}) => ({ id: 'i-oud', customer_id: K, deal_id: D1, tl_subscription_id: 'tl-1',
  amount_total: 6000, amount_paid: bedrag, credited_amount: 0, status: bedrag >= 6000 ? 'paid' : 'partially_paid',
  paid_date: '2026-03-10', ...extra });
const fNieuw = (bedrag, extra = {}) => ({ id: 'i-nieuw', customer_id: K, deal_id: D2, tl_subscription_id: null,
  amount_total: 3000, amount_paid: bedrag, credited_amount: 0, status: bedrag >= 3000 ? 'paid' : 'partially_paid',
  paid_date: '2026-10-05', ...extra });

test('verlenging: commissie valt NIET vrij op betalingen van de oude deal', async () => {
  basis({ facturen: [fOud(6000)] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(kids('p-attr').length, 0, 'geen vrijgave zonder betaling op D2');
  assert.equal(som(kids('p-event')), 180, 'event-bonus wel volledig (eigen deal betaald)');
});

test('verlenging: geeft alleen het eigen deel vrij en zet attribution_id op de child', async () => {
  basis({ facturen: [fOud(3000), fNieuw(1000)] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-attr')), 30, '1000/3000 × 90');
  assert.equal(kids('p-attr')[0].attribution_id, X);
  assert.equal(kids('p-attr')[0].event_id, null);
  assert.equal(kids('p-attr')[0].released_at, '2026-10-01T00:00:00.000Z');
});

test('event-bonus: verlengingsfactuur geeft GEEN rest van de oude event-bonus vrij', async () => {
  basis({ facturen: [fOud(3000), fNieuw(3000)] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-event')), 90, 'alleen 3000/6000 × 180, niet (3000+3000)/6000');
  assert.equal(som(kids('p-attr')), 90, 'verlenging volledig betaald');
});

test('verlengingsfactuur via tl_subscription_id van de deal telt mee (deal_id leeg)', async () => {
  basis({ facturen: [fNieuw(1500, { deal_id: null, tl_subscription_id: 'tl-2' })] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-attr')), 45);
  assert.equal(kids('p-event').length, 0, 'event-sale ziet de verlengingsfactuur niet');
});

test('gecrediteerde factuur = niet betaald, ook als de rij nog "paid" zegt', async () => {
  basis({ facturen: [fNieuw(3000, { status: 'paid', credited_amount: 3000 })] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(kids('p-attr').length, 0);
});

test('idempotent: tweede run geeft niets extra vrij', async () => {
  basis({ facturen: [fOud(3000), fNieuw(1000)] });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  const r2 = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(r2.released_children, 0);
  assert.equal(som(kids('p-attr')), 30);
  assert.equal(som(kids('p-event')), 90);
});

test('forward-only: toewijzing achteraf draait al vrijgegeven event-bonus niet terug', async () => {
  // Eerst zonder toewijzing: oude gedrag telt de verlengingsfactuur klantbreed.
  basis({ facturen: [fOud(3000), fNieuw(3000)], toewijzing: false });
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-event')), 180);
  // Nu wordt D2 toegewezen: event-som zakt naar 3000, maar niets wordt teruggedraaid.
  db.tables.mentor_sale_attributions = [{ id: X, deal_id: D2, customer_id: K, reden: 'verlenging', status: 'actief' }];
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-event')), 180);
});

test('zonder migratie (tabel ontbreekt): exact het oude klantbrede gedrag', async () => {
  basis({ facturen: [fOud(3000), fNieuw(1000)], toewijzing: false, missing: ['mentor_sale_attributions'] });
  const r = await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-event')), 120, 'MAX(sub 3000, klant 4000)/6000 × 180');
  assert.equal(r.paid_total, 4000);
});

test('geannuleerde toewijzing sluit de deal niet meer uit (oude gedrag terug)', async () => {
  basis({ facturen: [fOud(3000), fNieuw(1000)] });
  db.tables.mentor_sale_attributions[0].status = 'geannuleerd';
  db.tables.mentor_ledger_entries = db.tables.mentor_ledger_entries.filter((e) => e.id !== 'p-attr');
  await engine.releaseProportionalForPaidAmount({ customerId: K });
  assert.equal(som(kids('p-event')), 120);
});

test('termijn-modus: event-parent zonder eigen sub valt niet terug op de verlengings-sub', async () => {
  basis({ facturen: [
    { id: 't1', customer_id: K, deal_id: D2, tl_subscription_id: 'tl-2', amount_total: 500, amount_paid: 500, credited_amount: 0, status: 'paid', paid_date: '2026-10-02' },
  ] });
  // Event-deal zonder sub: alleen de verlengings-sub blijft over.
  db.tables.subscriptions = db.tables.subscriptions.filter((s) => s.deal_id !== D1);
  await engine.releaseProportionalForPaidInvoices({ customerId: K });
  assert.equal(kids('p-event').length, 0, 'schema_unknown i.p.v. verlengingstermijnen');
  assert.equal(som(kids('p-attr')), 15, '1/6 × 90');
  assert.equal(kids('p-attr')[0].attribution_id, X);
});

test('offerte geannuleerd → open toewijzings-parents én de toewijzing geannuleerd', async () => {
  basis();
  const r = await engine.cancelForCancelledQuote({ quoteId: D2 });
  assert.equal(r.cancelled, 1);
  assert.equal(db.rows('mentor_ledger_entries').find((e) => e.id === 'p-attr').status, 'geannuleerd');
  assert.equal(db.rows('mentor_sale_attributions')[0].status, 'geannuleerd');
  assert.equal(db.rows('mentor_ledger_entries').find((e) => e.id === 'p-event').status, 'pending');
});

test('cancelForCancelledQuote zonder migratie gooit niet', async () => {
  basis({ toewijzing: false, missing: ['mentor_sale_attributions'] });
  const r = await engine.cancelForCancelledQuote({ quoteId: D1 });
  assert.equal(r.cancelled, 1);
});

test('helpers: aandeel per mentor op centen, idempotency-key, attributionIdOf', () => {
  assert.equal(hulp.aandeelPerMentor(1000, 3, 1), 30);
  assert.equal(hulp.aandeelPerMentor(1000, 3, 3), 10);
  assert.equal(hulp.aandeelPerMentor(1001, 3, 3), 10.01);
  assert.equal(hulp.aandeelPerMentor(7200, 3, 2), 108);
  assert.equal(hulp.aandeelPerMentor(0, 3, 2), 0);
  assert.equal(hulp.aandeelPerMentor(1000, 3, 0), 0);
  assert.equal(hulp.attrIdempotencyKey(X, A), `attr:${X}:${A}`);
  assert.equal(hulp.attributionIdOf({ idempotency_key: `attr:${X}:${A}` }), X);
  assert.equal(hulp.attributionIdOf({ attribution_id: X }), X);
  assert.equal(hulp.attributionIdOf({ idempotency_key: `${EV}:bonus:x:${A}` }), null);
  assert.equal(hulp.attributionIdOf({ idempotency_key: `${X}:paidamount:100` }), null);
});
