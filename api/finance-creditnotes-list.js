// api/finance-creditnotes-list.js
// GET → lijst van alle creditnota's uit de gespiegelde `credit_notes`-tabel.
// Permission: finance.invoice.view (zelfde als facturen; read-only).
//
// Query:
//   q?           zoek op credit_note_number of klantnaam (first/last/company).
//   period_start? / period_end?  op credit_note_date (yyyy-mm-dd).
//   entity?      department_id (tl-afdeling).
//   sort?        credit_note_date | credit_note_number | amount_total | status
//                (default 'credit_note_date').
//   dir?         asc | desc  (default 'desc').
//   page?        1-based, default 1.
//   page_size?   default 50, max 500.
//
// Response:
//   {
//     items: [{
//       id, credit_note_number, credit_note_date,
//       amount_total, status,
//       invoice_id, invoice_number,
//       customer_id, customer_name,
//       department_id,
//     }],
//     kpi: { count, sum_amount },  // scope = KPI zonder pagination (met filters)
//     page, page_size, total,
//   }
//
// Read-only. Geen writes, geen TL-calls. Batching via PostgREST join
// `invoice:invoices(...,customer:customers(...))` — 1 round-trip, geen N+1.
// Creditnota's zonder invoice_id: customer/invoice_number blijven '—'.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const VALID_SORT = ['credit_note_date', 'credit_note_number', 'amount_total', 'status'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });
  }

  const q = req.query || {};
  const search      = q.q ? String(q.q).trim() : null;
  const entity      = q.entity ? String(q.entity) : null;
  const periodStart = q.period_start ? String(q.period_start).slice(0, 10) : null;
  const periodEnd   = q.period_end   ? String(q.period_end).slice(0, 10)   : null;
  const sortField   = VALID_SORT.includes(q.sort) ? q.sort : 'credit_note_date';
  const dir         = q.dir === 'asc' ? 'asc' : 'desc';
  const page        = Math.max(1, Number(q.page) || 1);
  const pageSize    = Math.min(Math.max(Number(q.page_size) || 50, 1), 500);

  try {
    // Bij zoekterm eerst matching customer-ids ophalen zodat we credit_notes
    // via de invoice→customer chain kunnen filteren. TL koppelt creditnota
    // rechtstreeks aan invoice (invoice_id op onze tabel); customer zit alleen
    // via die invoice. We combineren OR:
    //   credit_note_number.ilike.%s%  OF  invoice_id.in.(<inv-ids die aan
    //   gematchte customers hangen>).
    let matchedCustIds = [];
    let matchedInvIds  = [];
    if (search) {
      const s = search.replace(/[,()]/g, ' ').trim();
      if (s) {
        // Klant-matches.
        const { data: custMatch } = await supabaseAdmin
          .from('customers')
          .select('id')
          .or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company_name.ilike.%${s}%`)
          .limit(500);
        matchedCustIds = (custMatch || []).map(c => c.id);
        if (matchedCustIds.length > 0) {
          const { data: invMatch } = await supabaseAdmin
            .from('invoices')
            .select('id')
            .in('customer_id', matchedCustIds)
            .limit(5000);
          matchedInvIds = (invMatch || []).map(i => i.id);
        }
      }
    }

    const selectCols = `
      id, credit_note_number, credit_note_date, amount_total, status,
      invoice_id, tl_invoice_id, department_id,
      invoice:invoices(
        invoice_number, customer_id, tl_department_id,
        customer:customers(is_company, company_name, first_name, last_name)
      )
    `;

    // Lijst-query (met filters + pagination + sort).
    let lq = supabaseAdmin
      .from('credit_notes')
      .select(selectCols, { count: 'exact' });
    if (entity)      lq = lq.eq('department_id', entity);
    if (periodStart) lq = lq.gte('credit_note_date', periodStart);
    if (periodEnd)   lq = lq.lte('credit_note_date', periodEnd);
    if (search) {
      const s = search.replace(/[,()]/g, ' ').trim();
      const ors = [`credit_note_number.ilike.%${s}%`];
      if (matchedInvIds.length > 0) ors.push(`invoice_id.in.(${matchedInvIds.join(',')})`);
      lq = lq.or(ors.join(','));
    }
    lq = lq.order(sortField, { ascending: dir === 'asc', nullsFirst: false })
           .range((page - 1) * pageSize, page * pageSize - 1);

    const { data: rows, count, error: listErr } = await lq;
    if (listErr) throw new Error('lijst-query: ' + listErr.message);

    // KPI-query: aantal + totaal binnen dezelfde filter-scope, zonder pagination.
    let kq = supabaseAdmin
      .from('credit_notes')
      .select('amount_total, invoice_id', { count: 'exact' })
      .limit(20000);
    if (entity)      kq = kq.eq('department_id', entity);
    if (periodStart) kq = kq.gte('credit_note_date', periodStart);
    if (periodEnd)   kq = kq.lte('credit_note_date', periodEnd);
    if (search) {
      const s = search.replace(/[,()]/g, ' ').trim();
      const ors = [`credit_note_number.ilike.%${s}%`];
      if (matchedInvIds.length > 0) ors.push(`invoice_id.in.(${matchedInvIds.join(',')})`);
      kq = kq.or(ors.join(','));
    }
    const { data: kpiRows, error: kpiErr } = await kq;
    if (kpiErr) throw new Error('kpi-query: ' + kpiErr.message);

    let sumAmount = 0;
    for (const c of kpiRows || []) sumAmount += Number(c.amount_total) || 0;

    const items = (rows || []).map((c) => {
      const inv  = c.invoice || null;
      const cust = inv?.customer || null;
      return {
        id                : c.id,
        credit_note_number: c.credit_note_number,
        credit_note_date  : c.credit_note_date,
        amount_total      : r2(c.amount_total),
        status            : c.status,
        invoice_id        : c.invoice_id,
        invoice_number    : inv?.invoice_number || null,
        customer_id       : inv?.customer_id || null,
        customer_name     : cust ? customerDisplayName(cust, '—') : '—',
        department_id     : c.department_id || inv?.tl_department_id || null,
      };
    });

    return res.status(200).json({
      items,
      kpi: {
        count      : count || 0,
        sum_amount : r2(sumAmount),
      },
      page,
      page_size: pageSize,
      total    : count || 0,
    });
  } catch (e) {
    console.error('[finance-creditnotes-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
