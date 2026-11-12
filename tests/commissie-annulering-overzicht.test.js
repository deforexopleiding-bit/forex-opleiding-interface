// tests/commissie-annulering-overzicht.test.js
//
// computeBonusOverview (mentorzicht + payout-bron) na een annulering:
//  - zonder vrijgegeven stukken: ongewijzigd oud gedrag (telt nergens mee),
//    maar met reden + toezegging zichtbaar voor de mentor;
//  - mét vrijgegeven stukken: die blijven staan — wat vóór de annuleerdatum
//    betaald werd telt, de rest vervalt (zelfde afkappunt als incasso).

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
const { bouwOverzicht } = await import(url('api/_lib/commissie-core.js'));

const K = '11111111-1111-4111-8111-111111111111';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const EV = 'e0000000-0000-4000-8000-0000000000e1';

function maand(off) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + off);
  return d.toISOString().slice(0, 10);
}
const vandaag = new Date().toISOString().slice(0, 10);

function zet({ kind = false } = {}) {
  const inv = (id, due, paid) => ({ id, customer_id: K, deal_id: D1, tl_subscription_id: null,
    amount_total: 100, amount_paid: paid ? 100 : 0, credited_amount: 0, status: paid ? 'paid' : 'open',
    due_date: due, paid_date: paid ? due : null });
  db.reset({
    events: [{ id: EV, title: 'Event Gent', starts_at: '2026-11-07T18:00:00Z' }],
    customers: [{ id: K, first_name: 'Jan', last_name: 'Peeters' }],
    deals: [{ id: D1, customer_id: K }],
    subscriptions: [{ id: 's1', deal_id: D1, teamleader_subscription_id: 'tl-1', amount: 100, vat_percentage: 0, term_count: 3,
      billing_cycle: 'per_month', start_date: maand(-1), status: 'cancelled' }],
    invoices: kind ? [inv('o1', maand(-1), true), inv('o2', maand(0), false)] : [],
    mentor_ledger_entries: [
      { id: 'p1', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 300, amount: kind ? 6 : 9, original_amount: 9,
        status: 'geannuleerd', parent_entry_id: null, source_quote_id: D1, idempotency_key: 'k1', created_at: '2026-11-07T20:00:00Z',
        note: `Bonus 3% | Geannuleerd (Klant geannuleerd — was: pending) op ${vandaag}` },
      ...(kind ? [{ id: 'c1', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, amount: 3, status: 'vrijgegeven',
        parent_entry_id: 'p1', source_quote_id: D1, idempotency_key: 'p1:stuk:o1', released_at: maand(-1) + 'T00:00:00Z' }] : []),
    ],
  });
}

test('zonder stukken: telt nergens mee, mentor ziet reden + oorspronkelijk bedrag', async () => {
  zet();
  const out = await computeBonusOverview(A);
  const s = out.per_event[0].sales[0];
  assert.equal(s.status, 'geannuleerd');
  assert.equal(s.mentor_share_total, 0);
  assert.equal(s.annulering.reden, 'Klant geannuleerd');
  assert.equal(s.annulering.oorspronkelijk, 9);
  assert.equal(s.annulering.behoud_vrijgegeven, false);
  assert.equal(out.totals.earned_total, 0);
  const ov = bouwOverzicht({ mentoren: [{ user_id: A, naam: 'Anna' }], overzichten: new Map([[A, out]]) });
  assert.equal(ov.sales[0].status, 'geannuleerd');
  assert.equal(ov.sales[0].annulering.reden, 'Klant geannuleerd');
  assert.equal(ov.kpis.aantal_sales, 0);
});

test('met vrijgegeven stuk: dat blijft staan, de rest vervalt, status geannuleerd', async () => {
  zet({ kind: true });
  const out = await computeBonusOverview(A);
  const s = out.per_event[0].sales[0];
  assert.equal(s.status, 'geannuleerd');
  assert.equal(s.annulering.behoud_vrijgegeven, true);
  assert.equal(s.vrijgegeven_rapport, 3, 'betaald vóór de annulering telt');
  assert.equal(s.incasso, null);
  const betaald = out.projection_12m.reduce((t, m) => t + m.paid, 0);
  assert.equal(Math.round(betaald * 100) / 100, 3);
  const ov = bouwOverzicht({ mentoren: [{ user_id: A, naam: 'Anna' }], overzichten: new Map([[A, out]]) });
  const sale = ov.sales[0];
  assert.equal(sale.status, 'geannuleerd');
  assert.equal(sale.vrijgegeven, 3);
  assert.equal(sale.open, 0, 'na annulering komt er niets meer');
});
