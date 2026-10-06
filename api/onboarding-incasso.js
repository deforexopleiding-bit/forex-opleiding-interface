// api/onboarding-incasso.js
//
// POST { onboarding_id, actie: 'naar', reden }        — naar incasso-opvolging
// POST { onboarding_id, actie: 'terug', start_datum } — terug actief
//
// Vanuit het CRM-detailscherm (6 oktober 2026). Dezelfde uitvoering als de
// route van het LMS: api/_lib/onboarding-incasso.js. NIET annuleren: status,
// facturen, toegang en aanmaningen blijven zoals ze zijn.
//
// RECHTEN: getOnboardingScope.seesAll (manager/super_admin/admin).

import { createUserClient } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { zetNaarIncasso, activeerUitIncasso } from './_lib/onboarding-incasso.js';

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
  const door = String(user.email || user.id);

  try {
    let uit;
    if (body.actie === 'naar') {
      uit = await zetNaarIncasso({ onboardingId, reden: typeof body.reden === 'string' ? body.reden : '', door, doorUserId: user.id });
    } else if (body.actie === 'terug') {
      uit = await activeerUitIncasso({
        onboardingId, startDatum: String(body.start_datum || '').trim().slice(0, 10), door, doorUserId: user.id,
      });
    } else {
      return res.status(400).json({ error: "actie moet 'naar' of 'terug' zijn." });
    }
    return res.status(uit.status).json(uit.body);
  } catch (e) {
    console.error('[onboarding-incasso]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
