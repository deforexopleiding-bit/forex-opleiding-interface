// GET /api/customers
// Klant-overzicht: lijst-mode (default) of stats-mode (?stats=true voor KPI-bar).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate — super_admin/admin/manager).
//   Granulaire customer.view-check volgt zodra role_permissions repo-wide
//   wordt geactiveerd. Zie TODO-VOLLEDIG.md → "API-laag granulaire RBAC".
//
// Query-params (lijst-mode):
//   search          string  — case-insensitive ILIKE op first_name/last_name/company_name/email/phone.
//                             Multi-woord: elke spatie-gescheiden term moet ergens in één van
//                             die kolommen voorkomen (AND tussen woorden, OR tussen kolommen).
//                             "Test Standalone" matched dus zowel company_name="Test Standalone"
//                             als first_name="Test"+last_name="Standalone".
//   tags            CSV     — slugs uit customer_tag_definitions ("heeft tenminste 1 van")
//   status          CSV     — active|archived|anonymized (default: active alleen)
//   created_from    ISO     — ondergrens op customers.created_at (inclusief)
//   created_to      ISO     — bovengrens op customers.created_at (inclusief)
//   sales_user_id   string  — geaccepteerd maar genegeerd (kolom bestaat nog niet, Fase 2B+)
//   sort_by         enum    — first_name|last_name|created_at|last_contact_at
//                             (last_contact_at valt terug op created_at; geen kolom)
//   sort_dir        enum    — asc|desc (default desc)
//   page            int     — 1-based (default 1)
//   page_size       int     — default 25, clamp [1..100]
//
// Stats-mode (?stats=true): retourneert {stats:{active,new_this_month,risico,
//   wanbetalers_placeholder:0}}. wanbetalers-tegel wacht op Finance-module.
//
// Response (lijst-mode):
//   { customers: [{id,first_name,last_name,email,phone,created_at,tags:[{slug,label,color}],
//                  status, deal_count_active:0, last_contact_at:null}, ...],
//     total, page, page_size, total_pages }
//
// Performance-noot: tags worden via aparte query gejoind (vermijdt embed-RLS-edge-cases
// en houdt counts/pagination simpel op de hoofdquery).

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const SORT_WHITELIST = new Set(['first_name', 'last_name', 'created_at', 'last_contact_at']);
const STATUS_WHITELIST = new Set(['active', 'archived', 'anonymized']);

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

  try {
    if (String(req.query.stats || '').toLowerCase() === 'true') {
      return await respondStats(res);
    }
    return await respondList(req, res);
  } catch (err) {
    console.error('[customers] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Lijst-mode ────────────────────────────────────────────────────────────────

async function respondList(req, res) {
  const q = req.query;

  const search = String(q.search || '').trim();
  const tags = parseCsv(q.tags).filter(Boolean);
  const statusRaw = parseCsv(q.status).filter((s) => STATUS_WHITELIST.has(s));
  const statuses = statusRaw.length ? statusRaw : ['active'];
  const createdFrom = q.created_from || null;
  const createdTo = q.created_to || null;

  // Sort (whitelist + last_contact_at fallback)
  let sortBy = String(q.sort_by || 'created_at');
  if (!SORT_WHITELIST.has(sortBy)) sortBy = 'created_at';
  if (sortBy === 'last_contact_at') sortBy = 'created_at'; // kolom bestaat niet (placeholder)
  const sortDir = String(q.sort_dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  // Pagination
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const rawSize = parseInt(q.page_size, 10) || 25;
  const pageSize = Math.min(100, Math.max(1, rawSize));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Tags-filter: pre-fetch matching customer_ids (subquery-equivalent)
  let tagFilteredIds = null;
  if (tags.length) {
    const { data: tagRows, error: tagErr } = await supabaseAdmin
      .from('customer_tags').select('customer_id').in('tag_slug', tags);
    if (tagErr) throw new Error('tag filter: ' + tagErr.message);
    tagFilteredIds = [...new Set((tagRows || []).map((r) => r.customer_id))];
    if (tagFilteredIds.length === 0) {
      return res.status(200).json({
        customers: [], total: 0, page, page_size: pageSize, total_pages: 0,
      });
    }
  }

  // Hoofdquery
  let query = supabaseAdmin.from('customers').select('*', { count: 'exact' });

  // Status (active default = archived_at NULL AND anonymized_at NULL)
  const statusOr = [];
  if (statuses.includes('active'))     statusOr.push('and(archived_at.is.null,anonymized_at.is.null)');
  if (statuses.includes('archived'))   statusOr.push('and(archived_at.not.is.null,anonymized_at.is.null)');
  if (statuses.includes('anonymized')) statusOr.push('anonymized_at.not.is.null');
  if (statusOr.length) query = query.or(statusOr.join(','));

  // Search (ILIKE OR-combo over 5 velden, per-woord AND-gecombineerd).
  //
  // Bug vóór fix: enkele .or() met het volledige search-pattern matched "Test
  // Standalone" alleen als één enkele kolom de complete string bevat (bv.
  // company_name="Test Standalone"). Een B2C-klant met first_name="Test" en
  // last_name="Standalone" werd gemist — geen kolom op zichzelf bevat de hele
  // string. Side-note tijdens PR #90 visuele check.
  //
  // Fix: split de search op whitespace en chain meerdere .or()-calls. Elke .or()
  // doet OR over alle kolommen voor één woord; chained .or()-calls worden door
  // PostgREST/supabase-js AND-gecombineerd. Resultaat:
  //   "Test Standalone" → AND( OR(*ilike%Test%), OR(*ilike%Standalone%) )
  // Matched dus zowel:
  //   - company_name="Test Standalone" (beide woorden in dezelfde kolom)
  //   - first_name="Test" + last_name="Standalone" (woord per kolom)
  // Voor single-word search blijft gedrag identiek aan vóór de fix.
  if (search) {
    const words = search.split(/\s+/).filter(Boolean);
    for (const w of words) {
      // Escape PostgREST OR-special chars (comma + parentheses); % en _ blijven SQL wildcards
      const esc = w.replace(/[,()]/g, ' ');
      const pat = `%${esc}%`;
      query = query.or(
        `first_name.ilike.${pat},last_name.ilike.${pat},company_name.ilike.${pat},email.ilike.${pat},phone.ilike.${pat}`
      );
    }
  }

  if (tagFilteredIds) query = query.in('id', tagFilteredIds);
  if (createdFrom) query = query.gte('created_at', createdFrom);
  if (createdTo)   query = query.lte('created_at', createdTo);

  query = query.order(sortBy, { ascending: sortDir === 'asc' }).range(from, to);

  const { data: customers, error, count } = await query;
  if (error) throw new Error(error.message);

  // Tags client-side joinen (alleen voor de zichtbare pagina)
  const ids = (customers || []).map((c) => c.id);
  const tagsByCustomer = {};
  if (ids.length) {
    const { data: joinRows, error: joinErr } = await supabaseAdmin
      .from('customer_tags')
      .select('customer_id, customer_tag_definitions(slug, label, color)')
      .in('customer_id', ids);
    if (joinErr) throw new Error('tags join: ' + joinErr.message);
    for (const r of joinRows || []) {
      const def = r.customer_tag_definitions;
      if (!def) continue;
      (tagsByCustomer[r.customer_id] ||= []).push({
        slug: def.slug, label: def.label, color: def.color,
      });
    }
  }

  const total = count || 0;
  return res.status(200).json({
    customers: (customers || []).map((c) => ({
      id: c.id,
      is_company: c.is_company,
      company_name: c.company_name,
      tl_contact_id: c.tl_contact_id,
      tl_company_id: c.tl_company_id,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone,
      created_at: c.created_at,
      tags: tagsByCustomer[c.id] || [],
      status: deriveStatus(c),
      deal_count_active: 0,    // placeholder — Sales-module (Fase 2B+)
      last_contact_at: null,   // placeholder — Sales-module / WhatsApp-laag
    })),
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  });
}

// ── Stats-mode (KPI mini-bar) ─────────────────────────────────────────────────

async function respondStats(res) {
  // Active count (archived_at IS NULL AND anonymized_at IS NULL)
  const { count: active, error: e1 } = await supabaseAdmin
    .from('customers').select('id', { count: 'exact', head: true })
    .is('archived_at', null).is('anonymized_at', null);
  if (e1) throw new Error('stats active: ' + e1.message);

  // New this month — UTC first-of-month grens
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { count: newThisMonth, error: e2 } = await supabaseAdmin
    .from('customers').select('id', { count: 'exact', head: true })
    .is('archived_at', null).is('anonymized_at', null)
    .gte('created_at', monthStart);
  if (e2) throw new Error('stats new_this_month: ' + e2.message);

  // Risico — actieve klanten met tag 'risico'
  const { data: riskTagRows, error: e3 } = await supabaseAdmin
    .from('customer_tags').select('customer_id').eq('tag_slug', 'risico');
  if (e3) throw new Error('stats risico tags: ' + e3.message);
  const riskIds = [...new Set((riskTagRows || []).map((r) => r.customer_id))];
  let risico = 0;
  if (riskIds.length) {
    const { count, error: e4 } = await supabaseAdmin
      .from('customers').select('id', { count: 'exact', head: true })
      .in('id', riskIds).is('archived_at', null).is('anonymized_at', null);
    if (e4) throw new Error('stats risico count: ' + e4.message);
    risico = count || 0;
  }

  return res.status(200).json({
    stats: {
      active: active || 0,
      new_this_month: newThisMonth || 0,
      risico,
      wanbetalers_placeholder: 0, // Komt later (Finance-module, Fase 3)
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveStatus(c) {
  if (c.anonymized_at) return 'anonymized';
  if (c.archived_at) return 'archived';
  return 'active';
}

function parseCsv(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x) => parseCsv(x));
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
