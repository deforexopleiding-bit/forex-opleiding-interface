// POST /api/customer-note-archive?id=<note_uuid>&action=archive|unarchive
// Soft-delete / heractiveer een notitie (Fase 2A.4).
//
// Auth: verifyAdmin(req).
//
// Body (optional, JSON): { reason: string } — opgeslagen in audit_log.reason_text.
//
// Semantiek:
//   - archive   → archived_at = now() (alleen als nog NULL)
//   - unarchive → archived_at = null  (alleen als nu NIET NULL)
//   - parent-klant anonymized → 403 (eindstaat, geen mutaties op child-data).
//   - parent-klant archived → archive/unarchive van notes wél toegestaan
//     (data-cleanup mag ook op gearchiveerde klanten).
//
// Idempotentie:
//   - archive op already-archived   → 200, GEEN duplicate audit-entry
//   - unarchive op already-active   → 200, GEEN audit-entry
//
// Audit (entity_type='customer', entity_id=parent-customer_id):
//   customer.note.archived   → before={note_id, archived_at:null},
//                              after ={note_id, archived_at:<ts>}
//   customer.note.unarchived → omgekeerd
//
// Response 200: { note: { id, customer_id, body, archived_at, ... } }
// Errors: 400 (id/action) / 403 (auth of parent anonymized) / 404 / 405 / 500.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { logCustomerAudit } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(['archive', 'unarchive']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing note id' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid note id format' });

  const action = String(req.query.action || '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Action must be 'archive' or 'unarchive'", field: 'action' });
  }

  const reason = sanitizeReason(req.body?.reason);

  try {
    // 1) Fetch note (voor audit-before, parent-id, idempotentie)
    const { data: before, error: bErr } = await supabaseAdmin
      .from('customer_notes')
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .eq('id', id).maybeSingle();
    if (bErr) throw new Error('note pre-fetch: ' + bErr.message);
    if (!before) return res.status(404).json({ error: 'Notitie niet gevonden' });

    // 2) Parent-klant status-gate: anonymized → 403; archived → toegestaan
    const { data: parent, error: pErr } = await supabaseAdmin
      .from('customers').select('id, anonymized_at').eq('id', before.customer_id).maybeSingle();
    if (pErr) throw new Error('parent fetch: ' + pErr.message);
    if (parent?.anonymized_at) {
      return res.status(403).json({ error: 'Bovenliggende klant is geanonimiseerd; mutaties niet beschikbaar.' });
    }

    // 3) Idempotentie: target-state al actief → no-op, geen audit
    const currentlyArchived = before.archived_at != null;
    if (action === 'archive'   && currentlyArchived)  return respondNote(res, before, admin);
    if (action === 'unarchive' && !currentlyArchived) return respondNote(res, before, admin);

    // 4) Mutatie
    const patch = action === 'archive'
      ? { archived_at: new Date().toISOString() }
      : { archived_at: null };

    const { data: after, error: uErr } = await supabaseAdmin
      .from('customer_notes').update(patch).eq('id', id)
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .single();
    if (uErr) {
      console.error('[customer-note-archive]', action, 'update error:', uErr.message);
      return res.status(500).json({ error: uErr.message });
    }

    // 5) Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: action === 'archive' ? 'customer.note.archived' : 'customer.note.unarchived',
      customerId: before.customer_id,
      before: { note_id: before.id, archived_at: before.archived_at },
      after:  { note_id: after.id,  archived_at: after.archived_at },
      reason,
      userId: admin.user.id,
    });

    return respondNote(res, after, admin);
  } catch (err) {
    console.error('[customer-note-archive] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Response 200 met note + author resolved (consistent met /api/customer-notes shape).
 */
async function respondNote(res, note, admin) {
  let authorName = null;
  if (note.created_by_user_id) {
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('full_name').eq('id', note.created_by_user_id).maybeSingle();
    authorName = prof?.full_name || null;
  }
  return res.status(200).json({
    note: {
      id: note.id,
      customer_id: note.customer_id,
      body: (note.body || '').trim(),
      created_at: note.created_at,
      updated_at: note.updated_at,
      edited_at: note.edited_at,
      archived_at: note.archived_at,
      created_by: {
        id: note.created_by_user_id || null,
        name: authorName,
      },
    },
  });
}

function sanitizeReason(input) {
  if (input == null) return null;
  const t = String(input).trim();
  if (t === '') return null;
  return t.length > 500 ? t.slice(0, 500) : t;
}
