// api/finance-invoices.js
// GET → facturen-lijst + KPI-aggregaten uit de (gespiegelde) `invoices`-tabel.
// Permission: finance.invoice.view (super_admin + manager). Read-only.
//
// Query: customer_id?, status?, entity? (tl_department_id), period_start?, period_end?,
//        q? (nummer/klantnaam), sort? (issue_date|due_date|amount_total|status),
//        dir? (asc|desc), page?, page_size?
//
// Overdue wordt DYNAMISCH afgeleid (status='open' & due_date < vandaag) → display_status.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const today = () => new Date().toISOString().slice(0, 10);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function displayStatus(inv, td) {
  if (inv.status === 'open' && inv.due_date && inv.due_date < td) return 'overdue';
  return inv.status;
}

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
  const customerId = q.customer_id || null;
  const statusFilter = q.status || null;     // onze enum óf 'overdue' (virtueel)
  const entity = q.entity || null;           // tl_department_id
  const periodStart = q.period_start ? String(q.period_start).slice(0, 10) : null;
  const periodEnd = q.period_end ? String(q.period_end).slice(0, 10) : null;
  const search = q.q ? String(q.q).trim() : null;
  const sortField = ['issue_date', 'due_date', 'amount_total', 'status', 'invoice_number'].includes(q.sort) ? q.sort : 'issue_date';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(Math.max(Number(q.page_size) || 50, 1), 200);
  const td = today();

  try {
    // --- KPI-set: alle facturen binnen entity (+ klant indien meegegeven), zónder
    //     status/periode/zoek-filter, zodat KPI's stabiel blijven over filters heen.
    let kq = supabaseAdmin.from('invoices')
      .select('amount_total, amount_paid, status, issue_date, due_date, paid_date')
      .limit(20000);
    if (entity) kq = kq.eq('tl_department_id', entity);
    if (customerId) kq = kq.eq('customer_id', customerId);
    const { data: kpiRows, error: kpiErr } = await kq;
    if (kpiErr) throw new Error('kpi-query: ' + kpiErr.message);

    const monthStart = td.slice(0, 7) + '-01';
    let openTotal = 0, openCount = 0, overdueTotal = 0, overdueCount = 0;
    let payDays = 0, payN = 0, monthIn = 0, monthCount = 0;
    const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    for (const inv of kpiRows || []) {
      const outstanding = Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.amount_paid) || 0));
      const isOpen = inv.status === 'open' || inv.status === 'partially_paid';
      if (isOpen) { openTotal += outstanding; openCount++; }
      if (isOpen && inv.due_date && inv.due_date < td) { overdueTotal += outstanding; overdueCount++; }
      if (inv.paid_date && inv.issue_date && inv.paid_date >= cutoff90) {
        const days = Math.round((new Date(inv.paid_date) - new Date(inv.issue_date)) / 86400000);
        if (days >= 0) { payDays += days; payN++; }
      }
      if (inv.paid_date && inv.paid_date >= monthStart) { monthIn += (Number(inv.amount_paid) || 0); monthCount++; }
    }
    const kpis = {
      open_total: r2(openTotal), open_count: openCount,
      overdue_total: r2(overdueTotal), overdue_count: overdueCount,
      avg_pay_days: payN ? Math.round(payDays / payN) : null,
      month_in_total: r2(monthIn), month_in_count: monthCount,
    };

    // --- Lijst-query met filters.
    let lq = supabaseAdmin.from('invoices')
      .select('id, customer_id, tl_invoice_id, tl_department_id, invoice_number, amount_total, amount_paid, vat_amount, issue_date, due_date, paid_date, status, is_manual, customer:customers(is_company, company_name, first_name, last_name, email)', { count: 'exact' });
    if (entity) lq = lq.eq('tl_department_id', entity);
    if (customerId) lq = lq.eq('customer_id', customerId);
    if (periodStart) lq = lq.gte('issue_date', periodStart);
    if (periodEnd) lq = lq.lte('issue_date', periodEnd);
    if (statusFilter && statusFilter !== 'overdue') lq = lq.eq('status', statusFilter);
    if (statusFilter === 'overdue') lq = lq.eq('status', 'open').lt('due_date', td);
    if (search) lq = lq.ilike('invoice_number', `%${search}%`);

    lq = lq.order(sortField, { ascending: dir === 'asc' }).range((page - 1) * pageSize, page * pageSize - 1);
    const { data: rows, count, error: listErr } = await lq;
    if (listErr) throw new Error('lijst-query: ' + listErr.message);

    const items = (rows || []).map(inv => ({
      id: inv.id,
      tl_invoice_id: inv.tl_invoice_id,
      invoice_number: inv.invoice_number,
      customer_id: inv.customer_id,
      customer_name: inv.customer ? (customerDisplayName(inv.customer, '—')) : '—',
      customer_email: inv.customer?.email || null,
      amount_total: Number(inv.amount_total) || 0,
      amount_paid: Number(inv.amount_paid) || 0,
      amount_open: r2(Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.amount_paid) || 0))),
      vat_amount: inv.vat_amount != null ? Number(inv.vat_amount) : null,
      issue_date: inv.issue_date,
      due_date: inv.due_date,
      paid_date: inv.paid_date,
      status: inv.status,
      display_status: displayStatus(inv, td),
      is_manual: inv.is_manual,
      tl_department_id: inv.tl_department_id,
    }));

    return res.status(200).json({ items, kpis, page, page_size: pageSize, total: count || 0 });
  } catch (e) {
    console.error('[finance-invoices]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
