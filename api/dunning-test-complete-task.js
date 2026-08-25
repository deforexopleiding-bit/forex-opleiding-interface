// POST /api/dunning-test-complete-task
//
// Sluit een pending_action (status → EXECUTED, executed_at → now).
//
// Body: { customer_id: uuid, task_id?: uuid, task_type?: string }
//   - task_id gegeven → sluit die specifieke rij (na is_test-check op customer).
//   - task_id ontbreekt → sluit de OUDSTE open PENDING/APPROVED rij van
//     eventueel gegeven task_type, anders het oudste van elk type.
//
// Weigert non-test-customer (400).

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'complete_test_task',
      scope:        'test',
      target: target || {}, payload: payload || {}, result: result || {},
      status, error_message: error || null,
    });
  } catch (e) { console.error('[dunning-test-complete-task] audit fail:', e?.message || e); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;
  const actor = { userId: admin.user.id, email: admin.profile.email };

  const body = req.body || {};
  const customerId = body.customer_id;
  const taskId     = body.task_id || null;
  const taskType   = body.task_type ? String(body.task_type).trim() : null;

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });

  // is_test-guard.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers').select('id, is_test').eq('id', customerId).maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!cust.is_test) return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering.' });

  let target;
  if (taskId) {
    const { data: t, error: tErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, action_type, status, customer_id')
      .eq('id', taskId).maybeSingle();
    if (tErr) return res.status(500).json({ error: 'task lookup: ' + tErr.message });
    if (!t) return res.status(404).json({ error: 'Task niet gevonden.' });
    if (t.customer_id !== customerId) return res.status(400).json({ error: 'Task hoort niet bij deze customer.' });
    target = t;
  } else {
    let q = supabaseAdmin.from('pending_actions')
      .select('id, action_type, status')
      .eq('customer_id', customerId)
      .in('status', ['PENDING', 'APPROVED'])
      .order('created_at', { ascending: true })
      .limit(1);
    if (taskType) q = q.eq('action_type', taskType);
    const { data: rows, error: qErr } = await q;
    if (qErr) return res.status(500).json({ error: 'task fetch: ' + qErr.message });
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: `Geen open taak gevonden voor deze customer${taskType ? ` (type=${taskType})` : ''}.` });
    }
    target = rows[0];
  }

  const nowIso = new Date().toISOString();
  const { error: uErr } = await supabaseAdmin
    .from('pending_actions')
    .update({ status: 'EXECUTED', executed_at: nowIso, updated_at: nowIso })
    .eq('id', target.id)
    .in('status', ['PENDING', 'APPROVED']);

  if (uErr) {
    await audit({ actor, target: { customer_id: customerId, task_id: target.id }, status: 'error', error: uErr.message });
    return res.status(500).json({ error: uErr.message });
  }

  await audit({
    actor,
    target: { customer_id: customerId, task_id: target.id },
    payload: { requested_task_id: taskId, requested_task_type: taskType },
    result: { closed_task_id: target.id, action_type: target.action_type },
    status: 'ok',
  });

  return res.status(200).json({ ok: true, closed_task_id: target.id, action_type: target.action_type });
}
