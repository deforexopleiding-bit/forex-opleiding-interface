// api/dunning-test-verify-grendel.js
//
// Bewijst dat _lib/test-cockpit-send.js hard throw't bij mismatch of lege
// sandbox-config, en dry-run respecteert bij een match. RAAKT DE LIVE
// app_settings NIET AAN — alle scenario's worden geïnjecteerd via de
// `overrides`-param van de wrapper (dependency injection). Doet geen
// echte send: dryRun wordt altijd geforceerd true in de match-scenario's.
//
// Verwachte uitkomst: { ok: true, passed: 6, total: 6 }.
// Elke aanroep landt in test_cockpit_audit — dat is meteen ook het bewijs
// dat de audit-tak werkt.

import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { sendTestWaText, sendTestEmail } from './_lib/test-cockpit-send.js';

async function runScenario(name, expected, fn) {
  try {
    const result = await fn();
    return { name, expected, actual: 'ok', result };
  } catch (e) {
    return { name, expected, actual: 'throw', error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET or POST only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const actor = { userId: admin.user.id, email: admin.profile.email };
  const results = [];

  // Scenario 1: lege sandbox-config (geïnjecteerd) → hard throw.
  results.push(await runScenario('empty-config-wa', 'throw', () =>
    sendTestWaText({
      actor,
      to: '+31600000000',
      body: 'verify-1',
      target: { verify_scenario: 'empty-config-wa' },
      overrides: { contact: { phone: null, email: null }, dryRun: true },
    }),
  ));
  results.push(await runScenario('empty-config-email', 'throw', () =>
    sendTestEmail({
      actor,
      fromMailbox: 'administratie@deforexopleiding.nl',
      to: 'anywhere@example.com',
      subject: 'verify-2',
      text: 'verify-2',
      target: { verify_scenario: 'empty-config-email' },
      overrides: { contact: { phone: null, email: null }, dryRun: true },
    }),
  ));

  // Scenario 2: sandbox gezet, verkeerde recipient → hard throw.
  const fakeContact = { phone: '+31699999999', email: 'sandbox@deforexopleiding.nl' };
  results.push(await runScenario('mismatch-wa', 'throw', () =>
    sendTestWaText({
      actor,
      to: '+31611111111',
      body: 'verify-3',
      target: { verify_scenario: 'mismatch-wa' },
      overrides: { contact: fakeContact, dryRun: true },
    }),
  ));
  results.push(await runScenario('mismatch-email', 'throw', () =>
    sendTestEmail({
      actor,
      fromMailbox: 'administratie@deforexopleiding.nl',
      to: 'iemand@extern.nl',
      subject: 'verify-4',
      text: 'verify-4',
      target: { verify_scenario: 'mismatch-email' },
      overrides: { contact: fakeContact, dryRun: true },
    }),
  ));

  // Scenario 3: match + dryRun=true → mag doorlopen zonder echte send.
  results.push(await runScenario('match-wa-dryrun', 'ok', () =>
    sendTestWaText({
      actor,
      to: '+31699999999',
      body: 'verify-5',
      target: { verify_scenario: 'match-wa-dryrun' },
      overrides: { contact: fakeContact, dryRun: true },
    }),
  ));
  results.push(await runScenario('match-email-dryrun', 'ok', () =>
    sendTestEmail({
      actor,
      fromMailbox: 'administratie@deforexopleiding.nl',
      to: 'sandbox@deforexopleiding.nl',
      subject: 'verify-6',
      text: 'verify-6',
      target: { verify_scenario: 'match-email-dryrun' },
      overrides: { contact: fakeContact, dryRun: true },
    }),
  ));

  const passed = results.filter((r) => r.actual === r.expected).length;
  const total  = results.length;
  return res.status(passed === total ? 200 : 500).json({
    ok: passed === total,
    passed,
    total,
    results,
  });
}
