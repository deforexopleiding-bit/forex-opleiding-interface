// api/pending-actions-mark-not-executed.js
// POST -> markeer een pending_action handmatig als 'FAILED' (niet door te
// voeren). Permission: finance.arrangements.approve.
//
// Body: { id: uuid, reason?: string, failure_reason?: string }
// (min 10 chars vereist op de gekozen key — `reason` en `failure_reason` zijn
//  aliassen; frontend stuurt historisch `failure_reason`, canonical is `reason`.)
//
// State-machine: alleen vanuit status='APPROVED' kan op FAILED gezet worden;
// anders 409 met huidige status. APPROVED is de uitkomst van de approval-flow;
// FAILED betekent dat de handmatige verwerking niet mogelijk bleek (bv. TL-
// invoice al betaald, klant alsnog akkoord met origineel, etc.).
//
// GEEN automatische cascade naar payment_arrangements. Admin moet zelf
// beslissen of arrangement geannuleerd moet worden (via arrangements-cancel)
// of dat een nieuwe pending_action voorgesteld wordt (via arrangements-propose).
//
// NB: schema-kolomnamen in deployed DB (pending_actions):
//   - status               UPPERCASE enum (PENDING/APPROVED/EXECUTED/FAILED/REJECTED/CANCELLED)
//   - execution_result     jsonb  (failure_reason wordt hier opgeslagen)
//   - updated_at           timestamptz

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

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
  if (!(await requirePermission(req, 'finance.arrangements.approve'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.approve)' });
  }

  const body = req.body || {};
  const id   = body.id ? String(body.id) : null;
  // Accept zowel `reason` (canonical) als `failure_reason` (frontend-legacy).
  // execution_result.failure_reason blijft de DB-key (Engelse semantiek).
  const reasonRaw = typeof body.reason === 'string'
    ? body.reason
    : (typeof body.failure_reason === 'string' ? body.failure_reason : '');
  const reason = reasonRaw.trim();

  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
  if (reason.length < 10) {
    return res.status(400).json({ error: 'reason vereist (min 10 chars)' });
  }

  try {
    // ---- Lookup huidige row ----
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, status, action_type, customer_id, arrangement_id, execution_result')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!row)      return res.status(404).json({ error: 'Pending action niet gevonden' });

    if (row.status !== 'APPROVED') {
      return res.status(409).json({
        error: `Action is niet in APPROVED state (huidige status: ${row.status})`,
      });
    }

    const nowIso = new Date().toISOString();
    // Defensief: user kan in edge-cases zonder id terugkomen.
    const userId = user?.id || null;

    // Merge met bestaande execution_result (jsonb).
    const existingResult = (row.execution_result && typeof row.execution_result === 'object')
      ? row.execution_result
      : {};
    const mergedResult = {
      ...existingResult,
      failure_reason:          reason,
      marked_not_executed_at:  nowIso,
      marked_by_user_id:       userId,
    };

    // ---- UPDATE pending_actions -> FAILED ----
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('pending_actions')
      .update({
        status:           'FAILED',
        execution_result: mergedResult,
        updated_at:       nowIso,
      })
      .eq('id', id)
      .eq('status', 'APPROVED')   // optimistic concurrency
      .select('id, status, execution_result, arrangement_id, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'pending_action.manually_not_executed',
        entity_type: 'pending_action',
        entity_id:   id,
        after_json:  {
          pending_action_id: id,
          status:            'FAILED',
          action_type:       row.action_type,
          customer_id:       row.customer_id,
          arrangement_id:    updated.arrangement_id || row.arrangement_id || null,
          failure_reason:    reason,
        },
        reason_text: reason,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[pending-actions-mark-not-executed audit]', e.message); }

    return res.status(200).json({
      id:     updated.id,
      status: 'FAILED',
      reason,
    });
  } catch (e) {
    console.error('[pending-actions-mark-not-executed]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
