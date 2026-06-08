// api/finance-dunning-workflows-detail.js
// GET ?id=<uuid> -> detail van een workflow incl. steps (ORDER BY step_order ASC).
// Permission: finance.dunning.view.
//
// Response: { workflow: {...alle velden...},
//             steps:    [{ id, step_order, step_type, config, created_at }, ...] }
// 404 als workflow niet bestaat.

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

  const id = req.query?.id || null;
  if (!id) return res.status(400).json({ error: 'id query-param vereist' });

  try {
    const { data: workflow, error: wfErr } = await supabaseAdmin
      .from('dunning_workflows')
      .select('id, name, description, is_active, priority, trigger_conditions, created_by_user_id, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (wfErr) throw new Error('workflow lookup: ' + wfErr.message);
    if (!workflow) return res.status(404).json({ error: 'Workflow niet gevonden' });

    const { data: steps, error: stepErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, step_order, step_type, config, created_at')
      .eq('workflow_id', id)
      .order('step_order', { ascending: true });
    if (stepErr) throw new Error('steps lookup: ' + stepErr.message);

    return res.status(200).json({ workflow, steps: steps || [] });
  } catch (e) {
    console.error('[finance-dunning-workflows-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
