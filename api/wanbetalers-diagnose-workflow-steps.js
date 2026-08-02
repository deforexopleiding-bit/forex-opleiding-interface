// api/wanbetalers-diagnose-workflow-steps.js
//
// GET ?run_id=<uuid> → alle steps van de workflow waaraan de run hangt.
// Read-only helper voor de verplaats-tool: vult de doel-stap-dropdown.
// Super_admin only.
//
// Response:
// {
//   ok: true,
//   run_id, workflow_id, workflow_name, current_step_id,
//   steps: [ { id, step_order, step_type, config_title, risk } ]
// }

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_STEPS = new Set(['email','whatsapp']);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const admin = await verifyAdmin(req);
  if (!admin)                            return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (admin.profile?.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin.' });

  const runId = String(req.query?.run_id || '').trim();
  if (!runId || !UUID_RE.test(runId)) return res.status(400).json({ error: 'run_id (uuid) vereist' });

  try {
    const { data: run } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, workflow_id, current_step_id')
      .eq('id', runId)
      .maybeSingle();
    if (!run) return res.status(404).json({ error: 'Run niet gevonden' });

    const { data: wf } = await supabaseAdmin
      .from('dunning_workflows')
      .select('id, name')
      .eq('id', run.workflow_id)
      .maybeSingle();

    const { data: steps } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, step_type, step_order, config')
      .eq('workflow_id', run.workflow_id)
      .order('step_order', { ascending: true });

    return res.status(200).json({
      ok:              true,
      run_id:          run.id,
      workflow_id:     run.workflow_id,
      workflow_name:   wf?.name || null,
      current_step_id: run.current_step_id,
      steps: (steps || []).map((s) => ({
        id:           s.id,
        step_order:   s.step_order,
        step_type:    s.step_type,
        config_title: s.config?.title || null,
        risk:         SEND_STEPS.has(String(s.step_type || '').toLowerCase()) ? 'risky' : 'safe',
      })),
    });
  } catch (e) {
    console.error('[verplaats-tool workflow-steps]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
