// api/pending-actions-restore.js
// Acties-tab confirms/undo PR — Zet een pending_action terug naar PENDING
// vanuit een terminal status (REJECTED / EXECUTED / FAILED). Puur veiligheids-
// net voor per-ongeluk-klikken: gebruiker klikte "Afgehandeld" of "Overslaan"
// en wil het terugdraaien.
//
// Body:
//   {
//     id:     uuid   (required),
//     reason: string (min 5, max 500, required — audit-spoor)
//   }
//
// Toegestane transities (whitelist):
//   REJECTED / EXECUTED / FAILED  ->  PENDING
//
// GEBLOKKEERDE COMBINATIE (kritiek):
//   TL_* + EXECUTED → 409 met code TL_EXECUTED_LOCKED. Semantiek: de TL-
//   mutatie is al doorgevoerd in TeamLeader (credit-note, subscription-
//   stop, invoice-due-verplaatst). Onze DB terugzetten geeft een halve
//   staat — systeem zegt "PENDING" terwijl TL de mutatie al heeft. UI
//   moet voor die gevallen geen restore-knop tonen; deze server-side
//   check is de definitieve poort.
//
// Cascade-veiligheid:
//   Bij een succesvolle restore wordt payment_arrangements NIET
//   gemuteerd — arrangement blijft in zijn huidige status. Dit is
//   bewust: mark-executed heeft mogelijk een arrangement op ACTIEF
//   gezet, en die state is de "waarheid" tot iemand 'em expliciet
//   annuleert. Restore is een UI-per-ongeluk-fix, geen volledige
//   reverse van downstream effecten.
//
// Audit: audit_log.action='pending_action.restored' met from_status,
//        to_status, reason, action_type, customer_id, arrangement_id.
//
// Permission: finance.arrangements.approve (zelfde als approve/reject/
// mark-executed — wie mag afsluiten mag ook terugdraaien).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESTORABLE_STATUSES = new Set(['REJECTED', 'EXECUTED', 'FAILED']);

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

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!id) return res.status(400).json({ error: 'id (uuid) verplicht' });
  if (reason.length < 5) return res.status(400).json({ error: 'reason (min 5 chars) verplicht' });
  if (reason.length > 500) return res.status(400).json({ error: 'reason max 500 chars' });

  try {
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('pending_actions')
      .select('id, status, action_type, customer_id, arrangement_id')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!row) return res.status(404).json({ error: 'Pending action niet gevonden' });

    const fromStatus = String(row.status || '').toUpperCase();
    if (!RESTORABLE_STATUSES.has(fromStatus)) {
      return res.status(409).json({
        error: 'Alleen REJECTED, EXECUTED of FAILED kan teruggezet — huidige status: ' + fromStatus,
      });
    }

    // TL_* + EXECUTED lock: TL heeft de mutatie al doorgevoerd, undo geeft
    // halve staat. Server-side hard blokkeren zodat DevTools-bypass ook faalt.
    const isTL       = String(row.action_type || '').startsWith('TL_');
    const isExecuted = fromStatus === 'EXECUTED';
    if (isTL && isExecuted) {
      return res.status(409).json({
        code:  'TL_EXECUTED_LOCKED',
        error: 'TL-arrangements die al zijn uitgevoerd kunnen niet worden teruggezet — de mutatie in TeamLeader (credit-note / subscription-stop / factuur-datum) is al gedaan. Corrigeer eerst handmatig in TL.',
      });
    }

    const nowIso = new Date().toISOString();
    const userId = user?.id || null;

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('pending_actions')
      .update({
        status:     'PENDING',
        // Executed-metadata behouden als historisch spoor in execution_result
        // (die JSONB blijft staan). Alleen de status-transitie-velden clearen:
        executed_at:         null,
        executed_by_user_id: null,
        rejection_reason:    null,
        updated_at:          nowIso,
      })
      .eq('id', id)
      .eq('status', fromStatus)   // optimistic concurrency op source-status
      .select('id, status, action_type, customer_id, arrangement_id')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    // Audit-log (fail-soft)
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'pending_action.restored',
        entity_type: 'pending_action',
        entity_id:   id,
        after_json: {
          pending_action_id: id,
          from_status:       fromStatus,
          to_status:         'PENDING',
          reason,
          action_type:       row.action_type,
          customer_id:       row.customer_id,
          arrangement_id:    row.arrangement_id,
          restored_at:       nowIso,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.warn('[pending-actions-restore audit]', e.message);
    }

    return res.status(200).json({
      ok:          true,
      id:          updated.id,
      from_status: fromStatus,
      to_status:   'PENDING',
      action_type: updated.action_type,
    });
  } catch (e) {
    console.error('[pending-actions-restore]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
