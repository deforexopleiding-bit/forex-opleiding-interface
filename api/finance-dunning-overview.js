// api/finance-dunning-overview.js
// GET -> dashboard overview voor Wanbetalers-tab.
// Permission: finance.dunning.view.
//
// Aggregates:
//   - kpis.total_open_cents      : SUM open van invoices (status open/partially_paid/overdue)
//   - kpis.wanbetalers_count     : DISTINCT customers met overdue invoice
//   - kpis.problem_customers     : klanten met 2+ open invoices
//   - kpis.active_runs           : runs met status='active'
//   - kpis.completed_runs_30d    : runs met status='completed' en completed_at >= today-30d
//
// Lists:
//   - active_runs   : tot 50 lopende runs incl. customer + workflow + step-info + open-invoices agg
//   - recent_events : tot 20 meest recente dunning_log entries incl. customer + step + workflow

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function todayIso() { return new Date().toISOString().slice(0, 10); }
function nowMs()    { return Date.now(); }
function toCents(eur) { return Math.round((Number(eur) || 0) * 100); }
function openAmount(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}

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
    const td = todayIso();
    const thirtyDaysAgoIso = new Date(nowMs() - 30 * 86400000).toISOString();

    // ---- 1) Open invoices: alles in 1 query, client-side aggregeren ----
    const { data: openRows, error: openErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, amount_total, amount_paid, credited_amount, due_date, status')
      .in('status', OPEN_STATUSES);
    if (openErr) throw new Error('open invoices: ' + openErr.message);

    let totalOpenEur = 0;
    const wanbetalerSet = new Set();
    const perCustomerCount = new Map();
    for (const inv of openRows || []) {
      const open = openAmount(inv);
      if (open <= 0) continue;
      totalOpenEur += open;

      const isOverdue =
        inv.status === 'overdue' ||
        (['open', 'partially_paid'].includes(inv.status) && inv.due_date && String(inv.due_date).slice(0, 10) < td);
      if (isOverdue && inv.customer_id) wanbetalerSet.add(inv.customer_id);

      if (inv.customer_id) {
        perCustomerCount.set(inv.customer_id, (perCustomerCount.get(inv.customer_id) || 0) + 1);
      }
    }
    let problemCustomers = 0;
    for (const cnt of perCustomerCount.values()) if (cnt >= 2) problemCustomers++;

    // ---- 2) Runs KPIs ----
    const { count: activeRunsCount, error: arErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');
    if (arErr) throw new Error('active runs count: ' + arErr.message);

    const { count: completed30d, error: c30Err } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', thirtyDaysAgoIso);
    if (c30Err) throw new Error('completed 30d: ' + c30Err.message);

    // ---- 3) Active runs list (limit 50) ----
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select(`
        id, workflow_id, customer_id, status, current_step_id, next_action_at,
        started_at, trigger_invoice_count, updated_at,
        customers:customer_id ( id, first_name, last_name, company_name, is_company, email ),
        dunning_workflows:workflow_id ( id, name ),
        dunning_workflow_steps:current_step_id ( id, step_order, step_type )
      `)
      .eq('status', 'active')
      .order('next_action_at', { ascending: true, nullsFirst: true })
      .limit(50);
    if (runsErr) throw new Error('active runs list: ' + runsErr.message);

    // Per active-run: aggregate open invoices voor die customer.
    const activeRunCustomerIds = Array.from(new Set((runs || []).map(r => r.customer_id).filter(Boolean)));
    const perRunOpenCount = new Map();
    const perRunOpenEur   = new Map();
    if (activeRunCustomerIds.length) {
      const { data: runInvs, error: riErr } = await supabaseAdmin
        .from('invoices')
        .select('customer_id, amount_total, amount_paid, credited_amount, status')
        .in('customer_id', activeRunCustomerIds)
        .in('status', OPEN_STATUSES);
      if (riErr) throw new Error('runs invoices: ' + riErr.message);
      for (const inv of runInvs || []) {
        const open = openAmount(inv);
        if (open <= 0) continue;
        perRunOpenCount.set(inv.customer_id, (perRunOpenCount.get(inv.customer_id) || 0) + 1);
        perRunOpenEur.set(inv.customer_id, (perRunOpenEur.get(inv.customer_id) || 0) + open);
      }
    }

    const activeRunsList = (runs || []).map(r => ({
      id:               r.id,
      workflow_id:      r.workflow_id,
      workflow_name:    r.dunning_workflows?.name || null,
      customer_id:      r.customer_id,
      customer_name:    customerDisplayName(r.customers, '(zonder naam)'),
      customer_email:   r.customers?.email || null,
      current_step_id:   r.current_step_id,
      current_step_order: r.dunning_workflow_steps?.step_order ?? null,
      current_step_type:  r.dunning_workflow_steps?.step_type  ?? null,
      next_action_at:   r.next_action_at,
      started_at:       r.started_at,
      open_invoice_count:    perRunOpenCount.get(r.customer_id) || 0,
      open_invoice_total_cents: toCents(perRunOpenEur.get(r.customer_id) || 0),
    }));

    // ---- 4) Recent events (limit 20) ----
    const { data: events, error: evErr } = await supabaseAdmin
      .from('dunning_log')
      .select(`
        id, run_id, step_id, event_type, payload, created_at,
        dunning_workflow_runs:run_id (
          id, customer_id, workflow_id,
          customers:customer_id ( id, first_name, last_name, company_name, is_company ),
          dunning_workflows:workflow_id ( id, name )
        ),
        dunning_workflow_steps:step_id ( id, step_type, step_order )
      `)
      .order('created_at', { ascending: false })
      .limit(20);
    if (evErr) throw new Error('recent events: ' + evErr.message);

    const recentEvents = (events || []).map(ev => {
      const run = ev.dunning_workflow_runs;
      const cust = run?.customers || null;
      const wf   = run?.dunning_workflows || null;
      const step = ev.dunning_workflow_steps || null;
      return {
        id:             ev.id,
        run_id:         ev.run_id,
        customer_id:    run?.customer_id || null,
        customer_name:  customerDisplayName(cust, '(onbekend)'),
        workflow_name:  wf?.name || null,
        event_type:     ev.event_type,
        step_type:      step?.step_type  ?? null,
        step_order:     step?.step_order ?? null,
        payload:        ev.payload || {},
        created_at:     ev.created_at,
      };
    });

    return res.status(200).json({
      kpis: {
        total_open_cents:     toCents(totalOpenEur),
        wanbetalers_count:    wanbetalerSet.size,
        problem_customers:    problemCustomers,
        active_runs:          activeRunsCount || 0,
        completed_runs_30d:   completed30d   || 0,
      },
      active_runs:   activeRunsList,
      recent_events: recentEvents,
    });
  } catch (e) {
    console.error('[finance-dunning-overview]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
