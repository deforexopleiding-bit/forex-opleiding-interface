// api/arrangements-cancel.js
// POST -> annuleer een payment_arrangement (VOORGESTELD | ACTIEF -> GEANNULEERD) +
// markeer alle openstaande pending_actions als cancelled. Permission:
// finance.arrangements.propose (annuleren is de inverse van voorstellen).
//
// Body: { id: uuid, cancellation_reason?: string, reject_reason?: string (legacy alias), reason?: string (legacy alias) }
//
// State-machine: alleen vanuit 'VOORGESTELD' of 'ACTIEF' is annuleren toegestaan.
// 'NAGEKOMEN' / 'VERBROKEN' / 'GEANNULEERD' -> 409.
//
// NB: cancellation_reason wordt opgeslagen op payment_arrangements (eigen kolom,
// migratie 2026-06-09-payment-arrangements-d1-cancellation-reason.sql). Dit is
// semantisch een cancel — geen reject. De approval-flow zit op pending_actions
// (rejection_reason per actie).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Canonical uppercase + legacy lowercase fallback (rows die nog niet gemigreerd zijn).
const CANCELLABLE = ['VOORGESTELD', 'ACTIEF', 'voorgesteld', 'actief'];

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
  if (!(await requirePermission(req, 'finance.arrangements.propose'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.propose)' });
  }

  const body = req.body || {};
  const id   = body.id ? String(body.id) : null;
  // Canonical: cancellation_reason. Legacy aliases: reject_reason + reason.
  const reason =
    body.cancellation_reason != null && String(body.cancellation_reason).length > 0
      ? String(body.cancellation_reason)
      : body.reject_reason != null && String(body.reject_reason).length > 0
        ? String(body.reject_reason)
        : body.reason != null && String(body.reason).length > 0
          ? String(body.reason)
          : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: arr, error: lookupErr } = await supabaseAdmin
      .from('payment_arrangements')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!arr)      return res.status(404).json({ error: 'Arrangement niet gevonden' });

    if (!CANCELLABLE.includes(arr.status)) {
      return res.status(409).json({
        error: `Annuleren kan alleen vanuit VOORGESTELD|ACTIEF (huidig: ${arr.status})`,
      });
    }

    const nowIso = new Date().toISOString();

    // ---- UPDATE arrangement -> GEANNULEERD ----
    // Schrijf cancellation_reason naar eigen kolom op payment_arrangements
    // (migratie 2026-06-09-payment-arrangements-d1-cancellation-reason.sql).
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('payment_arrangements')
      .update({
        status:              'GEANNULEERD',
        cancellation_reason: reason,
        updated_at:          nowIso,
      })
      .eq('id', id)
      .select('id, status, cancellation_reason, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // ---- UPDATE pending_actions -> CANCELLED (alleen PENDING) ----
    // pending_actions-kolom heet rejection_reason en status-enum is UPPERCASE
    // in deployed DB (PENDING/APPROVED/REJECTED/EXECUTED/FAILED/CANCELLED).
    let cancelledCount = 0;
    try {
      const { data: paUpd, error: paErr } = await supabaseAdmin
        .from('pending_actions')
        .update({
          status:           'CANCELLED',
          rejection_reason: reason || 'arrangement cancelled',
          updated_at:       nowIso,
        })
        .eq('arrangement_id', id)
        .eq('status', 'PENDING')
        .select('id');
      if (paErr) console.error('[arrangements-cancel pending_actions]', paErr.message);
      else cancelledCount = (paUpd || []).length;
    } catch (e) { console.error('[arrangements-cancel pending_actions ex]', e.message); }

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance.arrangement.cancelled',
        entity_type: 'payment_arrangement',
        entity_id:   id,
        after_json:  {
          arrangement_id:            id,
          status:                    'GEANNULEERD',
          cancellation_reason:       reason,
          cancelled_pending_actions: cancelledCount,
        },
        reason_text: reason,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[arrangements-cancel audit]', e.message); }

    return res.status(200).json({
      id:                        updated.id,
      status:                    updated.status,
      cancellation_reason:       updated.cancellation_reason,
      cancelled_pending_actions: cancelledCount,
    });
  } catch (e) {
    console.error('[arrangements-cancel]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
