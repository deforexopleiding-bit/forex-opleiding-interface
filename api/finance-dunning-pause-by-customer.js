// api/finance-dunning-pause-by-customer.js
// POST → pauzeer de actieve dunning_workflow_run voor een klant vanuit de inbox.
//
// FASE 4 herontwerp — Blok 1 — "Pauzeer aanmaan-flow"-knop in de thread-header.
// Wrapper rond bestaande finance-dunning-run-control-flow: vindt de active/paused
// run voor de klant en zet status=paused (of laat 'ie als paused).
//
// Request:
//   POST { customer_id: uuid, reason?: string }
// Response 200:
//   { ok: true, run_id, previous_status, new_status }
//
// Permission: finance.dunning.execute (identiek aan finance-dunning-run-control).
//
// State-transitions:
//   - active -> paused (write): update dunning_workflow_runs.status='paused' + reason.
//   - paused -> no-op (200): al gepauzeerd; response bevat previous_status='paused'.
//   - geen actieve run: 404.
//
// Reden wordt opgeslagen in dunning_log voor traceability + reflecteert de
// bron ('inbox') zodat later duidelijk is waarom de flow werd gepauzeerd.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const customerId = body.customer_id ? String(body.customer_id).trim() : '';
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  }
  const reason = body.reason ? String(body.reason).trim().slice(0, 300) : 'manual_pause_from_inbox';

  // Vind meest recente actieve/paused run voor deze klant.
  const { data: runs, error: qErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, status, customer_id, updated_at')
    .eq('customer_id', customerId)
    .in('status', ['active', 'paused'])
    .order('updated_at', { ascending: false })
    .limit(1);

  if (qErr) {
    console.error('[dunning-pause-by-customer lookup]', qErr.message);
    return res.status(500).json({ error: qErr.message });
  }
  if (!runs?.length) {
    return res.status(404).json({ error: 'Geen actieve dunning-run voor deze klant' });
  }
  const run = runs[0];
  const prevStatus = run.status;
  if (prevStatus === 'paused') {
    return res.status(200).json({
      ok: true,
      run_id: run.id,
      previous_status: 'paused',
      new_status: 'paused',
      note: 'Was al gepauzeerd — geen wijziging',
    });
  }

  // Update actief → paused. Sinds migratie 2026-08-02: vul óók de nieuwe
  // reden-velden zodat de run niet als "wees" oogt in overzicht/dossier.
  // paused_by_manual_user_id = wie klikte de knop.
  // paused_manual_reason     = context-tekst (default 'manual_pause_from_inbox').
  // paused_at                = timestamp voor UI-weergave "sinds ...".
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .update({
      status:                   'paused',
      paused_by_manual_user_id: user.id,
      paused_manual_reason:     reason,
      paused_at:                nowIso,
      updated_at:               nowIso,
    })
    .eq('id', run.id)
    .eq('status', 'active') // race-guard
    .select('id, status')
    .maybeSingle();
  if (updErr) {
    console.error('[dunning-pause-by-customer update]', updErr.message);
    return res.status(500).json({ error: updErr.message });
  }
  if (!updated) {
    return res.status(409).json({ error: 'Run status veranderde tijdens de call (race)' });
  }

  // Best-effort log naar dunning_log (fail-soft — kolommen kunnen variëren).
  try {
    await supabaseAdmin.from('dunning_log').insert({
      run_id: run.id,
      customer_id: customerId,
      event_type: 'manual_pause',
      details: { reason, source: 'inbox', paused_by_user_id: user.id },
    });
  } catch (_) { /* fail-soft */ }

  return res.status(200).json({
    ok: true,
    run_id: run.id,
    previous_status: prevStatus,
    new_status: 'paused',
  });
}
