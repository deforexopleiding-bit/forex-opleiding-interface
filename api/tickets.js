// api/tickets.js
//
// GET  /api/tickets[?status=X&type=Y&module=Z]
//      → { tickets: [...], counts: { open, in_progress, resolved, closed } }
//      counts zijn over ALLE statussen (gefilterd door type/module), zodat
//      tab-badges correct blijven ongeacht actieve status-filter.
//
// POST /api/tickets
//      Body: { title, description?, type, priority?, module? }
//      → 201 { ticket: <created row + creator name> }
//
// Auth: createUserClient(req) — RLS dekt zichtbaarheid + INSERT (created_by check).
// Names: createUserClient queriet tickets (RLS-aware); supabaseAdmin doet 1
//        batch-lookup voor user-namen (geen PostgREST embed gebruikt in deze
//        codebase, profiles RLS-state niet bevestigd → pragmatic enrich-pattern).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { createNotification } from './_lib/notify.js';

const VALID_STATUSES   = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_TYPES      = ['bug', 'feature', 'question'];
const VALID_PRIORITIES = ['laag', 'middel', 'hoog'];

// Client-side sort: 'priority' is text-kolom. Alfabetische DB-sort zou
// 'hoog' > 'laag' > 'middel' geven (foutief). Daarom sorteren we in JS
// na de fetch, met de DB die alleen op created_at sorteert als secundair.
const PRIORITY_RANK = { hoog: 3, middel: 2, laag: 1 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  if (req.method === 'GET')  return handleList(req, res, supabase);
  if (req.method === 'POST') return handleCreate(req, res, supabase, user);
}

// ── GET — lijst + counts ─────────────────────────────────────────────────────

async function handleList(req, res, supabase) {
  const { status, type, module: moduleFilter } = req.query;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Ongeldige status: ${status}` });
  }
  if (type && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Ongeldig type: ${type}` });
  }

  // ── Counts per status (gefilterd door type/module, NIET door status) ───────
  // PostgREST kent geen GROUP BY in select — we halen alleen de status-kolom
  // op en aggregeren in JS. Voor de huidige schaal (kleine N tickets) prima.
  // RLS-filtering blijft van toepassing: gebruiker ziet alleen counts van
  // tickets die hij/zij ook in de lijst kan zien.
  let countsQ = supabase.from('tickets').select('status');
  if (type)          countsQ = countsQ.eq('type', type);
  if (moduleFilter)  countsQ = countsQ.eq('module', moduleFilter);
  const { data: countRows, error: countsErr } = await countsQ;
  if (countsErr) {
    console.error('[tickets-list] counts error:', countsErr.message);
    return res.status(500).json({ error: countsErr.message });
  }
  const counts = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
  for (const r of countRows || []) {
    if (counts[r.status] !== undefined) counts[r.status]++;
  }

  // ── Tickets (volledige rijen, gefilterd door alle 3 query-params) ──────────
  let listQ = supabase
    .from('tickets')
    .select(`
      id, title, description, type, status, priority, module,
      created_by, assigned_to,
      created_at, updated_at, resolved_at
    `)
    .order('created_at', { ascending: false });
  if (status)        listQ = listQ.eq('status', status);
  if (type)          listQ = listQ.eq('type', type);
  if (moduleFilter)  listQ = listQ.eq('module', moduleFilter);

  const { data: tickets, error: listErr } = await listQ;
  if (listErr) {
    console.error('[tickets-list] list error:', listErr.message);
    return res.status(500).json({ error: listErr.message });
  }

  // ── Enrich met namen (batch-lookup via supabaseAdmin) ──────────────────────
  // Profiles RLS-state is project-breed niet uniform, dus we hergebruiken
  // het patroon van andere endpoints: aparte admin-lookup voor namen.
  const ids = new Set();
  for (const t of tickets || []) {
    if (t.created_by)  ids.add(t.created_by);
    if (t.assigned_to) ids.add(t.assigned_to);
  }
  const nameMap = await fetchProfileNames(Array.from(ids));

  const enriched = (tickets || []).map((t) => ({
    ...t,
    created_by_name:  nameMap[t.created_by]  || null,
    assigned_to_name: t.assigned_to ? (nameMap[t.assigned_to] || null) : null,
  }));

  // ── Client-side priority sort (zie comment bij PRIORITY_RANK) ──────────────
  enriched.sort((a, b) => {
    const rank = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
    if (rank !== 0) return rank;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return res.status(200).json({ tickets: enriched, counts });
}

// ── POST — create ────────────────────────────────────────────────────────────

async function handleCreate(req, res, supabase, user) {
  const body = req.body || {};
  const { title, description, type, priority, module: moduleField } = body;

  // Validatie
  if (typeof title !== 'string' || title.trim().length < 3) {
    return res.status(400).json({ error: 'Titel is verplicht (minimaal 3 tekens)' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Ongeldig type. Verwacht: ${VALID_TYPES.join(', ')}` });
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `Ongeldige priority. Verwacht: ${VALID_PRIORITIES.join(', ')}` });
  }

  const row = {
    title:       title.trim(),
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
    type,
    priority:    priority || 'middel',
    module:      typeof moduleField === 'string' && moduleField.trim() ? moduleField.trim() : null,
    created_by:  user.id,
  };

  const { data, error } = await supabase
    .from('tickets')
    .insert(row)
    .select(`
      id, title, description, type, status, priority, module,
      created_by, assigned_to, created_at, updated_at, resolved_at
    `)
    .single();

  if (error) {
    console.error('[tickets-create] insert error:', error.code, error.message);
    // RLS-violation: insufficient_privilege
    if (error.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om een ticket aan te maken' });
    }
    return res.status(500).json({ error: error.message });
  }

  // Enrich met created_by_name voor frontend (zelfde shape als list-response items)
  const nameMap = await fetchProfileNames([data.created_by]);
  const ticket = {
    ...data,
    created_by_name:  nameMap[data.created_by] || null,
    assigned_to_name: null,
  };

  // Fail-soft dual-write: fan-out naar triage-rollen (super_admin + manager).
  // Helper dedupt user_ids; skippen van de maker zelf gebeurt hier optioneel
  // (als 'ie in de rol zit krijgt 'ie anders een melding op eigen ticket).
  createNotification({
    toRole:     ['super_admin', 'manager'],
    type:       'ticket.new',
    title:      'Nieuw ticket' + (data.title ? (' · ' + data.title) : ''),
    body:       data.title,
    linkUrl:    '/modules/tickets-detail.html?id=' + data.id,
    entityType: 'ticket',
    entityId:   data.id,
    createdBy:  user.id,
  }).catch(() => {});

  return res.status(201).json({ ticket });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Batch-lookup van profile-namen via supabaseAdmin (bypass RLS).
 * Retourneert: { [user_id]: 'Full Name' | email-fallback }.
 * Niet-gevonden ids zitten niet in de map.
 */
async function fetchProfileNames(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);
  if (error) {
    console.warn('[tickets] profile-names lookup failed:', error.message);
    return {};
  }
  const map = {};
  for (const p of data || []) {
    map[p.id] = p.full_name || p.email || null;
  }
  return map;
}
