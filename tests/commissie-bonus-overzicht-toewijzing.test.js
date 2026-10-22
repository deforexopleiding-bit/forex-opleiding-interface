// tests/commissie-bonus-overzicht-toewijzing.test.js
//
// computeBonusOverview (mentorzicht + payout-bron) met een handmatige
// toewijzing: de verlenging staat in de groep "Handmatig toegewezen", telt
// alleen zijn eigen deal-facturen, en de event-sale ziet de verlengings-
// facturen niet. Zonder toewijzingen blijft de output ongewijzigd.

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
const { computeBonusOverview } = await import(url('api/mentor-bonus-overview.js'));

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const X = 'a0000000-0000-4000-8000-00000000000a';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const EV = 'e0000000-0000-4000-8000-0000000000e1';

function maand(off) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + off);
  return d.toISOString().slice(0, 10);
}

function zet({ toewijzing = true } = {}) {
  const inv = (id, deal, tl, due, paid) => ({ id, customer_id: K, deal_id: deal, tl_subscription_id: tl,
    amount_total: 100, amount_paid: paid ? 100 : 0, credited_amount: 0, status: paid ? 'paid' : 'open',
    due_date: due, paid_date: paid ? due : null });
  db.reset({
    events: [{ id: EV, title: 'Event Gent', starts_at: '2025-01-10T09:00:00Z' }],
    customers: [{ id: K, first_name: 'Jan', last_name: 'Peeters' }],
    deals: [{ id: D1, customer_id: K }, { id: D2, customer_id: K }],
    subscriptions: [
      { id: 's1', deal_id: D1, teamleader_subscription_id: 'tl-1', amount: 100, vat_percentage: 0, term_count: 3,
        billing_cycle: 'per_month', start_date: maand(-4), status: 'active' },
      { id: 's2', deal_id: D2, teamleader_subscription_id: 'tl-2', amount: 100, vat_percentage: 0, term_count: 2,
        billing_cycle: 'per_month', start_date: maand(-1), status: 'active' },
    ],
    invoices: [
      inv('o1', D1, null, maand(-4), true), inv('o2', D1, null, maand(-3), true), inv('o3', D1, null, maand(-2), true),
      inv('n1', D2, null, maand(-1), true),
    ],
    mentor_sale_attributions: toewijzing
      ? [{ id: X, deal_id: D2, customer_id: K, reden: 'verlenging', pct: 3, basis: 200, status: 'actief', created_at: '2026-10-01T00:00:00Z' }]
      : [],
    mentor_ledger_entries: [
      { id: 'p-event', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 300, amount: 9,
        status: 'pending', parent_entry_id: null, source_quote_id: D1, idempotency_key: `${EV}:bonus:att:${A}`,
        created_at: '2025-01-10T00:00:00Z' },
      ...(toewijzing ? [{ id: 'p-attr', mentor_user_id: A, event_id: null, attribution_id: X, entry_type: 'bonus',
        customer_id: K, basis: 200, amount: 6, status: 'pending', parent_entry_id: null, source_quote_id: D2,
        idempotency_key: `attr:${X}:${A}`, created_at: '2026-10-01T00:00:00Z' }] : []),
    ],
  });
}

test('toewijzing → eigen groep "Handmatig toegewezen · Verlenging" met bron/reden', async () => {
  zet();
  const out = await computeBonusOverview(A);
  const handmatig = out.per_event.find((e) => e.is_handmatig);
  assert.ok(handmatig, 'groep bestaat');
  assert.equal(handmatig.event_id, null);
  assert.equal(handmatig.event_title, 'Handmatig toegewezen · Verlenging');
  assert.equal(handmatig.reden, 'verlenging');
  const sale = handmatig.sales[0];
  assert.equal(sale.bron, 'handmatig');
  assert.equal(sale.attribution_id, X);
  assert.equal(sale.deal_id, D2);
  assert.equal(sale.term_count, 2, 'alleen de sub van de eigen deal');
  assert.equal(sale.paid_term_count, 1, 'alleen de eigen betaalde factuur');
  assert.equal(sale.mentor_share_total, 6);
});

test('event-sale ziet de verlengingsfacturen niet (3/3 i.p.v. 4 facturen)', async () => {
  zet();
  const out = await computeBonusOverview(A);
  const ev = out.per_event.find((e) => e.event_id === EV);
  assert.equal(ev.sales.length, 1);
  assert.equal(ev.sales[0].bron, 'event');
  assert.equal(ev.sales[0].term_count, 3);
  assert.equal(ev.sales[0].paid_term_count, 3);
  assert.equal(ev.sales[0].status, 'voltooid');
});

test('earned_total telt beide sales, termijnen in de projectie', async () => {
  zet();
  const out = await computeBonusOverview(A);
  assert.equal(out.totals.earned_total, 15);
  const betaald = out.projection_12m.reduce((s, m) => s + m.paid, 0);
  assert.equal(Math.round(betaald * 100) / 100, 12, '3 × 3 event + 1 × 3 verlenging');
});

test('zonder toewijzing: geen handmatige groep, event-sale ongewijzigd', async () => {
  zet({ toewijzing: false });
  const out = await computeBonusOverview(A);
  assert.equal(out.per_event.filter((e) => e.is_handmatig).length, 0);
  assert.equal(out.totals.earned_total, 9);
});

test('tabel ontbreekt (migratie niet gedraaid): overzicht werkt gewoon', async () => {
  zet({ toewijzing: false });
  db.missing.add('mentor_sale_attributions');
  const out = await computeBonusOverview(A);
  assert.equal(out.ok, true);
  assert.equal(out.per_event.length, 1);
});

test('mentor_count: gedeelde event-sale telt mentoren, zonder bedragen van anderen', async () => {
  zet();
  const B = 'bbbbbbbb-0000-4000-8000-0000000000bb';
  db.tables.mentor_ledger_entries.push({ id: 'p-event-b', mentor_user_id: B, event_id: EV, entry_type: 'bonus', customer_id: K,
    basis: 300, amount: 9, status: 'pending', parent_entry_id: null, source_quote_id: D1, attendee_id: null,
    idempotency_key: `${EV}:bonus:att:${B}`, created_at: '2025-01-10T00:00:00Z' });
  // attendee_id gelijk zetten zodat beide regels dezelfde sale zijn.
  for (const e of db.tables.mentor_ledger_entries) if (e.event_id === EV) e.attendee_id = 'att-1';
  const out = await computeBonusOverview(A);
  const ev = out.per_event.find((e) => e.event_id === EV);
  assert.equal(ev.sales[0].mentor_count, 2);
  assert.equal(ev.sales[0].mentor_share_total, 9, 'alleen het eigen aandeel');
  const hm = out.per_event.find((e) => e.is_handmatig);
  assert.equal(hm.sales[0].mentor_count, 1);
});
