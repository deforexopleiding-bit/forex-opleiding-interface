// api/events-mentors-list.js
// GET -> lijst van mentoren gekoppeld aan een event.
//
// Permission: events.event.view.
//
// Query: ?event_id=<uuid>  (verplicht)
//
// Response:
//   {
//     mentors: [
//       {
//         team_member_id, name, role, type, email,
//         avatar_emoji, avatar_color, is_active,
//         added_at, added_by_user_id
//       }, ...
//     ]
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  const eventId = req.query?.event_id ? String(req.query.event_id) : null;
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('event_mentors')
      .select(`
        team_member_id, added_at, added_by_user_id, was_present,
        team_members:team_member_id ( id, name, role, type, email, avatar_emoji, avatar_color, is_active, user_id )
      `)
      .eq('event_id', eventId)
      .order('added_at', { ascending: true });
    if (error) throw new Error('mentors-list: ' + error.message);

    const mentors = (data || []).map((row) => {
      const tm = row.team_members || {};
      return {
        team_member_id:   row.team_member_id,
        name:             tm.name || null,
        role:             tm.role || null,
        type:             tm.type || null,
        email:            tm.email || null,
        avatar_emoji:     tm.avatar_emoji || null,
        avatar_color:     tm.avatar_color || null,
        is_active:        tm.is_active !== false,
        user_id:          tm.user_id || null,
        user_linked:      !!tm.user_id,
        was_present:      !!row.was_present,
        added_at:         row.added_at,
        added_by_user_id: row.added_by_user_id,
      };
    });

    return res.status(200).json({ mentors });
  } catch (e) {
    console.error('[events-mentors-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
