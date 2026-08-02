// api/wanbetalers-sandbox-flow-test-snooze.js
//
// POST { flow: 'single' | 'multi', days?: number } → test transitie 2:
// snooze N dagen → engine skipt → fast-forward voorbij snooze → engine
// hervat.
//
// Stappen:
//   1) sandbox-klant + is_test-assert
//   2) reset + seed voor gekozen flow
//   3) runEngine → start run + advance eerste stap (setzt next_action_at)
//   4) capture BEFORE_SNOOZE (verwacht status='active')
//   5) snoozeRunDays(runId, customerId, days) → next_action_at = now + days
//   6) capture AFTER_SNOOZE (verwacht next_action_at in de toekomst)
//   7) runEngine — mag GEEN advance doen op deze run (next_action_at > now)
//   8) capture AFTER_ENGINE_WHILE_SNOOZED (verwacht: current_step ongewijzigd,
//      next_action_at nog steeds toekomst)
//   9) fastForwardRunNextActionDays — schuif next_action_at N+1 dagen terug
//  10) runEngine — moet nu WEL advancen
//  11) capture AFTER_RESUME (verwacht: current_step of updated_at gewijzigd
//      of run completed als er maar 1 stap was)
//  12) PASS/FAIL per assertion
//
// Super_admin only.

import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import {
  loadSandboxCustomerOrFail,
  resetAndSeedForFlowTest,
  runEngineTestScope,
  captureRunState,
  snoozeRunDays,
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
  const days = Math.max(1, Math.min(60, Number(body.days) || 3));
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

    // 4) BEFORE_SNOOZE.
    const beforeSnooze = await captureRunState(customer.id);
    push('capture_before_snooze', { ok: true, state: beforeSnooze });
    if (!beforeSnooze.has_run) {
      push('verify_run_started', { pass: false, error: 'Geen run aangemaakt na engine' });
      return res.status(200).json({ ok: false, final_pass: false, flow, transition: 'snooze_resume', steps });
    }
    if (beforeSnooze.status !== 'active') {
      push('verify_run_started', { pass: false, expected: 'active', actual: beforeSnooze.status });
      return res.status(200).json({ ok: false, final_pass: false, flow, transition: 'snooze_resume', steps });
    }
    push('verify_run_started', { pass: true, expected: 'active', actual: 'active' });

    // 5) Snooze N dagen.
    const snRes = await snoozeRunDays(beforeSnooze.run_id, customer.id, days);
    if (!snRes.ok) { push('snooze', { ok: false, error: snRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('snooze', { ok: true, days: snRes.snoozed_days, new_next_action_at: snRes.run.next_action_at });

    // 6) AFTER_SNOOZE: next_action_at moet in de toekomst zitten.
    const afterSnooze = await captureRunState(customer.id);
    push('capture_after_snooze', { ok: true, state: afterSnooze });
    const naaMs = afterSnooze.next_action_at ? new Date(afterSnooze.next_action_at).getTime() : 0;
    const nowMs = Date.now();
    const inFuture = naaMs > nowMs;
    push('assert_snooze_next_action_in_future', {
      pass:     inFuture,
      expected: '> nu',
      actual:   afterSnooze.next_action_at,
    });

    // 7) Engine draaien terwijl gesnooze'd — mag geen advance doen op deze run.
    const currentStepBefore = afterSnooze.current_step_id;
    const updatedAtBefore   = afterSnooze.updated_at;
    await runEngineTestScope();
    push('engine_while_snoozed', { ok: true });

    // 8) AFTER_ENGINE_WHILE_SNOOZED.
    const afterEngineSnoozed = await captureRunState(customer.id);
    push('capture_after_engine_while_snoozed', { ok: true, state: afterEngineSnoozed });
    // Snooze-effect bewijs: current_step_id ongewijzigd, next_action_at nog steeds toekomst.
    const stepUnchanged = (afterEngineSnoozed.current_step_id === currentStepBefore);
    const stillFuture   = afterEngineSnoozed.next_action_at
      ? new Date(afterEngineSnoozed.next_action_at).getTime() > Date.now()
      : false;
    push('assert_no_advance_during_snooze', {
      pass:     stepUnchanged && stillFuture,
      expected: 'current_step_id ongewijzigd + next_action_at nog toekomst',
      actual:   `step_id_gelijk=${stepUnchanged}, next_action_at=${afterEngineSnoozed.next_action_at}`,
    });

    // 9) Fast-forward: schuif next_action_at N+1 dagen terug.
    const ffRes = await fastForwardRunNextActionDays(beforeSnooze.run_id, customer.id, days + 1);
    if (!ffRes.ok) { push('fast_forward', { ok: false, error: ffRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('fast_forward', { ok: true, shifted_days: ffRes.shifted_days, new_next_action_at: ffRes.new_next_action_at });

    // 10) Engine draaien — moet nu WEL advancen.
    await runEngineTestScope();
    push('engine_after_fast_forward', { ok: true });

    // 11) AFTER_RESUME.
    const afterResume = await captureRunState(customer.id);
    push('capture_after_resume', { ok: true, state: afterResume });

    // Advance-bewijs: OF current_step_id veranderd, OF status='completed',
    // OF updated_at is > updatedAtBefore (met marge van 100ms voor de zekerheid).
    const stepAdvanced   = (afterResume.current_step_id !== currentStepBefore);
    const runCompleted   = (afterResume.status === 'completed');
    const touchedNewer   = afterResume.updated_at && updatedAtBefore
      && (new Date(afterResume.updated_at).getTime() > new Date(updatedAtBefore).getTime() + 100);
    const engineAdvanced = stepAdvanced || runCompleted || touchedNewer;
    push('assert_engine_advanced_after_snooze_expired', {
      pass:     engineAdvanced,
      expected: 'step veranderd OF status completed OF updated_at nieuwer',
      actual:   `step_advanced=${stepAdvanced}, completed=${runCompleted}, updated_at=${afterResume.updated_at}`,
    });

    const finalPass = inFuture && stepUnchanged && stillFuture && engineAdvanced;

    return res.status(200).json({
      ok:         true,
      flow,
      transition: 'snooze_resume',
      final_pass: finalPass,
      snoozed_days: days,
      before_snooze:         beforeSnooze,
      after_snooze:          afterSnooze,
      after_engine_snoozed:  afterEngineSnoozed,
      after_resume:          afterResume,
      steps,
      summary:    finalPass
        ? `PASS — flow ${flow}: snooze ${days}d hield run stil, fast-forward liet engine hervatten.`
        : `FAIL — flow ${flow}: snooze-cyclus faalde (zie assertions).`,
    });
  } catch (e) {
    console.error('[sandbox-flow-test-snooze]', e?.message || e);
    push('exception', { ok: false, error: e?.message || String(e) });
    return res.status(500).json({ ok: false, final_pass: false, steps, error: e?.message || 'Interne fout' });
  }
}
