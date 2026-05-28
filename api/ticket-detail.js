// api/ticket-detail.js
//
// GET   ?id=<uuid> → { ticket, comments, attachments, assignees }
// PATCH ?id=<uuid> → wijzig status/assigned_to/title/description
//
// Auth: createUserClient(req) — RLS dekt zichtbaarheid + edit-rechten.
// Assignee-change: extra check via requirePermission('tickets.ticket.assign').

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const id = req.query?.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query-param id (uuid) vereist' });
  }

  if (req.method === 'GET')   return handleGet(res, supabase, id);
  if (req.method === 'PATCH') return handlePatch(req, res, supabase, id);
}

// ── GET ──────────────────────────────────────────────────────────────────────

async function handleGet(res, supabase, id) {
  const [ticketRes, commentsRes, attachmentsRes, assigneesRes] = await Promise.all([
    supabase.from('tickets').select(`
      id, title, description, type, status, priority, module,
      created_by, assigned_to, created_at, updated_at, resolved_at
    `).eq('id', id).maybeSingle(),

    supabase.from('ticket_comments').select(`
      id, ticket_id, author_id, body, created_at
    `).eq('ticket_id', id).order('created_at', { ascending: true }),

    supabase.from('ticket_attachments').select(`
      id, ticket_id, comment_id, storage_path, external_url, filename, mime_type,
      created_by, created_at
    `).eq('ticket_id', id),

    // Assignees: alle actieve profiles. Via supabaseAdmin omdat profiles-RLS state
    // niet uniform is (zelfde pattern als name-enrichment in api/tickets.js).
    supabaseAdmin.from('profiles')
      .select('id, full_name, email, role')
      .eq('is_active', true)
      .order('full_name', { ascending: true, nullsFirst: false }),
  ]);

  if (ticketRes.error) {
    // Invalid uuid format → 404 ipv 500 met raw Postgres-error
    if (ticketRes.error.code === '22P02' ||
        (ticketRes.error.message || '').includes('invalid input syntax for type uuid')) {
      return res.status(404).json({ error: 'Ticket niet gevonden of geen toegang' });
    }
    console.error('[ticket-detail] ticket error:', ticketRes.error.message);
    return res.status(500).json({ error: ticketRes.error.message });
  }
  if (!ticketRes.data) {
    return res.status(404).json({ error: 'Ticket niet gevonden of geen toegang' });
  }

  const ticket = ticketRes.data;
  const comments = commentsRes.data || [];
  const attachments = attachmentsRes.data || [];
  const assignees = (assigneesRes.data || []).map((p) => ({
    id: p.id,
    name: p.full_name || p.email || '(naamloos)',
    role: p.role,
  }));

  // Name-enrich (ticket + comments + attachments)
  const ids = new Set();
  if (ticket.created_by)  ids.add(ticket.created_by);
  if (ticket.assigned_to) ids.add(ticket.assigned_to);
  for (const c of comments)    if (c.author_id)  ids.add(c.author_id);
  for (const a of attachments) if (a.created_by) ids.add(a.created_by);
  const nameMap = await fetchProfileNames(Array.from(ids));

  return res.status(200).json({
    ticket: {
      ...ticket,
      created_by_name:  nameMap[ticket.created_by]  || null,
      assigned_to_name: ticket.assigned_to ? (nameMap[ticket.assigned_to] || null) : null,
    },
    comments: comments.map((c) => ({
      ...c, author_name: nameMap[c.author_id] || null,
    })),
    attachments: attachments.map((a) => ({
      ...a, created_by_name: nameMap[a.created_by] || null,
    })),
    assignees,
  });
}

// ── PATCH ────────────────────────────────────────────────────────────────────

async function handlePatch(req, res, supabase, id) {
  const body = req.body || {};
  const { status, assigned_to, title, description } = body;

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Ongeldige status. Verwacht: ${VALID_STATUSES.join(', ')}` });
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim().length < 3)) {
    return res.status(400).json({ error: 'Titel moet minimaal 3 tekens zijn' });
  }
  if (assigned_to !== undefined && assigned_to !== null && typeof assigned_to !== 'string') {
    return res.status(400).json({ error: 'assigned_to moet uuid of null zijn' });
  }

  // Assignee-change vereist expliciete permissie (admin-actie).
  if (assigned_to !== undefined) {
    const allowed = await requirePermission(req, 'tickets.ticket.assign');
    if (!allowed) {
      return res.status(403).json({ error: 'Geen rechten om assignee te wijzigen' });
    }
  }

  const updates = {};
  if (status !== undefined)       updates.status       = status;
  if (assigned_to !== undefined)  updates.assigned_to  = assigned_to;
  if (title !== undefined)        updates.title        = title.trim();
  if (description !== undefined)  updates.description  =
    description === null || description.trim() === '' ? null : description.trim();

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te wijzigen' });
  }

  const { data, error } = await supabase
    .from('tickets')
    .update(updates)
    .eq('id', id)
    .select(`
      id, title, description, type, status, priority, module,
      created_by, assigned_to, created_at, updated_at, resolved_at
    `)
    .maybeSingle();

  if (error) {
    console.error('[ticket-detail] update error:', error.code, error.message);
    if (error.code === '22P02' ||
        (error.message || '').includes('invalid input syntax for type uuid')) {
      return res.status(404).json({ error: 'Ticket niet gevonden of geen toegang' });
    }
    if (error.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om dit ticket te wijzigen' });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data) {
    return res.status(404).json({ error: 'Ticket niet gevonden of geen toegang' });
  }

  const ids = new Set();
  if (data.created_by)  ids.add(data.created_by);
  if (data.assigned_to) ids.add(data.assigned_to);
  const nameMap = await fetchProfileNames(Array.from(ids));

  return res.status(200).json({
    ticket: {
      ...data,
      created_by_name:  nameMap[data.created_by]  || null,
      assigned_to_name: data.assigned_to ? (nameMap[data.assigned_to] || null) : null,
    },
  });
}

// ── Helpers (TODO: DRY naar api/_lib zodra meer ticket-endpoints landen) ────

async function fetchProfileNames(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);
  if (error) {
    console.warn('[ticket-detail] profile-names lookup failed:', error.message);
    return {};
  }
  const map = {};
  for (const p of data || []) map[p.id] = p.full_name || p.email || null;
  return map;
}
