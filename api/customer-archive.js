// POST /api/customer-archive?id=<uuid>&action=archive|unarchive
// Archiveer of heractiveer een klant (Fase 2A.3 commit 3).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate — consistent met /api/customer).
//
// Query-params:
//   id      uuid  (required) — customer.id
//   action  enum  (required) — 'archive' | 'unarchive'
//
// Body (optional, JSON):
//   { reason: string }  — vrije tekst, opgeslagen in audit_log.reason_text
//
// Semantiek:
//   - archive   → set archived_at = now() (alleen als nog NULL)
//   - unarchive → set archived_at = null  (alleen als nu NIET NULL)
//   - geanonimiseerde klanten (anonymized_at != NULL) → 403 (eindstaat,
//     niet omkeerbaar in 2A.3; AVG-flow in 2C beslist of dit ooit
//     ge-reverteerd mag worden).
//
// Idempotentie:
//   - archive op already-archived   → 200 success, GEEN duplicate audit-entry
//   - unarchive op already-active   → 200 success, GEEN audit-entry
//   (audit-spam vermijden bij dubbele klik / replay-request)
//
// Audit:
//   action=customer.archived   when archived_at gaat van NULL → ts
//   action=customer.unarchived when archived_at gaat van ts   → NULL
//   before_json/after_json = volledige customer-row vóór/na de mutatie
//   reason_text = body.reason (of null)
//
// Response 200: { customer: <volledige row + status/tags/counts> }
// Errors: 400 (id/action) / 403 (auth of anonymized) / 404 / 500.

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
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing customer id' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid customer ID format' });

  const action = String(req.query.action || '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Action must be 'archive' or 'unarchive'", field: 'action' });
  }

  const reason = sanitizeReason(req.body?.reason);

  try {
    // 1) Lees huidige staat — voor audit-before, status-gate, idempotentie-check
    const { data: before, error: bErr } = await supabaseAdmin
      .from('customers').select('*').eq('id', id).maybeSingle();
    if (bErr) throw new Error('customer pre-fetch: ' + bErr.message);
    if (!before) return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2) Anonymized klant = eindstaat, niet omkeerbaar in 2A.3
    if (before.anonymized_at) {
      return res.status(403).json({ error: 'Klant is geanonimiseerd; archive-acties niet beschikbaar.' });
    }

    // 3) Idempotentie: target-state al actief → no-op, geen audit
    const currentlyArchived = before.archived_at != null;
    if (action === 'archive'   && currentlyArchived)  return respondShape(res, id, before);
    if (action === 'unarchive' && !currentlyArchived) return respondShape(res, id, before);

    // 4) Mutatie
    const patch = action === 'archive'
      ? { archived_at: new Date().toISOString() }
      : { archived_at: null };

    const { data: after, error: uErr } = await supabaseAdmin
      .from('customers').update(patch).eq('id', id).select('*').single();
    if (uErr) {
      console.error('[customer-archive]', action, 'update error:', uErr.message);
      return res.status(500).json({ error: uErr.message });
    }

    // 5) Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: action === 'archive' ? 'customer.archived' : 'customer.unarchived',
      customerId: id,
      before, after,
      reason,
      userId: admin.user.id,
    });

    return respondShape(res, id, after);
  } catch (err) {
    console.error('[customer-archive] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Response 200 met consistent customer-shape (matched GET/POST/PATCH /api/customer).
 * 3 extra queries voor tags + notes-count + audit-count zodat UI's renderDetail()
 * deze response 1-op-1 kan hergebruiken na een archive-actie.
 */
async function respondShape(res, id, customer) {
  const { data: tagRows } = await supabaseAdmin
    .from('customer_tags').select('customer_tag_definitions(slug, label, color)').eq('customer_id', id);
  const tags = (tagRows || []).map((r) => r.customer_tag_definitions).filter(Boolean)
    .map((d) => ({ slug: d.slug, label: d.label, color: d.color }));

  const { count: notesCount } = await supabaseAdmin
    .from('customer_notes').select('id', { count: 'exact', head: true })
    .eq('customer_id', id).is('archived_at', null);

  const { count: auditCount } = await supabaseAdmin
    .from('audit_log').select('id', { count: 'exact', head: true })
    .eq('entity_type', 'customer').eq('entity_id', id);

  return res.status(200).json({
    customer: {
      ...customer,
      status: deriveStatus(customer),
      tags,
      notes_count: notesCount || 0,
      audit_count: auditCount || 0,
    },
  });
}

function deriveStatus(c) {
  if (c.anonymized_at) return 'anonymized';
  if (c.archived_at) return 'archived';
  return 'active';
}

/**
 * Normaliseer reason: trim, leeg → null, cap op 500 chars (audit-log-tabel
 * heeft text-kolom maar lange dumps voorkomen).
 */
function sanitizeReason(input) {
  if (input == null) return null;
  const t = String(input).trim();
  if (t === '') return null;
  return t.length > 500 ? t.slice(0, 500) : t;
}
