import { supabase } from './supabase.js';
import { executeAgentTool } from './agent-tool-executor.js';
import { requirePermission } from './_lib/requirePermission.js';

// ── Interne audit-helper ───────────────────────────────────────────────────

async function logAudit({ agent_name = 'system', action, payload = {}, result = {}, status, error_message = null, approval_id = null, triggered_by = 'system' }) {
  const { error } = await supabase.from('agent_audit_log').insert({
    agent_name, action, payload, result, status,
    error_message: error_message || null,
    approval_id:   approval_id  || null,
    triggered_by:  triggered_by || 'system',
    created_at:    new Date().toISOString(),
  });
  if (error) console.error('[agent-approval] audit insert fout:', error.message);
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Security H1 — RBAC-gate. Skip als de cron-wrapper (agent-expire-approvals.js)
  // ons aanroept: die zet req.__cronAuthed = true na een geldige checkCronAuth.
  // Zo blijft de HTTP-route beschermd zonder de cron te breken.
  if (!req.__cronAuthed) {
    const allowed = await requirePermission(req, 'agents.approval.act');
    if (!allowed) return res.status(403).json({ error: 'Geen rechten (agents.approval.act)' });
  }

  // GET actions via query params
  const action = req.method === 'GET'
    ? (req.query?.action || '')
    : (req.body?.action  || '');

  // ── list ────────────────────────────────────────────────────────────────
  if (action === 'list' || (req.method === 'GET' && !action)) {
    const { data: pending, error } = await supabase
      .from('agent_approval_queue')
      .select('id, agent_name, action, payload, description, status, created_at, expires_at, approved_by, rejected_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });

    const count_by_agent = {};
    for (const item of (pending || [])) {
      count_by_agent[item.agent_name] = (count_by_agent[item.agent_name] || 0) + 1;
    }

    return res.status(200).json({
      pending:       pending || [],
      count_total:   (pending || []).length,
      count_by_agent,
    });
  }

  // ── get_detail ──────────────────────────────────────────────────────────
  if (action === 'get_detail') {
    const approval_id = req.query?.approval_id || req.body?.approval_id;
    if (!approval_id) return res.status(400).json({ error: 'approval_id is verplicht' });
    const { data, error } = await supabase
      .from('agent_approval_queue').select('*').eq('id', approval_id).single();
    if (error || !data) return res.status(404).json({ error: 'Approval niet gevonden' });
    return res.status(200).json({ approval: data });
  }

  // ── expire_pending (cron) ───────────────────────────────────────────────
  if (action === 'expire_pending') {
    const { data: expired, error } = await supabase
      .from('agent_approval_queue')
      .select('id, agent_name, action')
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());
    if (error) return res.status(500).json({ error: error.message });

    let expiredCount = 0;
    for (const item of (expired || [])) {
      const { error: updErr } = await supabase
        .from('agent_approval_queue')
        .update({ status: 'expired' }).eq('id', item.id);
      if (updErr) { console.error('[agent-approval] expire fout:', updErr.message); continue; }
      await logAudit({ agent_name: item.agent_name, action: 'approval_expired',
        payload: { approval_id: item.id, action: item.action }, status: 'success', approval_id: item.id, triggered_by: 'cron' });
      expiredCount++;
    }
    return res.status(200).json({ ok: true, expired_count: expiredCount });
  }

  // ── POST-only actions ───────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { agent_name, action_type, title, description, preview_data, meeting_id,
          expires_in_hours, approval_id, approved_item_indices, decided_by, comment,
          rejection_reason } = req.body || {};

  // ── create ──────────────────────────────────────────────────────────────
  if (action === 'create') {
    if (!agent_name || !action_type) return res.status(400).json({ error: 'agent_name en action_type zijn verplicht' });

    const expiresAt = new Date(Date.now() + (Number(expires_in_hours) || 168) * 3600000).toISOString();
    const { data, error } = await supabase.from('agent_approval_queue').insert({
      agent_name,
      action:       action_type,
      payload:      { title: title || action_type, preview_data: preview_data || [] },
      description:  description || null,
      requested_by: 'agent',
      status:       'pending',
      meeting_id:   meeting_id || null,
      created_at:   new Date().toISOString(),
      expires_at:   expiresAt,
    }).select('id').single();

    if (error) return res.status(500).json({ error: error.message });

    console.log(`[agent-approval] aangemaakt: ${data.id} (${agent_name} / ${action_type})`);
    return res.status(200).json({ ok: true, approval_id: data.id });
  }

  // ── approve ─────────────────────────────────────────────────────────────
  if (action === 'approve') {
    if (!approval_id) return res.status(400).json({ error: 'approval_id is verplicht' });
    if (!decided_by)  return res.status(400).json({ error: 'decided_by is verplicht' });

    // Haal approval op
    const { data: ap, error: fetchErr } = await supabase
      .from('agent_approval_queue').select('*').eq('id', approval_id).single();
    if (fetchErr || !ap) return res.status(404).json({ error: 'Approval niet gevonden' });
    if (ap.status !== 'pending') return res.status(400).json({ error: `Approval heeft status '${ap.status}' — alleen pending kan worden goedgekeurd` });

    // Update status
    const { error: updErr } = await supabase.from('agent_approval_queue').update({
      status:      'approved',
      approved_by: decided_by,
      approved_at: new Date().toISOString(),
    }).eq('id', approval_id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    // Bepaal welke items uitvoeren
    const items = ap.payload?.preview_data || [];
    let indices;
    if (approved_item_indices === null || approved_item_indices === undefined) {
      indices = items.length > 0 ? items.map((_, i) => i) : [null]; // null = single-item approval
    } else {
      indices = Array.isArray(approved_item_indices) ? approved_item_indices : [approved_item_indices];
    }

    // Voer uit per goedgekeurd item
    let executed = 0;
    let failed   = 0;
    const errors = [];
    const taskIds = [];

    for (const idx of indices) {
      const itemPayload = idx === null ? ap.payload : (items[idx] || {});
      try {
        const result = await executeAgentTool(ap.action, itemPayload, decided_by, approval_id);
        executed++;
        if (result?.task_id)    taskIds.push(result.task_id);
        if (result?.meeting_id) taskIds.push(result.meeting_id);
        if (result?.decision_id) taskIds.push(result.decision_id);
      } catch (execErr) {
        failed++;
        const msg = `item ${idx}: ${execErr.message}`;
        errors.push(msg);
        console.error('[agent-approval] approve uitvoering fout:', msg);
      }
    }

    await logAudit({
      agent_name: ap.agent_name, action: `approved:${ap.action}`,
      payload: { approval_id, decided_by, comment: comment || null, indices },
      result: { executed, failed, errors },
      status: failed === indices.length ? 'error' : 'success',
      approval_id, triggered_by: decided_by,
    });

    console.log(`[agent-approval] approve ${approval_id}: executed=${executed}, failed=${failed}`);
    return res.status(200).json({
      ok:       failed < indices.length,
      executed,
      failed,
      task_ids: taskIds.length ? taskIds : undefined,
      errors:   errors.length  ? errors  : undefined,
    });
  }

  // ── reject ──────────────────────────────────────────────────────────────
  if (action === 'reject') {
    if (!approval_id) return res.status(400).json({ error: 'approval_id is verplicht' });

    const { data: ap, error: fetchErr } = await supabase
      .from('agent_approval_queue').select('agent_name, action, status').eq('id', approval_id).single();
    if (fetchErr || !ap) return res.status(404).json({ error: 'Approval niet gevonden' });
    if (ap.status !== 'pending') return res.status(400).json({ error: `Approval heeft al status '${ap.status}'` });

    const { error: updErr } = await supabase.from('agent_approval_queue').update({
      status:       'rejected',
      rejected_at:  new Date().toISOString(),
      reject_reason: rejection_reason || null,
      approved_by:  decided_by || null,
    }).eq('id', approval_id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    await logAudit({
      agent_name: ap.agent_name, action: `rejected:${ap.action}`,
      payload: { approval_id, rejection_reason: rejection_reason || null, decided_by },
      status: 'success', approval_id, triggered_by: decided_by || 'jeffrey',
    });

    console.log(`[agent-approval] reject ${approval_id}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: `Onbekende action: "${action}"` });
}
