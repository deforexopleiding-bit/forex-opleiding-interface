// api/mentor-my-students.js
//
// GET → studenten van een mentor, uit het LMS (hlms_student). Sinds 9 okt
// 2026 niet meer uit Bubble — zie api/_lib/mentorStudents.js.
// Dual-gate:
//   - ?mentor_user_id afwezig → self (mentor.module.access, auth.uid()).
//   - aanwezig → admin (mentor.admin.view, die id).
//
// Gearchiveerd = LMS-toegang verlopen (eind_datum vóór vandaag); die vallen
// uit de lijst, net als vroeger de gearchiveerde Bubble-studenten.
//
// Response 200: { ok, scope:'self'|'admin', linked: bool, reden?, students: [...] }
//   student: { student_id, lms_student_id, name, email, program, membership,
//              onboarding_status, calls_1on1_done, calls_1on1_total, no_shows, ... }
// 503 als het LMS niet bereikbaar is (nooit stil een lege lijst).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getMentorStudents, httpStatusVoor } from './_lib/mentorStudents.js';

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

  // Dual-gate.
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  let scope;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
    scope = 'admin';
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
    scope = 'self';
  }

  try {
    const { linked, reden, students } = await getMentorStudents(effectiveUserId);
    if (!linked) {
      return res.status(200).json({ ok: true, scope, linked: false, reden, students: [] });
    }
    const actief = students.filter((s) => !s.archived);
    actief.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
    return res.status(200).json({ ok: true, scope, linked: true, students: actief });
  } catch (e) {
    console.error('[mentor-my-students]', e?.message || e);
    return res.status(httpStatusVoor(e)).json({ error: e?.message || 'Interne fout' });
  }
}
