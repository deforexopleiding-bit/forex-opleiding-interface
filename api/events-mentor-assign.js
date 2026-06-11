// api/events-mentor-assign.js
// POST -> koppel een mentor (team_member) aan een event.
//
// Permission: events.mentor.assign.
//
// Body (JSON): { event_id: uuid, team_member_id: uuid }
//
// Validatie:
//   - event bestaat + niet archived
//   - team_member bestaat
//   - team_member.type = 'mentor'
//   - team_member.is_active = true
//
// Idempotent: bij duplicate (PK violation 23505) -> 200 met already=true.
//
// Response 201: { mentor: { event_id, team_member_id, added_at, added_by_user_id, already? } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.mentor.assign'))) {
    return res.status(403).json({ error: 'Geen rechten (events.mentor.assign)' });
  }

  const body = req.body || {};
  const eventId      = body.event_id ? String(body.event_id) : null;
  const teamMemberId = body.team_member_id ? String(body.team_member_id) : null;

  if (!eventId || !UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id (uuid) vereist' });
  if (!teamMemberId || !UUID_RE.test(teamMemberId)) {
    return res.status(400).json({ error: 'team_member_id (uuid) vereist' });
  }

  try {
    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, status')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event-lookup: ' + evErr.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });
    if (ev.status === 'archived') {
      return res.status(409).json({ error: 'Event is gearchiveerd' });
    }

    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('id, type, is_active, name')
      .eq('id', teamMemberId)
      .maybeSingle();
    if (tmErr) throw new Error('team_member-lookup: ' + tmErr.message);
    if (!tm)   return res.status(404).json({ error: 'Team member niet gevonden' });
    if (tm.type !== 'mentor') {
      return res.status(400).json({ error: `team_member ${tm.name || teamMemberId} heeft type='${tm.type}', niet 'mentor'` });
    }
    if (!tm.is_active) {
      return res.status(400).json({ error: `team_member ${tm.name || teamMemberId} is inactief` });
    }

    const { data: row, error } = await supabaseAdmin
      .from('event_mentors')
      .insert({
        event_id:         eventId,
        team_member_id:   teamMemberId,
        added_by_user_id: user?.id || null,
      })
      .select('event_id, team_member_id, added_at, added_by_user_id')
      .single();

    if (error) {
      if (error.code === '23505') {
        // PK-conflict — al gekoppeld. Geef bestaande row terug.
        const { data: existing } = await supabaseAdmin
          .from('event_mentors')
          .select('event_id, team_member_id, added_at, added_by_user_id')
          .eq('event_id', eventId)
          .eq('team_member_id', teamMemberId)
          .maybeSingle();
        return res.status(200).json({ mentor: { ...(existing || {}), already: true } });
      }
      throw new Error('mentor-insert: ' + error.message);
    }

    return res.status(201).json({ mentor: row });
  } catch (e) {
    console.error('[events-mentor-assign]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
