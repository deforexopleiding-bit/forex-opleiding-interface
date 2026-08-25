// POST /api/dunning-test-create-task
//
// Insert een handmatige pending_action op een is_test-customer, met een
// whitelisted action_type. Weigert non-test-klant en niet-whitelisted type.
//
// Body: { customer_id: uuid, task_type: 'MANUAL_FOLLOWUP' | 'MANUAL_VERIFY_PAYMENT' | 'MANUAL_ESCALATION' }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

const ALLOWED_TASK_TYPES = new Set([
  'MANUAL_FOLLOWUP',
  'MANUAL_VERIFY_PAYMENT',
  'MANUAL_ESCALATION',
]);

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'create_test_task',
      scope:        'test',
      target: target || {},
      payload: payload || {},
      result:  result || {},
      status,
      error_message: error || null,
    });
  } catch (e) { console.error('[dunning-test-create-task] audit fail:', e?.message || e); }
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
  const taskType   = String(body.task_type || '').trim();

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });
  if (!ALLOWED_TASK_TYPES.has(taskType)) {
    return res.status(400).json({
      error: `task_type '${taskType}' niet toegestaan. Kies uit: ${Array.from(ALLOWED_TASK_TYPES).join(', ')}.`,
    });
  }

  // is_test-guard.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers').select('id, is_test').eq('id', customerId).maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!cust.is_test) return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering.' });

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('pending_actions')
    .insert({
      customer_id:         customerId,
      arrangement_id:      null,
      invoice_id:          null,
      action_type:         taskType,
      status:              'PENDING',
      proposed_by_user_id: null,
      payload: {
        source:      'cockpit',
        created_via: 'cockpit',
        title:       `Testtaak: ${taskType.replace(/^MANUAL_/, '').toLowerCase()}`,
      },
    })
    .select('id, action_type, created_at')
    .maybeSingle();

  if (insErr) {
    await audit({ actor, target: { customer_id: customerId }, payload: { task_type: taskType }, status: 'error', error: insErr.message });
    return res.status(500).json({ error: insErr.message });
  }

  await audit({
    actor,
    target: { customer_id: customerId, task_id: inserted?.id },
    payload: { task_type: taskType },
    result: { task_id: inserted?.id },
    status: 'ok',
  });

  return res.status(201).json({ ok: true, task: inserted });
}
