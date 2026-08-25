// POST /api/dunning-test-wik-brief
//
// Genereert een echte WIK-brief (dunning_briefs + dunning_log) voor een
// is_test-customer via de productie-generator generatePreBriefForCustomer.
//
// Body: { customer_id: uuid, run_id?: uuid, country?: 'NL'|'BE' }
//
// generatePreBriefForCustomer doet PUUR data-persistence:
//   1. SELECT customer/template/invoices/subs/paid
//   2. renderBriefPdf (buffer in-memory)
//   3. storage.upload (Supabase storage bucket)
//   4. INSERT dunning_briefs
//   5. INSERT dunning_log event 'incasso_pre_brief_sent'
// GEEN sendMail / sendTemplate / geen echte outbound send.
//
// Weigert non-is_test-customer (400).

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { generatePreBriefForCustomer } from './_lib/incasso-pre-brief-core.js';

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'generate_test_wik_brief',
      scope:        'test',
      target: target || {}, payload: payload || {}, result: result || {},
      status, error_message: error || null,
    });
  } catch (e) { console.error('[dunning-test-wik-brief] audit fail:', e?.message || e); }
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
  const country    = body.country || null;
  let runId        = body.run_id || null;

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });

  // is_test-guard.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers').select('id, is_test').eq('id', customerId).maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!cust.is_test) return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering.' });

  // Als geen run_id opgegeven → pak de nieuwste actieve dunning_workflow_run.
  if (!runId) {
    const { data: r } = await supabaseAdmin
      .from('dunning_workflow_runs').select('id')
      .eq('customer_id', customerId)
      .order('updated_at', { ascending: false })
      .limit(1).maybeSingle();
    if (r) runId = r.id;
  }

  const result = await generatePreBriefForCustomer({
    customerId,
    country,
    runId,
    stepId:            null,
    generatedByUserId: null,
  });

  if (!result?.ok) {
    await audit({
      actor,
      target: { customer_id: customerId, run_id: runId },
      payload: { country }, status: 'error',
      error: `${result?.code}: ${result?.error || '(no message)'}`,
    });
    return res.status(400).json({
      error: 'WIK-generatie mislukt.',
      code:  result?.code || 'UNKNOWN',
      details: result?.error || null,
      missing: result?.missing || undefined,
    });
  }

  await audit({
    actor,
    target: { customer_id: customerId, run_id: runId, brief_id: result.brief_id },
    payload: { country: result.country },
    result: { brief_id: result.brief_id, pdf_path: result.pdf_path, template_code: result.template_code },
    status: 'ok',
  });

  return res.status(201).json({
    ok:            true,
    brief_id:      result.brief_id,
    pdf_path:      result.pdf_path,
    template_code: result.template_code,
    country:       result.country,
    message:       'WIK-brief gegenereerd via productie-code — dunning_briefs + dunning_log geschreven, PDF in storage. GEEN outbound send.',
  });
}
