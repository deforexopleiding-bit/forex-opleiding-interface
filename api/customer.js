// GET /api/customer?id=<uuid>
// Klant-detail (single row + tags + counts) voor de Klant-detail-pagina (Fase 2A.2).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate — consistent met /api/customers).
//   Granulaire customer.view-check volgt zodra role_permissions repo-wide
//   wordt geactiveerd. Zie TODO-VOLLEDIG.md → "API-laag granulaire RBAC".
//
// Query-params:
//   id   uuid  (required) — customer.id
//
// Response (200):
//   { customer: {
//       id, first_name, last_name, email, phone, date_of_birth,
//       address_street, address_number, address_postal, address_city,
//       tl_contact_id, ghl_contact_id, risk_tag_auto, notes,            // (notes = deprecated text-veld uit customers; behouden voor compat)
//       privacy_accepted_at, privacy_accepted_by_user_id,
//       created_at, updated_at, created_by_user_id,
//       archived_at, anonymized_at, anonymization_reason,
//       status,                                                          // afgeleid uit archived_at/anonymized_at
//       tags: [{slug,label,color}, ...],
//       notes_count,                                                     // customer_notes WHERE archived_at IS NULL
//       audit_count                                                      // audit_log WHERE entity_type='customer' AND entity_id=id
//     } }
//
// Errors:
//   400 — geen id / ongeldig UUID-format
//   403 — verifyAdmin faalt (geen Bearer of geen ADMIN_ROLE)
//   404 — customer bestaat niet
//   405 — method != GET
//   500 — DB-error
//
// Performance: 4 queries (single-row customer, tags-join, notes-count, audit-count).
// counts gebruiken { count: 'exact', head: true } → geen body-payload.

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

  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing customer id' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid customer ID format' });

  try {
    // 1) Single-row customer fetch (maybeSingle → null bij 0 rijen, niet error)
    const { data: customer, error: custErr } = await supabaseAdmin
      .from('customers').select('*').eq('id', id).maybeSingle();
    if (custErr) throw new Error('customer fetch: ' + custErr.message);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2) Tags joined via customer_tag_definitions
    const { data: tagRows, error: tagErr } = await supabaseAdmin
      .from('customer_tags')
      .select('customer_tag_definitions(slug, label, color)')
      .eq('customer_id', id);
    if (tagErr) throw new Error('tags fetch: ' + tagErr.message);
    const tags = (tagRows || [])
      .map((r) => r.customer_tag_definitions)
      .filter(Boolean)
      .map((d) => ({ slug: d.slug, label: d.label, color: d.color }));

    // 3) Notes count (alleen actieve)
    const { count: notesCount, error: nErr } = await supabaseAdmin
      .from('customer_notes').select('id', { count: 'exact', head: true })
      .eq('customer_id', id).is('archived_at', null);
    if (nErr) throw new Error('notes count: ' + nErr.message);

    // 4) Audit count (entity_type='customer')
    const { count: auditCount, error: aErr } = await supabaseAdmin
      .from('audit_log').select('id', { count: 'exact', head: true })
      .eq('entity_type', 'customer').eq('entity_id', id);
    if (aErr) throw new Error('audit count: ' + aErr.message);

    return res.status(200).json({
      customer: {
        ...customer,
        status: deriveStatus(customer),
        tags,
        notes_count: notesCount || 0,
        audit_count: auditCount || 0,
      },
    });
  } catch (err) {
    console.error('[customer] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

function deriveStatus(c) {
  if (c.anonymized_at) return 'anonymized';
  if (c.archived_at) return 'archived';
  return 'active';
}
