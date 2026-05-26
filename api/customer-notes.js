// /api/customer-notes — Notities CRUD (Fase 2A.2 GET, Fase 2A.4 POST/PATCH).
//
// Methods:
//   GET    ?customer_id=<uuid>[&include_archived=true]   → notes-lijst         [2A.2]
//   POST   body: { customer_id, body }                   → nieuwe notitie      [2A.4]
//   PATCH  ?id=<note_uuid> body: { body }                → notitie-body update [2A.4]
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate).
//
// Status-gate (POST/PATCH):
//   archived/anonymized parent-klant → 403 (geen nieuwe notes / edits).
//   Archive van bestaande notes loopt via /api/customer-note-archive (soft-delete,
//   wél toegestaan voor data-cleanup ook op locked klanten).
//
// Audit (entity_type='customer', entity_id=parent-customer_id):
//   customer.note.created  → before=null, after={note_id, body}
//   customer.note.updated  → before={note_id, body:old}, after={note_id, body:new, edited_at}
//   customer.note.archived → in customer-note-archive.js
//
// XSS: body wordt server-side getrimd (geen escape) — UI past escapeHtml() toe.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { logCustomerAudit } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MAX = 10000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  if (req.method === 'GET')   return handleGet(req, res);
  if (req.method === 'POST')  return handlePost(req, res, admin);
  if (req.method === 'PATCH') return handlePatch(req, res, admin);

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

// ── GET — lijst (2A.2, ongewijzigd) ──────────────────────────────────────────

async function handleGet(req, res) {
  const customerId = String(req.query.customer_id || '').trim();
  if (!customerId) return res.status(400).json({ error: 'Missing customer_id' });
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'Invalid customer_id format' });

  const includeArchived = String(req.query.include_archived || '').toLowerCase() === 'true';

  try {
    let q = supabaseAdmin
      .from('customer_notes')
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .eq('customer_id', customerId);
    if (!includeArchived) q = q.is('archived_at', null);
    q = q.order('archived_at', { ascending: true, nullsFirst: true })
         .order('created_at', { ascending: false });
    const { data: notes, error: nErr } = await q;
    if (nErr) throw new Error('notes fetch: ' + nErr.message);

    const formatted = await attachAuthors(notes || []);
    return res.status(200).json({ notes: formatted });
  } catch (err) {
    console.error('[customer-notes GET] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── POST — nieuwe notitie (2A.4) ─────────────────────────────────────────────

async function handlePost(req, res, admin) {
  const body = req.body || {};
  const customerId = String(body.customer_id || '').trim();
  const text = String(body.body || '').trim();

  if (!customerId) return res.status(400).json({ error: 'Missing customer_id', field: 'customer_id' });
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'Invalid customer_id format', field: 'customer_id' });
  if (!text) return res.status(400).json({ error: 'Notitie mag niet leeg zijn', field: 'body' });
  if (text.length > BODY_MAX) return res.status(400).json({ error: `Notitie te lang (max ${BODY_MAX} tekens)`, field: 'body' });

  try {
    // Status-gate via parent-klant
    const parent = await fetchParentStatus(customerId);
    if (!parent) return res.status(404).json({ error: 'Klant niet gevonden' });
    const lockedErr = checkLocked(parent);
    if (lockedErr) return res.status(403).json(lockedErr);

    // INSERT
    const { data: note, error: insErr } = await supabaseAdmin
      .from('customer_notes').insert({
        customer_id: customerId,
        body: text,
        created_by_user_id: admin.user.id,
      })
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .single();
    if (insErr) {
      console.error('[customer-notes POST] insert error:', insErr.message);
      return res.status(500).json({ error: insErr.message });
    }

    // Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: 'customer.note.created',
      customerId: customerId,
      before: null,
      after: { note_id: note.id, body: note.body },
      userId: admin.user.id,
    });

    const [formatted] = await attachAuthors([note]);
    return res.status(201).json({ note: formatted });
  } catch (err) {
    console.error('[customer-notes POST] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── PATCH — body-update (2A.4) ───────────────────────────────────────────────
//
// Query: ?id=<note_uuid>  (verplicht)
// Body : { body }         (verplicht, non-empty na trim)
//
// edited_at wordt expliciet gezet op now() (trigger zet alleen updated_at).
// Status-gate: kan niet bewerken als parent-klant archived/anonymized.
// archived notes zelf: ook 403 (eerst un-archiveren via -archive endpoint).

async function handlePatch(req, res, admin) {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing note id' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid note id format' });

  const body = req.body || {};
  const text = String(body.body || '').trim();
  if (!text) return res.status(400).json({ error: 'Notitie mag niet leeg zijn', field: 'body' });
  if (text.length > BODY_MAX) return res.status(400).json({ error: `Notitie te lang (max ${BODY_MAX} tekens)`, field: 'body' });

  try {
    // Fetch existing note (voor audit-before, parent-id, status-gate)
    const { data: before, error: bErr } = await supabaseAdmin
      .from('customer_notes')
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .eq('id', id).maybeSingle();
    if (bErr) throw new Error('note pre-fetch: ' + bErr.message);
    if (!before) return res.status(404).json({ error: 'Notitie niet gevonden' });
    if (before.archived_at) return res.status(403).json({ error: 'Notitie is gearchiveerd; eerst heractiveren.' });

    // Parent-klant status-gate
    const parent = await fetchParentStatus(before.customer_id);
    if (!parent) return res.status(404).json({ error: 'Bovenliggende klant niet gevonden' });
    const lockedErr = checkLocked(parent);
    if (lockedErr) return res.status(403).json(lockedErr);

    // No-op check: zelfde body → 200 zonder UPDATE + audit
    if (before.body === text) {
      const [formatted] = await attachAuthors([before]);
      return res.status(200).json({ note: formatted });
    }

    // UPDATE met expliciete edited_at = now() (trigger zet updated_at)
    const nowIso = new Date().toISOString();
    const { data: after, error: uErr } = await supabaseAdmin
      .from('customer_notes')
      .update({ body: text, edited_at: nowIso })
      .eq('id', id)
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .single();
    if (uErr) {
      console.error('[customer-notes PATCH] update error:', uErr.message);
      return res.status(500).json({ error: uErr.message });
    }

    // Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: 'customer.note.updated',
      customerId: before.customer_id,
      before: { note_id: before.id, body: before.body },
      after:  { note_id: after.id,  body: after.body, edited_at: after.edited_at },
      userId: admin.user.id,
    });

    const [formatted] = await attachAuthors([after]);
    return res.status(200).json({ note: formatted });
  } catch (err) {
    console.error('[customer-notes PATCH] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchParentStatus(customerId) {
  const { data, error } = await supabaseAdmin
    .from('customers').select('id, archived_at, anonymized_at').eq('id', customerId).maybeSingle();
  if (error) throw new Error('parent fetch: ' + error.message);
  return data;
}

function checkLocked(c) {
  if (c.anonymized_at) return { error: 'Klant is geanonimiseerd; notitie-mutaties niet beschikbaar.' };
  if (c.archived_at)   return { error: 'Klant is gearchiveerd; eerst heractiveren.' };
  return null;
}

/**
 * Verrijk notes-list met created_by:{id,name} via batch profiles-fetch
 * + client-side merge (consistent met /api/customers tags-pattern).
 */
async function attachAuthors(notes) {
  const userIds = [...new Set((notes || []).map((n) => n.created_by_user_id).filter(Boolean))];
  const authorsById = {};
  if (userIds.length) {
    const { data: profs, error: pErr } = await supabaseAdmin
      .from('profiles').select('id, full_name').in('id', userIds);
    if (pErr) throw new Error('profiles fetch: ' + pErr.message);
    for (const p of profs || []) authorsById[p.id] = p;
  }
  return (notes || []).map((n) => ({
    id: n.id,
    customer_id: n.customer_id,
    body: (n.body || '').trim(),
    created_at: n.created_at,
    updated_at: n.updated_at,
    edited_at: n.edited_at,
    archived_at: n.archived_at,
    created_by: {
      id: n.created_by_user_id || null,
      name: n.created_by_user_id ? (authorsById[n.created_by_user_id]?.full_name || null) : null,
    },
  }));
}
