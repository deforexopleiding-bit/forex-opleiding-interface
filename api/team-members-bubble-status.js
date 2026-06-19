// api/team-members-bubble-status.js
// GET -> lijst mentor team_members met huidige bubble-koppeling. Dient als
// data-source voor de admin Bubble-koppelingsectie.
//
// Permission: events.team_member.link (zelfde admin-gevoelige key).
//
// Response 200:
//   { mentors: [
//       { id, name, email, user_id, user_linked, bubble_user_id, is_active }, ...
//   ] }
//
// Sortering: name ASC.
// Definitie 'mentor': zelfde rol-gate als events-mentors-available
// (user_roles.role='mentor' + team_members.user_id matching + is_active=true).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  if (!(await requirePermission(req, 'events.team_member.link'))) {
    return res.status(403).json({ error: 'Geen rechten (events.team_member.link)' });
  }

  try {
    const { data: roleRows, error: rolesErr } = await supabaseAdmin
      .from('user_roles')
      .select('user_id')
      .eq('role', 'mentor');
    if (rolesErr) throw new Error('mentor-roles fetch: ' + rolesErr.message);
    const mentorUserIds = [...new Set((roleRows || []).map((r) => r.user_id).filter(Boolean))];
    if (mentorUserIds.length === 0) return res.status(200).json({ mentors: [] });

    const { data, error } = await supabaseAdmin
      .from('team_members')
      .select('id, name, email, user_id, is_active, bubble_user_id')
      .in('user_id', mentorUserIds)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw new Error('team_members fetch: ' + error.message);

    const mentors = (data || []).map((m) => ({
      id            : m.id,
      name          : m.name,
      email         : m.email,
      user_id       : m.user_id,
      user_linked   : !!m.user_id,
      bubble_user_id: m.bubble_user_id || null,
      is_active     : m.is_active !== false,
    }));

    return res.status(200).json({ mentors });
  } catch (e) {
    console.error('[team-members-bubble-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
