// api/mentor-my-events.js
// GET -> lijst van events waar de ingelogde mentor aan gekoppeld is.
//
// Permission: mentor.module.access.
// Identiteit: ingelogde user = auth.uid() = profiles.id; we resolven het
// team_member_id via team_members WHERE user_id=auth.uid() en filteren
// event_mentors daarop. Mentor zonder team_members-koppeling krijgt een
// lege array (200) i.p.v. een fout.
//
// Query:
//   ?scope=upcoming|past|all   (default 'all')
//
// Response:
//   {
//     ok: true,
//     scope: 'upcoming'|'past'|'all',
//     team_member_id: <uuid|null>,
//     events: [
//       { event_id, title, starts_at, was_present }, ...
//     ]
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ALLOWED_SCOPES = new Set(['upcoming', 'past', 'all']);

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const scopeRaw = typeof req.query?.scope === 'string' ? req.query.scope.trim().toLowerCase() : 'all';
  const scope = ALLOWED_SCOPES.has(scopeRaw) ? scopeRaw : 'all';

  try {
    // Identiteit: team_members.user_id = auth.uid()
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.id) {
      return res.status(200).json({ ok: true, scope, team_member_id: null, events: [] });
    }

    let q = supabaseAdmin
      .from('event_mentors')
      .select('event_id, was_present, events:event_id ( id, title, starts_at )')
      .eq('team_member_id', tm.id);

    const { data: rows, error: emErr } = await q;
    if (emErr) throw new Error('event_mentors fetch: ' + emErr.message);

    const nowIso = new Date().toISOString();
    let events = (rows || [])
      .map((r) => ({
        event_id:    r.event_id,
        title:       r.events?.title || null,
        starts_at:   r.events?.starts_at || null,
        was_present: !!r.was_present,
      }))
      .filter((e) => e.starts_at != null);

    if (scope === 'upcoming') events = events.filter((e) => e.starts_at >= nowIso);
    else if (scope === 'past') events = events.filter((e) => e.starts_at <  nowIso);

    events.sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || ''));

    return res.status(200).json({ ok: true, scope, team_member_id: tm.id, events });
  } catch (e) {
    console.error('[mentor-my-events]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
