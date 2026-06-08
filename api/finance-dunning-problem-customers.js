// api/finance-dunning-problem-customers.js
// GET -> klanten met 2+ openstaande facturen ("probleemklanten").
// Permission: finance.dunning.view.
//
// Strategie: 1 query op invoices met joined customer, client-side aggregeren per customer_id.
// has_active_run komt uit een aparte query op dunning_workflow_runs.
//
// Response: { items: [{ customer_id, name, email, open_invoice_count,
//                       total_open_amount (cents), oldest_due_date, days_overdue_oldest,
//                       has_active_run }, ...] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dueDateMs(isoDate) {
  if (!isoDate) return null;
  const ymd = String(isoDate).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}
function openAmount(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}
function toCents(eur) { return Math.round((Number(eur) || 0) * 100); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    // 1) Pull all open invoices (status open/partially_paid/overdue) + joined customer.
    const { data: rows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select(`
        id, customer_id, amount_total, amount_paid, credited_amount, due_date, status,
        customers:customer_id ( id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at )
      `)
      .in('status', OPEN_STATUSES);
    if (invErr) throw new Error('invoices: ' + invErr.message);

    // 2) Aggregate per customer.
    const todayMs = todayMidnightMs();
    const perCustomer = new Map();
    for (const inv of rows || []) {
      const cust = inv.customers;
      if (!cust) continue;
      if (cust.archived_at || cust.anonymized_at) continue;

      const open = openAmount(inv);
      if (open <= 0) continue;

      const agg = perCustomer.get(inv.customer_id) || {
        customer: cust,
        open_invoice_count: 0,
        total_open_eur: 0,
        oldest_due_iso: null,
      };
      agg.open_invoice_count += 1;
      agg.total_open_eur     += open;
      if (inv.due_date) {
        const iso = String(inv.due_date).slice(0, 10);
        if (!agg.oldest_due_iso || iso < agg.oldest_due_iso) agg.oldest_due_iso = iso;
      }
      perCustomer.set(inv.customer_id, agg);
    }

    // 3) Filter: 2+ open invoices.
    const problems = [];
    for (const [customerId, agg] of perCustomer) {
      if (agg.open_invoice_count < 2) continue;
      const oldestMs = dueDateMs(agg.oldest_due_iso);
      let daysOverdue = 0;
      if (oldestMs != null && todayMs > oldestMs) {
        daysOverdue = Math.floor((todayMs - oldestMs) / 86400000);
      }
      problems.push({
        customer_id:           customerId,
        name:                  customerDisplayName(agg.customer, '(zonder naam)'),
        email:                 agg.customer.email || null,
        open_invoice_count:    agg.open_invoice_count,
        total_open_amount:     toCents(agg.total_open_eur),
        oldest_due_date:       agg.oldest_due_iso,
        days_overdue_oldest:   daysOverdue,
        has_active_run:        false,
      });
    }

    // 4) Map active-runs per customer (1 query).
    if (problems.length) {
      const ids = problems.map(p => p.customer_id);
      const { data: runs, error: runErr } = await supabaseAdmin
        .from('dunning_workflow_runs')
        .select('customer_id')
        .eq('status', 'active')
        .in('customer_id', ids);
      if (runErr) throw new Error('runs: ' + runErr.message);
      const activeSet = new Set((runs || []).map(r => r.customer_id));
      for (const p of problems) {
        if (activeSet.has(p.customer_id)) p.has_active_run = true;
      }
    }

    // 5) Sort by oldest overdue first.
    problems.sort((a, b) => (b.days_overdue_oldest - a.days_overdue_oldest));

    return res.status(200).json({ items: problems });
  } catch (e) {
    console.error('[finance-dunning-problem-customers]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
