// POST /api/customer-bulk
// Bulk-acties op meerdere klanten in één call (Fase 2A.4 commit 4).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate).
//
// Body (JSON):
//   {
//     action:       'archive' | 'unarchive' | 'tag-add' | 'tag-remove',
//     customer_ids: [<uuid>, ...]   (1..MAX_BULK)
//     tag_slug:     <slug>           (verplicht bij tag-add / tag-remove)
//     reason:       <string>         (optioneel, voor archive — cap 500 chars)
//   }
//
// Semantiek (per customer in customer_ids):
//   archive       → archived_at = now() als nog NULL en niet anonymized
//   unarchive     → archived_at = null als nu NIET NULL en niet anonymized
//   tag-add       → INSERT customer_tags (UNIQUE → no-op + 'already_tagged' fail)
//                   skip als klant archived/anonymized
//   tag-remove    → DELETE customer_tags
//                   skip als klant archived/anonymized
//
// Audit (per geraakte klant — NIET 1 voor de bulk):
//   customer.archived / customer.unarchived / customer.tag.added / customer.tag.removed
//   entity_type='customer', entity_id=<elke klant>
//   reason_text=body.reason (voor archive-acties; tag-acties krijgen null)
//
// Idempotentie:
//   No-op cases (target-state al actief) tellen als 'success' met reason='no_op',
//   GEEN audit-entry. Voorkomt audit-spam bij replay.
//
// Response:
//   HTTP 200 als alles slaagt (incl. no-ops)
//   HTTP 207 Multi-Status als sommige fails
//   HTTP 400 als input invalid
//   Body:
//     {
//       action, total,
//       success_count, fail_count,
//       success: [{ id, no_op?: bool }],
//       failed:  [{ id, reason }]
//     }

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { logCustomerAudit } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9_-]+$/;
const VALID_ACTIONS = new Set(['archive', 'unarchive', 'tag-add', 'tag-remove']);
const MAX_BULK = 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  // ── Validatie ──────────────────────────────────────────────────────────────
  const body = req.body || {};
  const action = String(body.action || '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      error: "Action must be one of: 'archive', 'unarchive', 'tag-add', 'tag-remove'",
      field: 'action',
    });
  }

  const ids = Array.isArray(body.customer_ids) ? body.customer_ids : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'customer_ids must contain at least 1 UUID', field: 'customer_ids' });
  }
  if (ids.length > MAX_BULK) {
    return res.status(400).json({ error: `customer_ids exceeds max ${MAX_BULK} per bulk-call`, field: 'customer_ids' });
  }
  // UUID-format check per id (deduplicatie via Set)
  const uniqueIds = [...new Set(ids.map((x) => String(x || '').trim()))];
  for (const id of uniqueIds) {
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: `Invalid UUID in customer_ids: ${id}`, field: 'customer_ids' });
    }
  }

  let tagSlug = null;
  let tagDef = null;
  if (action === 'tag-add' || action === 'tag-remove') {
    tagSlug = String(body.tag_slug || '').trim().toLowerCase();
    if (!tagSlug) return res.status(400).json({ error: 'tag_slug verplicht bij tag-acties', field: 'tag_slug' });
    if (!SLUG_RE.test(tagSlug)) return res.status(400).json({ error: 'Invalid tag_slug format', field: 'tag_slug' });
    // Tag-definition lookup eenmalig (voor audit-payload + bestaans-check)
    const { data: td, error: tdErr } = await supabaseAdmin
      .from('customer_tag_definitions').select('slug, label, color').eq('slug', tagSlug).maybeSingle();
    if (tdErr) return res.status(500).json({ error: 'tag-def lookup: ' + tdErr.message });
    if (!td) return res.status(404).json({ error: `Tag '${tagSlug}' bestaat niet`, field: 'tag_slug' });
    tagDef = td;
  }

  const reason = sanitizeReason(body.reason);

  // ── Pre-fetch alle customers in 1 query (status-gate + audit-before) ─────
  let customersById;
  try {
    const { data, error } = await supabaseAdmin
      .from('customers').select('*').in('id', uniqueIds);
    if (error) throw new Error('customers pre-fetch: ' + error.message);
    customersById = new Map((data || []).map((c) => [c.id, c]));
  } catch (err) {
    console.error('[customer-bulk] pre-fetch error:', err);
    return res.status(500).json({ error: err.message });
  }

  // ── Loop per klant, best-effort ────────────────────────────────────────────
  const success = [];
  const failed  = [];

  for (const id of uniqueIds) {
    try {
      const before = customersById.get(id);
      if (!before) { failed.push({ id, reason: 'not_found' }); continue; }
      if (before.anonymized_at) { failed.push({ id, reason: 'anonymized' }); continue; }

      if (action === 'archive')        await doArchive(id, before, reason, admin, req, success, failed);
      else if (action === 'unarchive') await doUnarchive(id, before, reason, admin, req, success, failed);
      else if (action === 'tag-add')   await doTagAdd(id, before, tagDef, admin, req, success, failed);
      else if (action === 'tag-remove') await doTagRemove(id, before, tagDef, admin, req, success, failed);
    } catch (err) {
      console.error('[customer-bulk]', action, 'item error:', id, err.message);
      failed.push({ id, reason: err.message || 'unknown_error' });
    }
  }

  const status = failed.length === 0 ? 200 : 207;
  return res.status(status).json({
    action,
    total: uniqueIds.length,
    success_count: success.length,
    fail_count: failed.length,
    success,
    failed,
  });
}

// ── Per-action handlers ──────────────────────────────────────────────────────

async function doArchive(id, before, reason, admin, req, success, failed) {
  if (before.archived_at) { success.push({ id, no_op: true }); return; }
  const nowIso = new Date().toISOString();
  const { data: after, error } = await supabaseAdmin
    .from('customers').update({ archived_at: nowIso }).eq('id', id).select('*').single();
  if (error) { failed.push({ id, reason: error.message }); return; }
  await logCustomerAudit({
    req, action: 'customer.archived', customerId: id,
    before, after, reason, userId: admin.user.id,
  });
  success.push({ id });
}

async function doUnarchive(id, before, reason, admin, req, success, failed) {
  if (!before.archived_at) { success.push({ id, no_op: true }); return; }
  const { data: after, error } = await supabaseAdmin
    .from('customers').update({ archived_at: null }).eq('id', id).select('*').single();
  if (error) { failed.push({ id, reason: error.message }); return; }
  await logCustomerAudit({
    req, action: 'customer.unarchived', customerId: id,
    before, after, reason, userId: admin.user.id,
  });
  success.push({ id });
}

async function doTagAdd(id, before, tagDef, admin, req, success, failed) {
  // Locked-state: archived/anonymized → skip (tag-changes vereisen actieve klant)
  if (before.archived_at) { failed.push({ id, reason: 'archived' }); return; }
  // anonymized_at al gefilterd in main-loop

  const { error } = await supabaseAdmin
    .from('customer_tags').insert({
      customer_id: id, tag_slug: tagDef.slug, created_by_user_id: admin.user.id,
    });
  if (error) {
    const msg = String(error.message || '');
    if (msg.includes('duplicate') || msg.includes('unique')) {
      success.push({ id, no_op: true }); return;  // al gekoppeld = idempotent success
    }
    failed.push({ id, reason: msg });
    return;
  }
  await logCustomerAudit({
    req, action: 'customer.tag.added', customerId: id,
    before: null,
    after: { slug: tagDef.slug, label: tagDef.label, color: tagDef.color },
    userId: admin.user.id,
  });
  success.push({ id });
}

async function doTagRemove(id, before, tagDef, admin, req, success, failed) {
  if (before.archived_at) { failed.push({ id, reason: 'archived' }); return; }

  const { data: deleted, error } = await supabaseAdmin
    .from('customer_tags').delete()
    .eq('customer_id', id).eq('tag_slug', tagDef.slug)
    .select('id');
  if (error) { failed.push({ id, reason: error.message }); return; }
  if (!deleted || deleted.length === 0) {
    success.push({ id, no_op: true }); return;  // niet gekoppeld = idempotent success
  }
  await logCustomerAudit({
    req, action: 'customer.tag.removed', customerId: id,
    before: { slug: tagDef.slug, label: tagDef.label, color: tagDef.color },
    after: null,
    userId: admin.user.id,
  });
  success.push({ id });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeReason(input) {
  if (input == null) return null;
  const t = String(input).trim();
  if (t === '') return null;
  return t.length > 500 ? t.slice(0, 500) : t;
}
