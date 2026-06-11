// api/events-mentor-remove.js
// POST -> ontkoppel een mentor van een event.
//
// Permission: events.mentor.assign (zelfde key — assign omvat ook unassign).
//
// Body (JSON): { event_id: uuid, team_member_id: uuid }
//
// Response 200: { removed: true } of 404 als niet gekoppeld.

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
    // Bestaat de koppeling?
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('event_mentors')
      .select('event_id, team_member_id')
      .eq('event_id', eventId)
      .eq('team_member_id', teamMemberId)
      .maybeSingle();
    if (exErr) throw new Error('mentor-lookup: ' + exErr.message);
    if (!existing) return res.status(404).json({ error: 'Mentor is niet gekoppeld aan dit event' });

    const { error: delErr } = await supabaseAdmin
      .from('event_mentors')
      .delete()
      .eq('event_id', eventId)
      .eq('team_member_id', teamMemberId);
    if (delErr) throw new Error('mentor-delete: ' + delErr.message);

    return res.status(200).json({ removed: true });
  } catch (e) {
    console.error('[events-mentor-remove]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
