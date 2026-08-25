// POST /api/dunning-test-simulate-backfill-orphan
//
// Seed een backfill-wees op de is_test-klant zodat D1/D2 in de harness de
// echte conv-less-resume-handler kan testen — dezelfde handler die we voor
// de 27 productie-wezen (Michel c.s.) gaan aanzetten.
//
// Toestand die we settaen (bevestigd door DB-query 2026-08-25 op alle 27
// actieve wezen — UNIFORM):
//   status                    = 'paused'
//   paused_manual_reason      = 'reply_backfilled_from_log'
//   paused_by_conversation_id = NULL
//   paused_by_arrangement_id  = NULL
//   paused_by_manual_user_id  = NULL
//   needs_attention           = false
//   paused_at                 = now
//
// Bewust NIET aangeraakt:
//   next_action_at   — conv-less-resume zet 'em zelf bij hervatting.
//   current_step_id  — blijft waar hij was toen "backfill" 'em pauzeerde.
//
// Detectie-scope conv-less-resume (autoritatief uit _lib/conv-less-resume.js:108-127):
//   pre-fetch: status='paused' + drie paused_by_*_id IS NULL + customers.is_test
//   JS-filter: reply_*-prefix OR NULL, needs_attention !== true
//   'reply_backfilled_from_log' matcht 'reply_'-prefix → binnen scope.
//
// Body: { customer_id: uuid }
//
// HARDE GRENDEL (fail-closed, vóór elke write):
//   • customer.is_test !== true → 400. Nul writes.
//   • UPDATE geklemd op run.id + customer_id (dubbele guard).
//   • Geen send-side-effects (geen simulate-inbound, geen dry-run-toggle).
//   • Alleen runs van de gegeven is_test-klant aangeraakt.
//
// Enroll-if-needed: als klant geen active/paused run heeft, draaien we eerst
// runEngine({mode:'manual', scope:'test'}) om er één te enrollen. Als dat niet
// lukt (bijv. days_overdue-drempel niet gehaald) → 400 met duidelijke error.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'simulate_backfill_orphan',
      scope:        'test',
      target: target || {},
      payload: payload || {},
      result:  result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-simulate-backfill-orphan] audit fail:', e?.message || e);
  }
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

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });

  // ── HARDE GRENDEL 1: is_test-guard op customer ────────────────────────
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers')
    .select('id, is_test, first_name, last_name')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (cust.is_test !== true) {
    await audit({ actor, target: { customer_id: customerId }, status: 'error', error: 'non-test customer' });
    return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering — nul writes.' });
  }

  // ── GRENDEL 2: minstens 1 open is_test-factuur (anders heeft resume niets) ─
  const { data: openInvs, error: invErr } = await supabaseAdmin
    .from('invoices')
    .select('id')
    .eq('customer_id', customerId)
    .eq('is_test', true)
    .in('status', ['open', 'partially_paid', 'overdue'])
    .limit(1);
  if (invErr) return res.status(500).json({ error: 'invoices lookup: ' + invErr.message });
  if (!openInvs || openInvs.length === 0) {
    await audit({ actor, target: { customer_id: customerId }, status: 'error', error: 'no open test invoices' });
    return res.status(400).json({ error: 'Test-klant heeft geen open is_test-factuur. Seed eerst een factuur voor je backfill-wees simuleert.' });
  }

  // ── Enroll-if-needed ──────────────────────────────────────────────────
  let { data: run, error: runErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, status, workflow_id, customer_id, paused_manual_reason')
    .eq('customer_id', customerId)
    .in('status', ['active', 'paused'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runErr) return res.status(500).json({ error: 'run lookup: ' + runErr.message });

  let enrolledFresh = false;
  if (!run) {
    // Draai engine om een run aan te maken (respecteert workflow.min_days_overdue).
    try {
      const { runEngine } = await import('./_lib/dunning-engine.js');
      await runEngine({ mode: 'manual', scope: 'test' });
    } catch (e) {
      await audit({ actor, target: { customer_id: customerId }, status: 'error', error: 'engine enroll fail: ' + (e?.message || e) });
      return res.status(500).json({ error: 'engine enroll fail: ' + (e?.message || String(e)) });
    }
    const { data: run2, error: run2Err } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, status, workflow_id, customer_id, paused_manual_reason')
      .eq('customer_id', customerId)
      .in('status', ['active', 'paused'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run2Err) return res.status(500).json({ error: 'run re-lookup: ' + run2Err.message });
    if (!run2) {
      await audit({ actor, target: { customer_id: customerId }, status: 'error', error: 'engine did not enroll' });
      return res.status(400).json({
        error: 'runEngine liet geen run aanmaken. Waarschijnlijk voldoet de factuur niet aan workflow.min_days_overdue. Check factuur.days_late en workflow-config.',
      });
    }
    run = run2;
    enrolledFresh = true;
  }

  // ── Zet run in EXACT de backfill-wees-toestand ────────────────────────
  const nowIso = new Date().toISOString();
  const updatePayload = {
    status:                    'paused',
    paused_manual_reason:      'reply_backfilled_from_log',
    paused_by_conversation_id: null,
    paused_by_arrangement_id:  null,
    paused_by_manual_user_id:  null,
    needs_attention:           false,
    paused_at:                 nowIso,
    updated_at:                nowIso,
    // next_action_at: bewust NIET gezet — conv-less-resume zet 'em zelf.
    // current_step_id: bewust NIET gewijzigd — blijft de stap-in-progress.
  };
  const { data: updated, error: upErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .update(updatePayload)
    .eq('id', run.id)
    .eq('customer_id', customerId)           // ← klem: dubbele guard
    .select('id, status, paused_manual_reason, paused_by_conversation_id, paused_by_arrangement_id, paused_by_manual_user_id, needs_attention, paused_at, current_step_id, workflow_id, customer_id')
    .maybeSingle();
  if (upErr) {
    await audit({ actor, target: { customer_id: customerId, run_id: run.id }, status: 'error', error: upErr.message });
    return res.status(500).json({ error: 'run update: ' + upErr.message });
  }
  if (!updated) {
    // Klem mislukte (run.customer_id != customerId) — mag niet gebeuren na
    // de is_test-guard + customer_id-eq in de fetch, maar defensief afvangen.
    await audit({ actor, target: { customer_id: customerId, run_id: run.id }, status: 'error', error: 'update-klem geen match' });
    return res.status(500).json({ error: 'Update klem gaf 0 rijen terug — abort.' });
  }

  await audit({
    actor,
    target: { customer_id: customerId, run_id: run.id },
    payload: { enrolled_fresh: enrolledFresh },
    result:  { run_id: run.id, state: updatePayload },
    status:  'ok',
  });

  return res.status(201).json({
    ok: true,
    run_id: updated.id,
    enrolled_fresh: enrolledFresh,
    state: {
      status:                    updated.status,
      paused_manual_reason:      updated.paused_manual_reason,
      paused_by_conversation_id: updated.paused_by_conversation_id,
      paused_by_arrangement_id:  updated.paused_by_arrangement_id,
      paused_by_manual_user_id:  updated.paused_by_manual_user_id,
      needs_attention:           updated.needs_attention,
      paused_at:                 updated.paused_at,
      current_step_id:           updated.current_step_id,
      workflow_id:               updated.workflow_id,
    },
    message: 'Backfill-wees gesimuleerd. Trigger nu POST /api/wanbetalers-sandbox-run-conv-less-resume om de handler hem te laten oppikken.',
  });
}
