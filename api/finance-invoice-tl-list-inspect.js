// api/finance-invoice-tl-list-inspect.js
// DIAGNOSE-ONLY sister van finance-invoice-tl-inspect.js. Roept de TL
// invoices.list-call aan met de EXACTE filter-shape die onze cron gebruikt
// (updated_since + department_id + sort=invoice_date asc), zodat we kunnen
// verifiëren of TL invoice 2026/1027 in de delta-response opneemt of niet.
//
// Daarmee splitsen we de twee hypotheses:
//   A. TL bumpt invoice.updated_at NIET bij payment-registratie → list
//      returnt 'm niet → onze cron heeft niets om te updaten.
//   B. TL bumpt updated_at WEL → list returnt 'm → bug zit in onze handler
//      (errored upsert, customer-FK miss, mapping-edge-case).
//
// Read-only. Super_admin only. Wordt verwijderd in cleanup-PR.
//
// GET ?department_id=<uuid>&updated_since=<ISO> &target_tl_id=<uuid>
//     &page_size=200&page=1
//
// Defaults:
//   updated_since = 2026-06-06T00:00:00+00:00
//   target_tl_id  = 96eea3a4-c1b5-07d7-a079-4ee6e2248677 (Muno's invoice 2026/1027)
//   page_size     = 100 (TL v2 max), page = 1
//   department_id = vereist (anders 400) — TL invoices.list wil 'm in filter
//
// Fail-safe: AbortController op 45s. Bij upstream TL HTTP-error returnt
// 502 met JSON-body (status + body-snippet). Bij timeout returnt 504 met
// elapsed_ms zodat we kunnen zien of TL traag is.
//
// Response:
//   {
//     query:              { ... },
//     tl_response:        { count_returned, page_size, page },
//     items:              [{ id, invoice_number, updated_at, invoice_date,
//                            status, paid, due, payable }, ...],
//     target_in_response: bool,
//     target_position:    int | null (index in items),
//     departments_in_cron: [...],  // wat onze cron traverseert
//     cron_filter_note:    "informatieve string"
//   }

import { verifyAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';

// Spiegel van de DEPARTMENTS-const uit cron-finance-sync.js. Bewust gekopieerd
// zodat we hier de "wat de cron ziet" set kunnen rapporteren in de response —
// een latere refactor van de cron mag deze diagnose-snapshot NIET stilletjes
// veranderen.
const CRON_DEPARTMENTS = [
  { id: '09d67371-6947-03f6-bd5e-410dd8636344', label: 'Online' },
  { id: '0da396bf-1074-0425-ac5c-fa1141b41cb1', label: 'Fysiek' },
  { id: '9adca043-0ebc-09da-a45e-f21798841cb2', label: 'Retentie' },
];

const DEFAULT_TARGET_TL_ID = '96eea3a4-c1b5-07d7-a079-4ee6e2248677';
const DEFAULT_UPDATED_SINCE = '2026-06-06T00:00:00+00:00';

function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const departmentId  = String(req.query?.department_id  || '').trim() || null;
  const updatedSince  = String(req.query?.updated_since  || '').trim() || DEFAULT_UPDATED_SINCE;
  const targetTlId    = String(req.query?.target_tl_id   || '').trim() || DEFAULT_TARGET_TL_ID;
  // TL v2 max page.size is 100 — bij size=200 geeft TL óf 400 óf een grote
  // trage response die Vercel's 60s function-timeout overschrijdt (502 zonder
  // JSON). Cap op 100 zoals cron-finance-sync.js doet.
  const pageSize      = Math.max(1, Math.min(100, Number(req.query?.page_size) || 100));
  const pageNumber    = Math.max(1, Number(req.query?.page) || 1);

  if (!departmentId) {
    return res.status(400).json({
      error: 'department_id query-param vereist',
      hint: 'Probeer 09d67371-6947-03f6-bd5e-410dd8636344 (Online) voor Muno.',
      cron_departments: CRON_DEPARTMENTS,
    });
  }

  try {
    const filter = { updated_since: updatedSince, department_id: departmentId };
    const body = {
      filter,
      page: { size: pageSize, number: pageNumber },
      sort: [{ field: 'invoice_date', order: 'asc' }],
    };

    // AbortController met 45s — leaves headroom onder Vercel's 60s function-
    // timeout zodat we nog steeds een JSON-respons kunnen returnen i.p.v.
    // gateway-502. Cron heeft 50s ABORT_MS budget; wij 45s want we doen ook
    // nog response-parsing + verifyAdmin overhead.
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);
    let r;
    try {
      r = await tlFetch('/invoices.list', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      const isAbort = e.name === 'AbortError' || /aborted/i.test(String(e.message));
      return res.status(504).json({
        error: isAbort ? 'TL invoices.list timeout (45s)' : `TL fetch error: ${e.message}`,
        elapsed_ms: Date.now() - startedAt,
        request_body: body,
      });
    }
    clearTimeout(timeoutId);

    const text = await r.text().catch(() => '');
    if (!r.ok) {
      return res.status(502).json({
        error: `TL invoices.list HTTP ${r.status}`,
        body: text.slice(0, 800),
        request_body: body,
        elapsed_ms: Date.now() - startedAt,
      });
    }

    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch {
      return res.status(502).json({
        error: 'TL-respons niet parsebaar',
        body: text.slice(0, 500),
        elapsed_ms: Date.now() - startedAt,
      });
    }
    const rawItems = parsed?.data || [];

    // Verzamel relevante velden per item.
    const items = rawItems.map((inv, i) => {
      const t = inv.total || {};
      return {
        index:           i,
        id:              inv.id,
        invoice_number:  (inv.invoice_number && String(inv.invoice_number).trim()) || `CONCEPT-${inv.id}`,
        status:          inv.status ?? null,
        paid:            inv.paid ?? null,
        updated_at:      inv.updated_at ?? null,
        invoice_date:    inv.invoice_date ?? null,
        paid_at:         inv.paid_at ?? null,
        payable:         amt(t.payable),
        due:             amt(t.due),
        invoicee_name:   inv.invoicee?.name ?? null,
        invoicee_type:   inv.invoicee?.customer?.type ?? null,
        invoicee_tl_id:  inv.invoicee?.customer?.id ?? null,
      };
    });

    const targetItem = items.find(it => it.id === targetTlId) || null;

    console.log('[tl-list-inspect]', JSON.stringify({
      department_id: departmentId,
      updated_since: updatedSince,
      target_tl_id: targetTlId,
      target_in_response: !!targetItem,
      count: items.length,
    }));

    return res.status(200).json({
      query: {
        department_id:  departmentId,
        updated_since:  updatedSince,
        target_tl_id:   targetTlId,
        page_size:      pageSize,
        page:           pageNumber,
      },
      tl_response: {
        count_returned: items.length,
        page_size:      pageSize,
        page:           pageNumber,
        // TL geeft geen total_records in v2 standaard; we tellen alleen returned.
        // Bij count_returned == page_size → mogelijk meer pagina's; herhaal met page=2.
      },
      target_in_response: !!targetItem,
      target_position:    targetItem ? targetItem.index : null,
      target_item:        targetItem,
      items,
      departments_in_cron: CRON_DEPARTMENTS,
      cron_filter_note:
        'cron-finance-sync.js gebruikt sort=invoice_date asc en updated_since uit ' +
        'sync_state.invoices.last_updated_since. Cursor schuift vooruit op ' +
        'max(record.updated_at) van verwerkte records. Als TL invoice.updated_at ' +
        'NIET bumpt bij payment-registratie, ziet de cron de paid-mutation nooit.',
    });
  } catch (e) {
    console.error('[finance-invoice-tl-list-inspect]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
