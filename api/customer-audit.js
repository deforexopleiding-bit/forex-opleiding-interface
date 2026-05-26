// GET /api/customer-audit?customer_id=<uuid>[&page=1&page_size=50]
// Audit-history voor de Klant-detail-pagina, tab "Audit" (Fase 2A.3).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate — consistent met /api/customer).
//   Granulaire customer.audit.view-check volgt zodra role_permissions
//   wordt geactiveerd (key bestaat al in FEATURE_REGISTRY uit Fase 1).
//
// Query-params:
//   customer_id  uuid  (required)
//   page         int   (default 1)
//   page_size    int   (default 50, clamp [1..100])
//
// Sortering: created_at DESC (nieuwste eerst — audit-conventie).
//
// Response (200):
//   { entries: [{
//       id, action, created_at, reason_text, ip_address,
//       actor:      { id: uuid|null, name: string|null },
//       diff:       [{ field, before, after }, ...],   // server-computed compacte diff
//       raw_before: object|null,                        // volledige JSONB voor expand-detail
//       raw_after:  object|null
//     }, ...],
//     total, page, page_size, total_pages
//   }
//
// Performance: 2 queries (audit_log paginated + profiles batch via .in()).
//   Index idx_audit_log_entity uit migratie 012 ondersteunt entity_type+entity_id+ts-sort.
//
// PII-noot: response bevat full before/after JSONB met PII (email/phone/address).
//   UI dashboard is intern, RLS op audit_log blokkeert anonymous reads.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Velden die NIET in de compacte diff getoond worden (server-managed timestamps,
// FK's die de UI als context elders toont). Audit-entry blijft de raw_before/after
// JSONB bevatten voor wie de volledige geschiedenis nodig heeft.
const DIFF_EXCLUDE_FIELDS = new Set([
  'updated_at', 'created_at', 'id', 'created_by_user_id',
]);

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

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rawSize = parseInt(req.query.page_size, 10) || 50;
  const pageSize = Math.min(100, Math.max(1, rawSize));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    // 1) Audit-entries paginated (count: exact voor total)
    const { data: rows, error: aErr, count } = await supabaseAdmin
      .from('audit_log')
      .select('id, user_id, action, before_json, after_json, reason_text, ip_address, created_at', { count: 'exact' })
      .eq('entity_type', 'customer')
      .eq('entity_id', customerId)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (aErr) throw new Error('audit fetch: ' + aErr.message);

    // 2) Actor-namen (batch via .in() op unique user_ids, client-side merge —
    //    consistent met /api/customer-notes en /api/customers tags-pattern)
    const userIds = [...new Set((rows || []).map((r) => r.user_id).filter(Boolean))];
    const actorsById = {};
    if (userIds.length) {
      const { data: profs, error: pErr } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', userIds);
      if (pErr) throw new Error('profiles fetch: ' + pErr.message);
      for (const p of profs || []) actorsById[p.id] = p;
    }

    const total = count || 0;
    const entries = (rows || []).map((r) => ({
      id: r.id,
      action: r.action,
      created_at: r.created_at,
      reason_text: r.reason_text,
      ip_address: r.ip_address,
      actor: {
        id: r.user_id || null,
        name: r.user_id ? (actorsById[r.user_id]?.full_name || null) : null,
      },
      diff: computeDiff(r.before_json, r.after_json),
      raw_before: r.before_json || null,
      raw_after:  r.after_json  || null,
    }));

    return res.status(200).json({
      entries,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[customer-audit] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Server-side diff van 2 JSONB objects → array van {field, before, after}.
 * - System-velden uit DIFF_EXCLUDE_FIELDS worden overgeslagen.
 * - Velden waar before === after (deep-equality via JSON-stringify) worden overgeslagen.
 * - Bij create: before=null → toont alleen 'after' waarden (after-only fields).
 * - Bij archive/unarchive: typisch alleen archived_at-row.
 * - Volgorde: alfabetisch op field-naam (deterministisch voor UI).
 */
function computeDiff(before, after) {
  const a = (before && typeof before === 'object') ? before : {};
  const b = (after  && typeof after  === 'object') ? after  : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if (DIFF_EXCLUDE_FIELDS.has(k)) continue;
    const va = a[k] ?? null;
    const vb = b[k] ?? null;
    // Deep-compare via JSON.stringify (voldoende voor flat customer-rows; geen nested objects)
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    out.push({ field: k, before: va, after: vb });
  }
  out.sort((x, y) => x.field.localeCompare(y.field));
  return out;
}
