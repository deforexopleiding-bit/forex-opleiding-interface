// api/onboarding-handmatig-afronden.js
//
// POST { onboarding_id, reden } — een onboarding met de hand afronden, vanuit
// het CRM-detailscherm (6 oktober 2026). Dezelfde uitvoering als de route van
// het LMS (`lms-onboarding-sessie.js`, actie handmatig_afronden):
// api/_lib/onboarding-handmatig.js.
//
// RECHTEN: getOnboardingScope.seesAll (manager/super_admin/admin), zoals
// annuleren en archiveren. Een mentor sluit zijn eigen onboarding niet zelf af.

import { createUserClient } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { rondOnboardingHandmatigAf } from './_lib/onboarding-handmatig.js';

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
  const scope = await getOnboardingScope(req);
  if (!scope.seesAll) return res.status(403).json({ error: 'Geen rechten (manager/super_admin/admin vereist).' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });

  try {
    const { status, body: uit } = await rondOnboardingHandmatigAf({
      onboardingId,
      reden: typeof body.reden === 'string' ? body.reden : '',
      door: String(user.email || user.id),
      doorUserId: user.id,
    });
    return res.status(status).json(uit);
  } catch (e) {
    console.error('[onboarding-handmatig-afronden]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
