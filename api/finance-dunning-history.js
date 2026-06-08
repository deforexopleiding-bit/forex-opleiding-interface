// api/finance-dunning-history.js
// GET -> paginated dunning_log history voor de Wanbetalers-tab.
// Permission: finance.dunning.view.
//
// Query-params:
//   limit       (default 50, clamp 1..200)
//   offset      (default 0)
//   customer_id (uuid filter — via embedded run.customer_id)
//   event_type  (text exact-match)
//   from_date   (ISO timestamp, gte op created_at)
//
// Response: { items: [...], total, has_more }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
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

  const q          = req.query || {};
  const limit      = clampInt(q.limit, 50, 1, 200);
  const offset     = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));
  const customerId = q.customer_id ? String(q.customer_id) : null;
  const eventType  = q.event_type  ? String(q.event_type)  : null;
  const fromDate   = q.from_date   ? String(q.from_date)   : null;

  try {
    // PostgREST embedded filter: customer_id zit op dunning_workflow_runs.
    // Voor exact-equal customer filter gebruiken we 'dunning_workflow_runs.customer_id'.
    let query = supabaseAdmin
      .from('dunning_log')
      .select(`
        id, run_id, step_id, event_type, payload, created_at,
        dunning_workflow_runs:run_id (
          id, customer_id, workflow_id,
          customers:customer_id ( id, first_name, last_name, company_name, is_company ),
          dunning_workflows:workflow_id ( id, name )
        ),
        dunning_workflow_steps:step_id ( id, step_type, step_order )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (eventType)  query = query.eq('event_type', eventType);
    if (fromDate)   query = query.gte('created_at', fromDate);
    if (customerId) query = query.eq('dunning_workflow_runs.customer_id', customerId);

    const { data: rows, error, count } = await query;
    if (error) throw new Error('history: ' + error.message);

    let items = (rows || []).map(ev => {
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
        step_type:      step?.step_type ?? null,
        payload:        ev.payload || {},
        created_at:     ev.created_at,
      };
    });

    // Bij customer_id-filter via embedded resource: PostgREST geeft rows door waarvan
    // de embed null is. Filter hier nogmaals client-side om consistentie te garanderen.
    if (customerId) items = items.filter(it => it.customer_id === customerId);

    const total    = typeof count === 'number' ? count : items.length;
    const has_more = (offset + items.length) < total;

    return res.status(200).json({ items, total, has_more });
  } catch (e) {
    console.error('[finance-dunning-history]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
