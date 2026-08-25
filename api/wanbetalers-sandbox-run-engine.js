// api/wanbetalers-sandbox-run-engine.js
// POST → draait de bestaande dunning-engine, maar gescoped op is_test=true
// (customers + invoices). Assertie: elke aangeraakte klant moet is_test=true
// zijn; anders abort direct. Respecteert dry-run (via de bestaande guard in
// executeEmailStep). Super_admin only.
//
// ENROLL-GEDRAG (voor test-harness):
//   runEngine({scope:'test'}) doet ZELF de eerste enroll —
//   _lib/dunning-engine.js:842 insert dunning_workflow_runs voor elke
//   is_test-klant met een is_test-factuur die aan de workflow-triggers
//   voldoet. Er is GEEN aparte `enroll`- of `breach-check`-endpoint nodig.
//
//   Voorwaarden voor enroll (per workflow):
//     • agg.days_overdue >= workflow.trigger_conditions.min_days_overdue
//       (default 14 als niet gezet; hoofd-ladder "Aanmaningen" = 1);
//     • customer.is_company matcht workflow.customer_type
//       ('any' → altijd; 'b2b' → is_company=true; 'b2c' → is_company=false);
//     • klant heeft geen bestaande active/paused run;
//     • klant zit niet in terminal pipeline-stage ('opgelost'/'afschrijven');
//     • factuur zit niet in ACTIEF payment_arrangement.
//
//   Ladder-wachttijd komt uit dunning_workflow_steps.config.days (NIET
//   `wait_days`). Fast-forward werkt door bestaande run.next_action_at
//   te verschuiven — kan pas NA enroll.

import { runEngine } from './_lib/dunning-engine.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
// Splitsing 2026-08-25: sandbox-flow leest de test-vlag, niet de productie-vlag.
import { isTestDryRunEnabled as isDryRunEnabled } from './_lib/dunning-dry-run.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });
    const dry = await isDryRunEnabled();
    const result = await runEngine({ mode: 'sandbox', scope: 'test' });
    return res.status(200).json({ ok: true, dry_run: dry, engine_result: result });
  } catch (e) {
    console.error('[sandbox-run-engine]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
