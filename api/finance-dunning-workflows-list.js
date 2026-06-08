// api/finance-dunning-workflows-list.js
// GET -> lijst dunning_workflows met afgeleide tellers (step_count, active_run_count).
// Optional filter: ?active=true|false.
// Permission: finance.dunning.view (lezen mag ruimer dan beheren).
//
// Response: { items: [{ id, name, description, is_active, priority, trigger_conditions,
//                       step_count, active_run_count, created_at, updated_at }] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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

  const q = req.query || {};
  let activeFilter = null;
  if (q.active === 'true')  activeFilter = true;
  if (q.active === 'false') activeFilter = false;

  try {
    let query = supabaseAdmin
      .from('dunning_workflows')
      .select('id, name, description, is_active, priority, trigger_conditions, created_at, updated_at')
      .order('priority', { ascending: true })
      .order('name',     { ascending: true });
    if (activeFilter !== null) query = query.eq('is_active', activeFilter);

    const { data: workflows, error } = await query;
    if (error) throw new Error(error.message);

    const rows = workflows || [];
    const ids = rows.map(r => r.id);

    // Default tellers op 0; ook bij lege lijst veilig.
    const stepCounts = new Map(ids.map(id => [id, 0]));
    const activeRunCounts = new Map(ids.map(id => [id, 0]));

    if (ids.length) {
      // Steps: haal workflow_id van alle steps en tel client-side.
      // Aantal step-rows is laag (per workflow paar stappen), dus dit is goedkoop.
      const { data: stepRows, error: stepErr } = await supabaseAdmin
        .from('dunning_workflow_steps')
        .select('workflow_id')
        .in('workflow_id', ids);
      if (stepErr) throw new Error('steps: ' + stepErr.message);
      for (const s of (stepRows || [])) {
        stepCounts.set(s.workflow_id, (stepCounts.get(s.workflow_id) || 0) + 1);
      }

      // Active runs: filter op status='active'.
      const { data: runRows, error: runErr } = await supabaseAdmin
        .from('dunning_workflow_runs')
        .select('workflow_id')
        .in('workflow_id', ids)
        .eq('status', 'active');
      if (runErr) throw new Error('runs: ' + runErr.message);
      for (const r of (runRows || [])) {
        activeRunCounts.set(r.workflow_id, (activeRunCounts.get(r.workflow_id) || 0) + 1);
      }
    }

    const items = rows.map(r => ({
      ...r,
      step_count:       stepCounts.get(r.id) || 0,
      active_run_count: activeRunCounts.get(r.id) || 0,
    }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[finance-dunning-workflows-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
