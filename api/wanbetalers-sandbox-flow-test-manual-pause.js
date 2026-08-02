// api/wanbetalers-sandbox-flow-test-manual-pause.js
//
// POST { flow: 'single' | 'multi' } → test transitie 3:
// handmatige pauze → engine doet niks → handmatig hervat → engine loopt weer.
//
// Stappen:
//   1) sandbox-klant + is_test-assert
//   2) reset + seed voor gekozen flow
//   3) runEngine → start run
//   4) capture BEFORE_PAUSE (verwacht status='active')
//   5) manualPauseRun → zet status='paused'
//   6) capture AFTER_PAUSE (verwacht status='paused')
//   7) fast-forward next_action_at NAAR VERLEDEN + runEngine → moet niks
//      doen (advanceActiveRuns filtert op status='active', dus paused runs
//      worden niet opgepikt)
//   8) capture AFTER_ENGINE_WHILE_PAUSED (verwacht: status blijft 'paused',
//      current_step_id ongewijzigd)
//   9) manualResumeRun → zet status='active' + wipe pauze-relicten
//  10) runEngine → mag nu WEL advancen
//  11) capture AFTER_RESUME (bewijs: step advanced OF completed OF newer updated_at)
//  12) PASS/FAIL per assertion
//
// Super_admin only.

import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import {
  loadSandboxCustomerOrFail,
  resetAndSeedForFlowTest,
  runEngineTestScope,
  captureRunState,
  manualPauseRun,
  manualResumeRun,
  fastForwardRunNextActionDays,
} from './_lib/wanbetalers-flow-test.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const flow = String(body.flow || 'single');
  if (!['single', 'multi'].includes(flow)) {
    return res.status(400).json({ error: `flow moet 'single' of 'multi' zijn, kreeg '${flow}'` });
  }

  const steps = [];
  const push = (name, detail) => steps.push({ name, ...detail });

  try {
    // 1) Customer.
    const csRes = await loadSandboxCustomerOrFail();
    if (!csRes.ok) return res.status(400).json({ ok: false, error: csRes.error, steps });
    const customer = csRes.customer;
    push('load_sandbox_customer', { ok: true, customer_id: customer.id });

    // 2) Seed.
    const seedRes = await resetAndSeedForFlowTest(customer, flow);
    if (!seedRes.ok) { push('seed', { ok: false, error: seedRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('seed', { ok: true, ...seedRes });

    // 3) Engine start.
    await runEngineTestScope();
    push('engine_start', { ok: true });

    // 4) BEFORE_PAUSE.
    const beforePause = await captureRunState(customer.id);
    push('capture_before_pause', { ok: true, state: beforePause });
    if (!beforePause.has_run) {
      push('verify_run_started', { pass: false, error: 'Geen run aangemaakt na engine' });
      return res.status(200).json({ ok: false, final_pass: false, flow, transition: 'manual_pause_resume', steps });
    }
    if (beforePause.status !== 'active') {
      push('verify_run_started', { pass: false, expected: 'active', actual: beforePause.status });
      return res.status(200).json({ ok: false, final_pass: false, flow, transition: 'manual_pause_resume', steps });
    }
    push('verify_run_started', { pass: true, expected: 'active', actual: 'active' });

    // 5) Manual pause.
    const pRes = await manualPauseRun(beforePause.run_id, customer.id);
    if (!pRes.ok) { push('manual_pause', { ok: false, error: pRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('manual_pause', { ok: true, run_id: beforePause.run_id });

    // 6) AFTER_PAUSE.
    const afterPause = await captureRunState(customer.id);
    push('capture_after_pause', { ok: true, state: afterPause });
    const pausedOk = (afterPause.status === 'paused');
    push('assert_paused_after_manual_pause', {
      pass:     pausedOk,
      expected: 'paused',
      actual:   afterPause.status,
    });

    // 7) Fast-forward + engine. Fast-forward MOET vóór engine anders zou
    //    de advanceActiveRuns-filter next_action_at.is.null || <= now
    //    de run überhaupt niet oppikken. Wij bewijzen dat óók bij
    //    "engine wil advancen"-condities (past due next_action_at) de
    //    paused-status hem stopt.
    //    NB: fast-forward-helper werkt alleen op status='active' NIET
    //    → we shiften de kolom direct met een sandbox-scoped update.
    const nowIso   = new Date().toISOString();
    const pastIso  = new Date(Date.now() - 86400000).toISOString();
    const { supabaseAdmin } = await import('./supabase.js');
    const { data: ffData, error: ffErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({ next_action_at: pastIso, updated_at: nowIso })
      .eq('id', beforePause.run_id)
      .eq('customer_id', customer.id)
      .eq('status', 'paused')            // ← guard: alleen als 'ie paused is
      .select('id, status, next_action_at');
    if (ffErr) { push('fast_forward_past_due', { ok: false, error: ffErr.message }); return res.status(500).json({ ok: false, steps }); }
    if (!ffData || ffData.length === 0) {
      push('fast_forward_past_due', { ok: false, error: 'SANDBOX_GUARD_FAILED: ff raakte 0 rijen (verwacht paused sandbox-run)' });
      return res.status(500).json({ ok: false, steps });
    }
    push('fast_forward_past_due', { ok: true });

    // Engine draaien — mag paused-run niet oppikken.
    await runEngineTestScope();
    push('engine_while_paused', { ok: true });

    // 8) AFTER_ENGINE_WHILE_PAUSED — status blijft 'paused'.
    const afterEnginePaused = await captureRunState(customer.id);
    push('capture_after_engine_while_paused', { ok: true, state: afterEnginePaused });
    const stayedPaused = (afterEnginePaused.status === 'paused');
    const stepUnchanged = (afterEnginePaused.current_step_id === beforePause.current_step_id);
    push('assert_no_advance_during_manual_pause', {
      pass:     stayedPaused && stepUnchanged,
      expected: 'status=paused + current_step_id ongewijzigd',
      actual:   `status=${afterEnginePaused.status}, step_id_gelijk=${stepUnchanged}`,
    });

    // 9) Manual resume.
    const rRes = await manualResumeRun(beforePause.run_id, customer.id);
    if (!rRes.ok) { push('manual_resume', { ok: false, error: rRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('manual_resume', { ok: true, run_id: beforePause.run_id });

    // 10) Engine draaien — moet nu wel advancen (next_action_at is now door resume-helper).
    await runEngineTestScope();
    push('engine_after_resume', { ok: true });

    // 11) AFTER_RESUME — bewijs advance.
    const afterResume = await captureRunState(customer.id);
    push('capture_after_resume', { ok: true, state: afterResume });

    const stepAdvanced   = (afterResume.current_step_id !== beforePause.current_step_id);
    const runCompleted   = (afterResume.status === 'completed');
    const touchedNewer   = afterResume.updated_at && afterEnginePaused.updated_at
      && (new Date(afterResume.updated_at).getTime() > new Date(afterEnginePaused.updated_at).getTime() + 100);
    const engineAdvanced = stepAdvanced || runCompleted || touchedNewer;
    push('assert_engine_advanced_after_manual_resume', {
      pass:     engineAdvanced,
      expected: 'step veranderd OF status completed OF updated_at nieuwer',
      actual:   `step_advanced=${stepAdvanced}, completed=${runCompleted}, updated_at=${afterResume.updated_at}`,
    });

    const finalPass = pausedOk && stayedPaused && stepUnchanged && engineAdvanced;

    return res.status(200).json({
      ok:         true,
      flow,
      transition: 'manual_pause_resume',
      final_pass: finalPass,
      before_pause:         beforePause,
      after_pause:          afterPause,
      after_engine_paused:  afterEnginePaused,
      after_resume:         afterResume,
      steps,
      summary:    finalPass
        ? `PASS — flow ${flow}: manual pause hield run stil, manual resume liet engine hervatten.`
        : `FAIL — flow ${flow}: pause/resume-cyclus faalde (zie assertions).`,
    });
  } catch (e) {
    console.error('[sandbox-flow-test-manual-pause]', e?.message || e);
    push('exception', { ok: false, error: e?.message || String(e) });
    return res.status(500).json({ ok: false, final_pass: false, steps, error: e?.message || 'Interne fout' });
  }
}
