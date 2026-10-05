// api/onboarding-assign-mentor.js
//
// ADMIN — wijs een mentor toe aan een onboarding, of ontkoppel (null).
//
// Permission: onboarding.assign_mentor.
//
// Body:
//   { onboarding_id (uuid), mentor_user_id (uuid|null) }
//
// Validaties:
//   - Onboarding moet bestaan; status != 'gearchiveerd' (anders 409).
//   - mentor_user_id === null → ontkoppelen (mentor_user_id=null, assigned_at=null).
//   - Anders moet het een actieve mentor zijn:
//     team_members.type='mentor' AND is_active=true op user_id (anders 400).
//
// Response 200: { ok:true, mentor_user_id, assigned_at }.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { wijsMentorToe } from './_lib/onboarding-acties.js';

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
  if (!(await requirePermission(req, 'onboarding.assign_mentor'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.assign_mentor)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });
  }

  // mentor_user_id mag expliciet null zijn (ontkoppelen) of een uuid.
  const rawMid = body.mentor_user_id;
  let mentorUserId = null;
  if (rawMid === null || rawMid === undefined || rawMid === '') {
    mentorUserId = null;
  } else if (typeof rawMid === 'string' && UUID_RE.test(rawMid.trim())) {
    mentorUserId = rawMid.trim();
  } else {
    return res.status(400).json({ error: 'mentor_user_id moet uuid of null zijn' });
  }

  try {
    const uitkomst = await wijsMentorToe({ onboardingId, mentorUserId, doorUserId: user.id });
    return res.status(uitkomst.status).json(uitkomst.body);
  } catch (e) {
    console.error('[onboarding-assign-mentor]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
