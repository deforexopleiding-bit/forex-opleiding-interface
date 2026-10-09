// api/team-members-lms-status.js
// GET -> lijst mentor team_members met hun koppeling aan het LMS. Vervangt
// team-members-bubble-status (Bubble is dicht sinds okt 2026).
//
// De koppeling is geen veld dat je zet: het CRM vindt het hlms_personeel-id
// via het e-mailadres (precies één actieve match op lower(email); zie
// api/_lib/lms-mentor-brug.js). Dit scherm laat zien bij wie dat lukt en
// waarom niet — dan moet het e-mailadres in het CRM of het LMS recht.
//
// Permission: events.team_member.link (zelfde admin-gevoelige key als vroeger).
//
// Response 200:
//   { mentors: [ { id, name, email, user_id, lms_id, reden }, ... ] }
//   reden: null | 'mentor-zonder-email' | 'mentor-niet-in-lms' |
//          'meerdere-lms-mentors' | 'lms-onbereikbaar'

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { mentorenMetLmsId } from './_lib/lms-mentor-brug.js';

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
    const [lijst, { data: tms, error }] = await Promise.all([
      mentorenMetLmsId(),
      supabaseAdmin.from('team_members').select('id, user_id').eq('type', 'mentor').eq('is_active', true),
    ]);
    if (error) throw new Error('team_members fetch: ' + error.message);
    const tmIdByUser = new Map((tms || []).map((t) => [t.user_id, t.id]));
    const mentors = lijst.map((m) => ({
      id     : tmIdByUser.get(m.user_id) || null,
      name   : m.name,
      email  : m.email,
      user_id: m.user_id,
      lms_id : m.lms_id,
      reden  : m.reden,
    }));
    return res.status(200).json({ mentors });
  } catch (e) {
    console.error('[team-members-lms-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
