// api/notifications-list.js
//
// GET — eigen meldingen-lijst voor de ingelogde user. Hard self-scoped op
// .eq('user_id', user.id) — niemand ziet andermans meldingen, ongeacht rol.
//
// Auth: createUserClient + getUser → 401 als geen user.
// GEEN requirePermission-gate: meldingen zijn er voor iedereen die ingelogd is.
//
// Querystring:
//   ?filter=unread   → alleen rijen waar read_at IS NULL.
//   ?filter=all      → default (alle eigen meldingen).
//
// Sortering: ongelezen eerst (read_at IS NULL), dan created_at desc.
// Cap: 50.
//
// Response 200: {
//   notifications: [{
//     id, type, title, body, link_url, entity_type, entity_id,
//     priority, created_at, read_at
//   }],
//   unread_count
// }

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const q = (req.query && typeof req.query === 'object') ? req.query : {};
  const filter = (typeof q.filter === 'string' && q.filter.trim()) ? q.filter.trim().toLowerCase() : 'all';

  try {
    // SELF-only — supabaseAdmin maar met expliciete eq('user_id', user.id).
    // Een user mag NOOIT andermans rij zien; server-side gefilterd.
    let listQuery = supabaseAdmin
      .from('notifications')
      .select('id, type, title, body, link_url, entity_type, entity_id, priority, created_at, read_at')
      .eq('user_id', user.id)
      // Ongelezen eerst (NULLS FIRST), daarbinnen newest-first op created_at.
      .order('read_at',    { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(50);
    if (filter === 'unread') {
      listQuery = listQuery.is('read_at', null);
    }
    const { data: rows, error: listErr } = await listQuery;
    if (listErr) throw new Error('notifications fetch: ' + listErr.message);

    // Aparte head-count voor ongelezen-teller — onafhankelijk van filter.
    const { count, error: cntErr } = await supabaseAdmin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null);
    if (cntErr) throw new Error('unread count: ' + cntErr.message);

    return res.status(200).json({
      notifications: rows || [],
      unread_count:  count || 0,
    });
  } catch (e) {
    console.error('[notifications-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
