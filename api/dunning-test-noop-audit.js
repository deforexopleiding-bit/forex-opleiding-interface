// POST /api/dunning-test-noop-audit
//
// Audit-only stub voor prototype-parity cockpit-acties waar (nog) geen
// echte backend voor is: promise-maturity / conv-less-resume / wik-brief /
// simulate-promise / simulate-silence / create-task / complete-task.
//
// Waarom een stub i.p.v. dode knop: het prototype (docs/dunning-test-
// cockpit-reference.html) toont deze knoppen als volwaardige stappen; de
// cockpit-UI moet 1-op-1 matchen zonder dat een klik geen effect heeft.
// Deze endpoint insert een test_cockpit_audit-rij met status='ok' zodat
// de tijdlijn de stap toont. Echte behavior (DB-mutatie) volgt in
// vervolg-PRs per action.
//
// Whitelist server-side zodat productie-flows deze endpoint niet stil
// misbruiken voor andere actions.
//
// Body: { action: string, explain?: string, params?: object }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

// Real-wiring PR: whitelist krimpt naar UITSLUITEND simulate-silence.
// Alle andere prototype-actions hebben nu echte endpoints:
//   promise-maturity  → api/wanbetalers-sandbox-run-promise-maturity.js
//   conv-less-resume  → api/wanbetalers-sandbox-run-conv-less-resume.js
//   wik-brief         → api/dunning-test-wik-brief.js
//   simulate-promise  → api/dunning-test-simulate-promise.js
//   create-task       → api/dunning-test-create-task.js
//   complete-task     → api/dunning-test-complete-task.js
//   resume-run        → api/dunning-test-resume-run.js
// simulate-silence blijft noop-audit — dat is per definitie geen actie
// (het is tijd die verstrijkt).
const ALLOWED_NOOP_ACTIONS = new Set([
  'simulate-silence',
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = req.body || {};
  const action = String(body.action || '').trim();
  const explain = String(body.explain || '').trim() || action;
  const params  = (body.params && typeof body.params === 'object') ? body.params : {};

  if (!ALLOWED_NOOP_ACTIONS.has(action)) {
    return res.status(400).json({
      error: `Action '${action}' niet in noop-audit-whitelist. Toegestaan: ${Array.from(ALLOWED_NOOP_ACTIONS).join(', ')}.`,
    });
  }

  const customerId = params.customer_id || null;
  const auditRow = {
    triggered_by: admin.user.id,
    admin_email:  admin.profile.email,
    action:       'noop_' + action,
    scope:        'test',
    target:       customerId ? { customer_id: customerId } : {},
    payload:      { explain, params_keys: Object.keys(params) },
    result:       { simulated: true, note: 'echte behavior komt in vervolg-PR' },
    status:       'ok',
  };

  try {
    await supabaseAdmin.from('test_cockpit_audit').insert(auditRow);
  } catch (e) {
    console.error('[dunning-test-noop-audit] audit insert failed:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }

  return res.status(200).json({
    ok:        true,
    action,
    explain,
    simulated: true,
    message:   `Stap '${explain}' ge-audit (prototype-parity — echte backend komt later).`,
  });
}
