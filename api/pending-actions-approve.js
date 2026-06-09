// api/pending-actions-approve.js
// POST -> markeer een pending_action als 'approved'. Permission:
// finance.arrangements.approve.
//
// Body: { id: uuid }
//
// State-machine: alleen vanuit status='pending' kan goedgekeurd worden;
// anders 409 met huidige status.
//
// NB: schema-kolomnamen in deployed DB:
//   - approved_by_user_id  uuid REFERENCES profiles(id)
//   - approved_at          timestamptz
// (De _user_id suffix verschilt van de payment_arrangements-laag waar de
//  kortere alias proposed_by/approved_by op rij-niveau ontbreekt.)
//
// D2 TODO: bij APPROVED en auto_execute=true (of action-type-config in
//          arrangement_action_settings), queue executor om de TL-actie uit
//          te voeren (uitstel -> invoice.update_due_date, gespreid -> split,
//          kwijtschelding -> credit-note, etc.). In D1 alleen status-update;
//          executor-trigger volgt in D2.
//
// F1: MANUAL_VERIFY_PAYMENT (klant-claimt-betaald uit Inbox) is een
//     standalone action zonder arrangement_id. De approve-stap is hier
//     puur een state-transition PENDING -> APPROVED (= Jeffrey gaat
//     handmatig in CAMT verifieren). Mark-executed / mark-not-executed
//     handelen de uitkomst van de bank-check af. Geen extra logica nodig
//     in approve — het endpoint is action_type-agnostic.

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
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    // ---- Lookup huidige row ----
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, status, action_type, customer_id, arrangement_id')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!row)      return res.status(404).json({ error: 'Pending action niet gevonden' });

    if (row.status !== 'PENDING') {
      return res.status(409).json({
        error: `Action is niet meer PENDING (huidige status: ${row.status})`,
      });
    }

    const nowIso = new Date().toISOString();

    // ---- UPDATE -> APPROVED ----
    // pending_actions.status CHECK eist UPPERCASE in deployed DB.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('pending_actions')
      .update({
        status:              'APPROVED',
        approved_at:         nowIso,
        approved_by_user_id: user.id,
        updated_at:          nowIso,
      })
      .eq('id', id)
      .eq('status', 'PENDING')   // optimistic concurrency
      .select('id, status, approved_at, approved_by_user_id, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // D2 TODO: bij APPROVED en auto_execute=true (of action-type-config),
    // queue executor om de TL-actie uit te voeren. In D1 alleen status-update.

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'pending_action.approved',
        entity_type: 'pending_action',
        entity_id:   id,
        after_json:  {
          id,
          status:         'APPROVED',
          action_type:    row.action_type,
          customer_id:    row.customer_id,
          arrangement_id: row.arrangement_id,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[pending-actions-approve audit]', e.message); }

    return res.status(200).json({ id: updated.id, status: updated.status });
  } catch (e) {
    console.error('[pending-actions-approve]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
