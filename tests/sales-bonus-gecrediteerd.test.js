// tests/sales-bonus-gecrediteerd.test.js
//
// De earn-hook van de sales-bonus mag een VOLLEDIG gecrediteerde factuur nooit
// als betaalde aanbetaling zien — ook niet als een oude rij nog status 'paid'
// + amount_paid = totaal zegt (zo stonden 281 van 282 gecrediteerde facturen
// op 29-09-2026). Echte sales-bonus.js, nep-database.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = { tables: {}, updates: [] };
function nepAdmin() {
  return {
    from(tabel) {
      let rows = [...(db.tables[tabel] || [])];
      let patch = null;
      const k = {
        select: () => k,
        eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return k; },
        neq: (c, v) => { rows = rows.filter((r) => r[c] !== v); return k; },
        in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return k; },
        or: () => k, order: () => k, limit: () => k,
        update(v) { patch = v; return k; },
        maybeSingle: async () => {
          if (patch) { for (const r of rows) { db.updates.push({ tabel, id: r.id, patch }); Object.assign(r, patch); } }
          return { data: rows[0] ?? null, error: null };
        },
        then: (r, j) => Promise.resolve({ data: rows, error: null }).then(r, j),
      };
      return k;
    },
  };
}
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: nepAdmin() } });
mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async () => {} } });
const { earnBonusForPaidInvoice } = await import(url('api/_lib/sales-bonus.js'));

const DEAL = 'd1', INV = 'i1';
function reset(inv) {
  db.updates = [];
  db.tables = {
    invoices: [{ id: INV, deal_id: DEAL, tl_subscription_id: null, issue_date: '2026-07-01', created_at: '2026-07-01', ...inv }],
    deals: [{ id: DEAL, reservation_fee_invoice_id: null }],
    subscriptions: [],
    bonuses: [{ id: 'b1', deal_id: DEAL, status: 'pending' }],
  };
}

test('earn: volledig gecrediteerde aanbetaling (oude rij "paid") → GEEN bonus verdiend', async () => {
  reset({ status: 'paid', amount_total: 500, amount_paid: 500, credited_amount: 500 });
  const r = await earnBonusForPaidInvoice({ id: INV, deal_id: DEAL });
  assert.equal(r.skipped, 'credited');
  assert.equal(db.updates.length, 0);
  assert.equal(db.tables.bonuses[0].status, 'pending');
});

test('earn: echt betaalde aanbetaling → bonus verdiend (ongewijzigd gedrag)', async () => {
  reset({ status: 'paid', amount_total: 500, amount_paid: 500, credited_amount: 0 });
  const r = await earnBonusForPaidInvoice({ id: INV, deal_id: DEAL });
  assert.equal(r.earned, 'b1');
  assert.equal(db.tables.bonuses[0].status, 'earned');
});
