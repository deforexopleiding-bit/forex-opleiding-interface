// api/wanbetalers-sandbox-flow-test-inbound.js
//
// POST { flow: 'single' | 'multi' } → test transitie 1: klant reageert → run pauzeert.
//
// Stappen (bewijs 1-op-1 dat productie-code werkt):
//   1) sandbox-klant + is_test-assert
//   2) reset + seed voor gekozen flow
//   3) runEngine({scope:'test'}) — detecteert wanbetaler + start run
//   4) capture BEFORE (status='active' verwacht)
//   5) simulateSandboxInbound — inserteert conversation + message en roept
//      pauseRunsForConversation() aan (dezelfde hook als inbox-webhook.js)
//   6) capture AFTER (status='paused' + paused_by_conversation_id NOT NULL verwacht)
//   7) PASS/FAIL + expected/actual per assertion
//
// GEEN wijziging aan productie-executor/engine. Wij importeren runEngine +
// pauseRunsForConversation direct.
//
// Super_admin only.

import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import {
  loadSandboxCustomerOrFail,
  resetAndSeedForFlowTest,
  runEngineTestScope,
  captureRunState,
  simulateSandboxInbound,
  findLatestRun,
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
    // 1) Sandbox-klant + is_test-assert.
    const csRes = await loadSandboxCustomerOrFail();
    if (!csRes.ok) return res.status(400).json({ ok: false, error: csRes.error, steps });
    const customer = csRes.customer;
    push('load_sandbox_customer', { ok: true, customer_id: customer.id, name: customer.first_name });

    // 2) Reset + seed voor gekozen flow.
    const seedRes = await resetAndSeedForFlowTest(customer, flow);
    if (!seedRes.ok) { push('seed', { ok: false, error: seedRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('seed', { ok: true, ...seedRes });

    // 3) runEngine — starts a fresh run (workflow-selectie o.b.v. trigger-condities).
    const engRes = await runEngineTestScope();
    push('engine_start', {
      ok: true,
      engine_result: {
        detected:      engRes?.detected      ?? null,
        runs_advanced: engRes?.runs_advanced ?? null,
        errors:        (engRes?.errors || []).length,
      },
    });

    // 4) BEFORE: haal de latest run op — moet 'active' zijn.
    const before = await captureRunState(customer.id);
    push('capture_before', { ok: true, state: before });
    if (!before.has_run) {
      push('verify_run_started', { ok: false, error: 'Geen run aangemaakt na engine — check workflow-trigger-condities voor deze seed.' });
      return res.status(200).json({ ok: false, final_pass: false, flow, transition: 'inbound_pause', steps });
    }
    if (before.status !== 'active') {
      push('verify_run_started', { pass: false, expected: 'active', actual: before.status });
      return res.status(200).json({ ok: false, final_pass: false, flow, transition: 'inbound_pause', steps });
    }
    push('verify_run_started', { pass: true, expected: 'active', actual: 'active' });

    // 5) Simulate inbound WA → triggert pauseRunsForConversation.
    const inRes = await simulateSandboxInbound(customer, 'Ik heb even wat tijd nodig — kom er deze week op terug.');
    if (!inRes.ok) { push('simulate_inbound', { ok: false, error: inRes.error }); return res.status(500).json({ ok: false, steps }); }
    push('simulate_inbound', { ok: true, conversation_id: inRes.conversation_id, message_id: inRes.message_id });

    // 6) AFTER: run moet nu paused zijn met paused_by_conversation_id ingevuld.
    const after = await captureRunState(customer.id);
    push('capture_after', { ok: true, state: after });

    // 7) Verify — 2 asserts.
    const okStatus = (after.status === 'paused');
    const okPausedBy = (after.paused_by_conversation_id === inRes.conversation_id);
    push('assert_status_paused', { pass: okStatus, expected: 'paused', actual: after.status });
    push('assert_paused_by_conversation_id_set', {
      pass:     okPausedBy,
      expected: inRes.conversation_id,
      actual:   after.paused_by_conversation_id,
    });
    const finalPass = okStatus && okPausedBy;

    return res.status(200).json({
      ok:         true,
      flow,
      transition: 'inbound_pause',
      final_pass: finalPass,
      before,
      after,
      steps,
      summary:    finalPass
        ? `PASS — flow ${flow}: run active → paused_customer_replied na inbound-WA.`
        : `FAIL — flow ${flow}: verwachte paused-state werd niet bereikt (zie assertions).`,
    });
  } catch (e) {
    console.error('[sandbox-flow-test-inbound]', e?.message || e);
    push('exception', { ok: false, error: e?.message || String(e) });
    return res.status(500).json({ ok: false, final_pass: false, steps, error: e?.message || 'Interne fout' });
  }
}
