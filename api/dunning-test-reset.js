// POST /api/dunning-test-reset
//
// Twee-fasen teardown van alle is_test-data. Roept de PostgreSQL RPC
// dunning_test_cockpit_reset(p_dry_run) aan — die doet de hele cleanup
// in één transactie (FK-fout → rollback, geen half-geleegde state).
//
// Body:
//   { confirm: true, dry_run_count_only: true|false }
//
// - dry_run_count_only=true → retourneert alleen tellingen, doet NIETS.
// - dry_run_count_only=false + confirm=true → daadwerkelijk wissen.
// - confirm ontbrekend of !== true → altijd 400.
//
// Elke aanroep landt in test_cockpit_audit (dry-run of echte reset).

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

async function audit({ actor, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       payload?.dry_run ? 'reset_dry_run' : 'reset_apply',
      scope:        'test',
      target:       {},
      payload:      payload || {},
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-reset] audit insert failed:', e?.message || e);
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

  if (body.confirm !== true) {
    return res.status(400).json({
      error: 'confirm=true is verplicht (safety-guard tegen accidentele reset).',
    });
  }

  const dryRun = body.dry_run_count_only !== false; // default TRUE = safest

  try {
    const { data, error: rpcErr } = await supabaseAdmin.rpc('dunning_test_cockpit_reset', {
      p_dry_run: dryRun,
    });
    if (rpcErr) {
      await audit({ actor, payload: { dry_run: dryRun }, status: 'error', error: rpcErr.message });
      return res.status(500).json({ error: 'RPC-fout: ' + rpcErr.message });
    }
    await audit({ actor, payload: { dry_run: dryRun }, result: data || {}, status: 'ok' });
    return res.status(200).json({
      ok: true,
      dry_run: dryRun,
      ...data,
    });
  } catch (e) {
    await audit({ actor, payload: { dry_run: dryRun }, status: 'error', error: e?.message || String(e) });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
