// POST /api/dunning-test-resume-run
//
// Hervat gepauzeerde dunning_workflow_runs voor een is_test-customer,
// via de ECHTE resume-helpers per pauze-reden. Geen kale status-flip.
//
// Body: { customer_id: uuid }
//
// Per gepauzeerde run:
//   - paused_by_conversation_id gezet → unpauseRunsForConversation(convId)
//   - paused_by_arrangement_id gezet   → unpauseRunsFromArrangement(arrId)
//   - paused_manual_reason gezet         → runConvLessResume({scope:'test'})
//     (die handler is na PR #1361 test-only + tripwire)
//   - Anders → skip met reden 'NO_RESUMABLE_PAUSE'
//
// Weigert non-test-customer (400).

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { unpauseRunsForConversation, unpauseRunsFromArrangement } from './_lib/dunning-arrangement-hooks.js';
import { runConvLessResume } from './_lib/conv-less-resume.js';

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'resume_test_run',
      scope:        'test',
      target: target || {}, payload: payload || {}, result: result || {},
      status, error_message: error || null,
    });
  } catch (e) { console.error('[dunning-test-resume-run] audit fail:', e?.message || e); }
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

  // is_test-guard.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers').select('id, is_test').eq('id', customerId).maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!cust.is_test) return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering.' });

  // Alle gepauzeerde runs voor deze customer.
  const { data: runs, error: rErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, status, paused_by_conversation_id, paused_by_arrangement_id, paused_manual_reason')
    .eq('customer_id', customerId)
    .eq('status', 'paused');
  if (rErr) return res.status(500).json({ error: 'runs fetch: ' + rErr.message });

  const results = [];
  let convlessCalled = false;
  for (const r of runs || []) {
    try {
      if (r.paused_by_conversation_id) {
        const rr = await unpauseRunsForConversation(r.paused_by_conversation_id);
        results.push({ run_id: r.id, via: 'conversation', outcome: rr });
        continue;
      }
      if (r.paused_by_arrangement_id) {
        const rr = await unpauseRunsFromArrangement(r.paused_by_arrangement_id);
        results.push({ run_id: r.id, via: 'arrangement', outcome: rr });
        continue;
      }
      if (r.paused_manual_reason) {
        // conv-less-resume verwerkt paused_manual_reason. Roep 'em één keer aan
        // (batch-scan), niet per run — anders duplicate werk.
        if (!convlessCalled) {
          const summary = await runConvLessResume({ scope: 'test' });
          convlessCalled = true;
          results.push({ run_id: r.id, via: 'conv-less-resume', outcome: summary });
        } else {
          results.push({ run_id: r.id, via: 'conv-less-resume', outcome: { note: 'already-called-this-request' } });
        }
        continue;
      }
      results.push({ run_id: r.id, via: null, outcome: { reason: 'NO_RESUMABLE_PAUSE' } });
    } catch (e) {
      results.push({ run_id: r.id, via: 'error', outcome: { error: e?.message || String(e) } });
    }
  }

  await audit({
    actor,
    target: { customer_id: customerId },
    payload: { scanned_runs: (runs || []).length },
    result: { per_run: results },
    status: 'ok',
  });

  return res.status(200).json({
    ok: true,
    scanned_runs: (runs || []).length,
    per_run: results,
  });
}
