// api/pending-actions-reject.js
// POST -> markeer een pending_action als 'rejected'. Permission:
// finance.arrangements.approve.
//
// Body: { id: uuid, rejection_reason: string (verplicht) }
//
// State-machine: alleen vanuit status='pending' kan afgewezen worden;
// anders 409 met huidige status.
//
// NB: schema-kolomnamen in deployed DB:
//   - reject_reason        text          (NIET 'rejection_reason')
//   - approved_by_user_id  uuid          (hergebruikt voor 'wie afwees'; geen
//                                         aparte rejected_by-kolom in schema)
//   - approved_at          timestamptz   (functioneert hier als 'beslis-tijdstip')
// De UI/body gebruikt 'rejection_reason' (Engelse semantiek) — we mappen
// dit op de bestaande 'reject_reason'-kolom voor schema-consistentie.

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

  const body   = req.body || {};
  const id     = body.id ? String(body.id) : null;
  const reason = body.rejection_reason ? String(body.rejection_reason).trim() : '';

  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
  if (!reason)                  return res.status(400).json({ error: 'rejection_reason vereist' });

  try {
    // ---- Lookup huidige row ----
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, status, action_type, customer_id, arrangement_id')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!row)      return res.status(404).json({ error: 'Pending action niet gevonden' });

    if (row.status !== 'pending') {
      return res.status(409).json({
        error: `Action is niet meer PENDING (huidige status: ${row.status})`,
      });
    }

    const nowIso = new Date().toISOString();

    // ---- UPDATE -> rejected ----
    // approved_by_user_id + approved_at hergebruikt als 'beslisser' / 'beslis-
    // tijdstip' (geen aparte rejected_by-kolom in schema D1).
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('pending_actions')
      .update({
        status:              'rejected',
        approved_at:         nowIso,
        approved_by_user_id: user.id,
        reject_reason:       reason,
        updated_at:          nowIso,
      })
      .eq('id', id)
      .eq('status', 'pending')   // optimistic concurrency
      .select('id, status, reject_reason, approved_at, approved_by_user_id, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'pending_action.rejected',
        entity_type: 'pending_action',
        entity_id:   id,
        after_json:  {
          id,
          status:         'rejected',
          action_type:    row.action_type,
          customer_id:    row.customer_id,
          arrangement_id: row.arrangement_id,
        },
        reason_text: reason,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[pending-actions-reject audit]', e.message); }

    return res.status(200).json({
      id:                updated.id,
      status:            updated.status,
      rejection_reason:  updated.reject_reason,
    });
  } catch (e) {
    console.error('[pending-actions-reject]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
