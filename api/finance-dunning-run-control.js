// api/finance-dunning-run-control.js
// POST -> pauzeer / hervat / annuleer een lopende dunning_workflow_run.
// Permission: finance.dunning.execute.
//
// Body: { run_id: uuid, action: 'pause' | 'resume' | 'cancel' }
//
// State-transitions:
//   - pause  : active   -> paused      (updated_at = now)
//   - resume : paused   -> active      (next_action_at = now, updated_at = now)
//   - cancel : active|paused -> cancelled  (completed_at = now, completion_reason = manual_cancel_by_user)
//
// Schrijft naar dunning_log + audit_log voor traceability.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const VALID_ACTIONS = ['pause', 'resume', 'cancel'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body   = req.body || {};
  const runId  = body.run_id || null;
  const action = body.action || null;

  if (!runId)  return res.status(400).json({ error: 'run_id vereist' });
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `Ongeldige action; verwacht ${VALID_ACTIONS.join('|')}` });
  }

  try {
    const { data: run, error: lookupErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, status, workflow_id, customer_id, current_step_id, next_action_at, started_at, completed_at, completion_reason, updated_at')
      .eq('id', runId)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!run) return res.status(404).json({ error: 'Run niet gevonden' });

    const beforeStatus = run.status;
    const nowIso = new Date().toISOString();
    const update = { updated_at: nowIso };
    let afterStatus = beforeStatus;

    if (action === 'pause') {
      if (run.status !== 'active') {
        return res.status(409).json({ error: `pause kan alleen vanuit active (huidig: ${run.status})` });
      }
      update.status = 'paused';
      afterStatus   = 'paused';
    } else if (action === 'resume') {
      if (run.status !== 'paused') {
        return res.status(409).json({ error: `resume kan alleen vanuit paused (huidig: ${run.status})` });
      }
      update.status = 'active';
      update.next_action_at = nowIso;
      afterStatus   = 'active';
    } else if (action === 'cancel') {
      if (!['active', 'paused'].includes(run.status)) {
        return res.status(409).json({ error: `cancel kan alleen vanuit active|paused (huidig: ${run.status})` });
      }
      update.status            = 'cancelled';
      update.completed_at      = nowIso;
      update.completion_reason = 'manual_cancel_by_user';
      afterStatus              = 'cancelled';
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update(update)
      .eq('id', runId)
      .select('id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, completed_at, completion_reason, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // dunning_log entry (informatief, falen mag niet de actie breken).
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id:     runId,
        step_id:    run.current_step_id || null,
        event_type: `run_control_${action}`,
        payload: {
          action,
          user_id:       user.id,
          before_status: beforeStatus,
          after_status:  afterStatus,
        },
      });
    } catch (e) { console.error('[dunning-run-control log]', e.message); }

    // audit_log entry (Fase 2A.3+ schema).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      `finance_dunning_run.${action}`,
        entity_type: 'dunning_workflow_run',
        entity_id:   runId,
        after_json:  { action },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[dunning-run-control audit]', e.message); }

    return res.status(200).json({ success: true, run: updated });
  } catch (e) {
    console.error('[finance-dunning-run-control]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
