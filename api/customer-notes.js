// GET /api/customer-notes?customer_id=<uuid>[&include_archived=true]
// Notities-lijst voor de Klant-detail-pagina, tab "Communicatie" (Fase 2A.2).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate — consistent met /api/customer).
//   Granulaire customer.notes.read-check volgt zodra role_permissions
//   repo-wide wordt geactiveerd. Zie TODO-VOLLEDIG.md → "API-laag granulaire RBAC".
//
// Query-params:
//   customer_id      uuid     (required) — filtert notes op deze klant
//   include_archived bool     (default false) — als 'true', toon ook archived
//
// Sortering: actieve eerst (archived_at IS NULL bovenaan), dan archived,
//   binnen beide groepen created_at DESC.
//
// Response (200):
//   { notes: [{
//       id, customer_id, body, created_at, updated_at, edited_at, archived_at,
//       created_by: { id: uuid|null, name: string|null }     // null als geen FK of profile-row
//     }, ...] }
//
// XSS: body wordt server-side gewoon getrimd (geen escape) — UI past
//   escapeHtml() toe vóór render.
//
// Errors: 400 (missing/invalid customer_id), 403 (auth), 405 (non-GET), 500 (DB).
//
// Performance: 2 queries (notes-list, profiles-batch voor unique auteur-ids).
//   Geen embed (consistent met /api/customers tags-pattern, vermijdt
//   embed-RLS-edge-cases als profiles-RLS later strenger wordt).
//   Geen pagination in 2A.2 (typisch <100 notes per klant).
//   Bij groei: voeg ?page + ?page_size toe met range()-paging.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  const customerId = String(req.query.customer_id || '').trim();
  if (!customerId) return res.status(400).json({ error: 'Missing customer_id' });
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'Invalid customer_id format' });

  const includeArchived = String(req.query.include_archived || '').toLowerCase() === 'true';

  try {
    // 1) Notes-list
    let q = supabaseAdmin
      .from('customer_notes')
      .select('id, customer_id, body, created_at, updated_at, edited_at, archived_at, created_by_user_id')
      .eq('customer_id', customerId);
    if (!includeArchived) q = q.is('archived_at', null);
    // Actieve (archived_at NULL) eerst, dan archived; binnen elke groep created_at DESC.
    // Supabase order met nullsFirst: true → NULL bovenaan (= actieve eerst voor ASC).
    // We willen NULL eerst ongeacht ASC/DESC → expliciet nullsFirst:true op archived_at ASC.
    q = q.order('archived_at', { ascending: true, nullsFirst: true })
         .order('created_at', { ascending: false });
    const { data: notes, error: nErr } = await q;
    if (nErr) throw new Error('notes fetch: ' + nErr.message);

    // 2) Auteurs (batch via .in() op unique user_ids, client-side merge)
    const userIds = [...new Set((notes || []).map((n) => n.created_by_user_id).filter(Boolean))];
    const authorsById = {};
    if (userIds.length) {
      const { data: profs, error: pErr } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', userIds);
      if (pErr) throw new Error('profiles fetch: ' + pErr.message);
      for (const p of profs || []) authorsById[p.id] = p;
    }

    const formatted = (notes || []).map((n) => ({
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

    return res.status(200).json({ notes: formatted });
  } catch (err) {
    console.error('[customer-notes] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}
