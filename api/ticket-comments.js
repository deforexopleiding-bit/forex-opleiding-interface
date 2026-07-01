// api/ticket-comments.js
//
// POST   { ticket_id, body }   → 201 { comment: {...} }
// DELETE ?id=<uuid>             → 204 (RLS dekt eigen-of-admin)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { createNotification } from './_lib/notify.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (req.method === 'POST')   return handleCreate(req, res, supabase, user);
  if (req.method === 'DELETE') return handleDelete(req, res, supabase);
}

async function handleCreate(req, res, supabase, user) {
  const body = req.body || {};
  const { ticket_id, body: text } = body;

  if (!ticket_id || typeof ticket_id !== 'string') {
    return res.status(400).json({ error: 'ticket_id (uuid) vereist' });
  }
  if (typeof text !== 'string' || text.trim().length < 1) {
    return res.status(400).json({ error: 'Comment-tekst is verplicht' });
  }

  const row = {
    ticket_id,
    author_id: user.id,
    body: text.trim(),
  };

  const { data, error } = await supabase
    .from('ticket_comments')
    .insert(row)
    .select('id, ticket_id, author_id, body, created_at')
    .single();

  if (error) {
    console.error('[ticket-comments] insert error:', error.code, error.message);
    if (error.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om te reageren op dit ticket' });
    }
    return res.status(500).json({ error: error.message });
  }

  const nameMap = await fetchProfileNames([data.author_id]);

  // Fail-soft dual-write: notify ticket-eigenaar + assignee (skip zelf, dedup).
  try {
    const { data: ticket } = await supabaseAdmin
      .from('tickets')
      .select('id, title, created_by, assigned_to')
      .eq('id', ticket_id)
      .maybeSingle();
    if (ticket) {
      const recipients = new Set();
      if (ticket.created_by)  recipients.add(ticket.created_by);
      if (ticket.assigned_to) recipients.add(ticket.assigned_to);
      recipients.delete(user.id);
      for (const uid of recipients) {
        createNotification({
          toUserId:   uid,
          type:       'ticket.replied',
          title:      'Nieuwe reactie' + (ticket.title ? (' · ' + ticket.title) : ''),
          body:       ticket.title,
          linkUrl:    '/modules/tickets-detail.html?id=' + ticket_id,
          entityType: 'ticket',
          entityId:   ticket_id,
          createdBy:  user.id,
        }).catch(() => {});
      }
    }
  } catch (_) { /* fail-soft */ }

  return res.status(201).json({
    comment: { ...data, author_name: nameMap[data.author_id] || null },
  });
}

async function handleDelete(req, res, supabase) {
  const id = req.query?.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query-param id (uuid) vereist' });
  }

  const { error, count } = await supabase
    .from('ticket_comments')
    .delete({ count: 'exact' })
    .eq('id', id);

  if (error) {
    console.error('[ticket-comments] delete error:', error.code, error.message);
    if (error.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om deze comment te verwijderen' });
    }
    return res.status(500).json({ error: error.message });
  }
  if (count === 0) {
    return res.status(404).json({ error: 'Comment niet gevonden of geen toegang' });
  }

  return res.status(204).end();
}

async function fetchProfileNames(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);
  if (error) return {};
  const map = {};
  for (const p of data || []) map[p.id] = p.full_name || p.email || null;
  return map;
}
