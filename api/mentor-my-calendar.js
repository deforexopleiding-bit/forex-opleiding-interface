// api/mentor-my-calendar.js
// GET -> komende events waar de ingelogde mentor aan gekoppeld is.
//
// Permission: mentor.module.access.
// Identiteit: ingelogde user = auth.uid() = profiles.id; team_member_id
// resolved via team_members WHERE user_id=auth.uid().
//
// Verschil met mentor-my-events: alleen toekomstige events (starts_at >= now()),
// oplopend gesorteerd (eerstvolgende bovenaan).
//
// Response:
//   {
//     ok: true,
//     team_member_id: <uuid|null>,
//     events: [{ event_id, title, starts_at, was_present }, ...]
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

  // Dual-gate: ?mentor_user_id=… → admin-pad (mentor.admin.view);
  // afwezig → self-pad (mentor.module.access, auth.uid()).
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
  }

  try {
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('id')
      .eq('user_id', effectiveUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.id) {
      return res.status(200).json({ ok: true, team_member_id: null, events: [] });
    }

    const nowIso = new Date().toISOString();
    const { data: rows, error: emErr } = await supabaseAdmin
      .from('event_mentors')
      .select('event_id, was_present, events:event_id ( id, title, starts_at )')
      .eq('team_member_id', tm.id);
    if (emErr) throw new Error('event_mentors fetch: ' + emErr.message);

    const events = (rows || [])
      .map((r) => ({
        event_id:    r.event_id,
        title:       r.events?.title || null,
        starts_at:   r.events?.starts_at || null,
        was_present: !!r.was_present,
      }))
      .filter((e) => e.starts_at && e.starts_at >= nowIso)
      .sort((a, b) => (a.starts_at || '').localeCompare(b.starts_at || ''));

    return res.status(200).json({ ok: true, team_member_id: tm.id, events });
  } catch (e) {
    console.error('[mentor-my-calendar]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
