// api/events-mentors-available.js
// GET -> lijst van actieve mentoren (team_members WHERE type='mentor' AND is_active=true).
// Voor mentor-select dropdown in event-detail UI.
//
// Permission: events.mentor.assign.
//
// Query: ?event_id=<uuid>  (optioneel — als opgegeven worden al-gekoppelde mentoren
//                            uitgesloten zodat de select alleen "kies nieuwe mentor" toont)
//
// Response: { mentors: [ { id, name, role, email, avatar_emoji, avatar_color, user_linked } ] }
// Sortering: name ASC.
// user_linked = team_members.user_id IS NOT NULL (F5.0). Mentor zonder user_id kan
// nog wel als mentor gekoppeld worden aan een event, maar krijgt geen ledger-entries
// totdat een super_admin de koppeling aan auth.users maakt via team-member-link-user.

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
  if (!(await requirePermission(req, 'events.mentor.assign'))) {
    return res.status(403).json({ error: 'Geen rechten (events.mentor.assign)' });
  }

  const eventId = req.query?.event_id ? String(req.query.event_id) : null;
  if (eventId && !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id moet uuid zijn' });
  }

  try {
    const { data: all, error } = await supabaseAdmin
      .from('team_members')
      .select('id, name, role, type, email, avatar_emoji, avatar_color, is_active, user_id')
      .eq('type', 'mentor')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw new Error('mentors-available: ' + error.message);

    let mentors = all || [];

    if (eventId) {
      const { data: linked, error: linkedErr } = await supabaseAdmin
        .from('event_mentors')
        .select('team_member_id')
        .eq('event_id', eventId);
      if (linkedErr) {
        console.error('[events-mentors-available linked]', linkedErr.message);
      } else {
        const linkedSet = new Set((linked || []).map((r) => r.team_member_id));
        mentors = mentors.filter((m) => !linkedSet.has(m.id));
      }
    }

    const out = mentors.map((m) => ({
      id           : m.id,
      name         : m.name,
      role         : m.role,
      email        : m.email,
      avatar_emoji : m.avatar_emoji,
      avatar_color : m.avatar_color,
      user_linked  : !!m.user_id,
    }));
    return res.status(200).json({ mentors: out });
  } catch (e) {
    console.error('[events-mentors-available]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
