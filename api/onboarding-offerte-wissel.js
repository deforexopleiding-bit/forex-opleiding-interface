// api/onboarding-offerte-wissel.js
//
// POST { onboarding_id, deal_id, traject_id, start_date }
//
// "Deze offerte vervangt de lopende onboarding" (Maxim, 10 nov 2026): een
// getekende offerte werkt de BESTAANDE, nog lopende onboarding van dezelfde
// klant bij — traject en startdatum — in plaats van een tweede onboarding of
// een verwijderde student. Token, startcode, antwoorden, mentor en uitnodiging
// blijven; er wordt NIETS naar de klant verstuurd. Zie
// api/_lib/onboarding-offerte-wissel.js voor de regels en de volgorde.
//
// Recht: onboarding.create (wie mag aanmelden, mag ook vervangen).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { vervangOnboardingDoorOfferte } from './_lib/onboarding-offerte-wissel.js';

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
  if (!(await requirePermission(req, 'onboarding.create'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.create)' });
  }
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const { status, body } = await vervangOnboardingDoorOfferte({
    onboardingId: s(b.onboarding_id),
    dealId: s(b.deal_id),
    trajectId: s(b.traject_id),
    startDate: s(b.start_date).slice(0, 10),
    doorUserId: user.id,
    door: user.email || user.id,
  });
  return res.status(status).json(body);
}
