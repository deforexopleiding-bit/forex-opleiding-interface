// api/finance-invoice-bulk-resync.js
// POST → bulk re-sync van invoices via de bestaande shared upsertInvoiceFromTl
// helper. Bedoeld om gemiste paid-events terug te halen die de cron-overshoot
// bug stilletjes had laten liggen + om periodiek alle open facturen te
// "verversen" tegen TL.
//
// SUPER_ADMIN ONLY.
//
// Body:
//   { scope: 'recent_90d' | 'all_open' | 'specific_ids', tl_ids?: string[] }
//
//   recent_90d   → TL invoices.list met invoice_date_after = NOW-90d, over alle
//                  3 departments, gepagineerd size=100. Upsert elk.
//   all_open     → SELECT van onze DB: invoices waar status IN
//                  ('open', 'partially_paid', 'overdue'), neem tl_invoice_id.
//                  Upsert elk via die tl_id (TL invoices.info).
//   specific_ids → upsert elke tl_id uit body.tl_ids[]. Voor handmatige fixes.
//
// 50s tijdsbudget zoals cron-pattern. Idempotent — herhaaldelijk uitvoeren
// totdat aborted_by_timeout=false. Bij persistente fail op een record: zelfde
// records worden in elke run opnieuw geprobeerd (DB-lookup blijft ze
// returnen).
//
// Response:
//   {
//     scope, processed, updated, inserted, errors,
//     error_samples: [{ tl_id, message }],
//     aborted_by_timeout, duration_ms
//   }

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';

const ABORT_MS = 50_000;
const TL_PAGE_SIZE = 100;
const TL_THROTTLE_MS = 200;

const DEPARTMENTS = [
  '09d67371-6947-03f6-bd5e-410dd8636344', // Online
  '0da396bf-1074-0425-ac5c-fa1141b41cb1', // Fysiek
  '9adca043-0ebc-09da-a45e-f21798841cb2', // Retentie
];

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tlCall(path, body, attempt = 0) {
  await sleep(TL_THROTTLE_MS);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

function todayMinusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const body = req.body || {};
  const scope = String(body.scope || 'all_open');
  const tlIdsBody = Array.isArray(body.tl_ids) ? body.tl_ids.filter(x => typeof x === 'string' && x.length) : [];

  if (!['recent_90d', 'all_open', 'specific_ids'].includes(scope)) {
    return res.status(400).json({ error: "scope moet 'recent_90d', 'all_open' of 'specific_ids' zijn" });
  }
  if (scope === 'specific_ids' && !tlIdsBody.length) {
    return res.status(400).json({ error: "tl_ids[] vereist bij scope='specific_ids'" });
  }

  const startedAt = Date.now();
  const totals = { processed: 0, updated: 0, inserted: 0, errors: 0 };
  const error_samples = [];
  let aborted = false;

  // Helper: één tl_id upserten met error-collection.
  async function upsertOne(tlId) {
    if (Date.now() - startedAt > ABORT_MS) { aborted = true; return; }
    totals.processed++;
    try {
      const out = await upsertInvoiceFromTl(tlId);
      if (out?.action === 'inserted') totals.inserted++;
      else if (out?.action === 'updated') totals.updated++;
    } catch (e) {
      totals.errors++;
      if (error_samples.length < 20) error_samples.push({ tl_id: tlId, message: String(e.message || e).slice(0, 300) });
    }
  }

  try {
    if (scope === 'specific_ids') {
      for (const id of tlIdsBody) {
        if (aborted || Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
        await upsertOne(id);
      }
    } else if (scope === 'all_open') {
      // Paginate de DB: max 1000 per slice (Supabase max-rows).
      const SLICE = 1000;
      let offset = 0;
      while (!aborted && (Date.now() - startedAt) < ABORT_MS) {
        const { data: rows, error } = await supabaseAdmin
          .from('invoices')
          .select('tl_invoice_id')
          .in('status', OPEN_STATUSES)
          .not('tl_invoice_id', 'is', null)
          .order('issue_date', { ascending: false })
          .range(offset, offset + SLICE - 1);
        if (error) {
          console.error('[bulk-resync] DB slice fout:', error.message);
          totals.errors++;
          break;
        }
        if (!rows || rows.length === 0) break;
        for (const row of rows) {
          if (Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
          if (row.tl_invoice_id) await upsertOne(row.tl_invoice_id);
        }
        if (rows.length < SLICE) break;
        offset += SLICE;
      }
    } else if (scope === 'recent_90d') {
      const since = todayMinusDays(90);
      for (const dept of DEPARTMENTS) {
        if (aborted || Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
        let page = 1;
        while (!aborted && (Date.now() - startedAt) < ABORT_MS) {
          const r = await tlCall('/invoices.list', {
            filter: { department_id: dept, invoice_date_after: since },
            page: { size: TL_PAGE_SIZE, number: page },
            sort: [{ field: 'invoice_date', order: 'desc' }],
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            console.error('[bulk-resync] invoices.list HTTP', r.status, dept, txt.slice(0, 200));
            totals.errors++;
            break;
          }
          let batch = [];
          try { batch = (await r.json()).data || []; }
          catch (e) {
            console.error('[bulk-resync] json-parse fout', e.message);
            totals.errors++;
            break;
          }
          if (!batch.length) break;
          for (const lite of batch) {
            if (Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
            if (lite.id) await upsertOne(lite.id);
          }
          if (batch.length < TL_PAGE_SIZE) break;
          page++;
        }
      }
    }

    const duration_ms = Date.now() - startedAt;
    console.log('[bulk-resync] klaar', JSON.stringify({ scope, ...totals, duration_ms, aborted }));

    return res.status(200).json({
      success: true,
      scope,
      processed:           totals.processed,
      updated:             totals.updated,
      inserted:            totals.inserted,
      errors:              totals.errors,
      error_samples,
      aborted_by_timeout:  aborted,
      duration_ms,
    });
  } catch (e) {
    console.error('[bulk-resync]', e.message);
    return res.status(500).json({ error: e.message, totals });
  }
}
