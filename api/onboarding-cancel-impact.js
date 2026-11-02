// api/onboarding-cancel-impact.js
//
// GET — Read-only impact-preview voor de onboarding-cancel-cascade.
// Aparte endpoint zodat het OPENEN van de bevestigings-dialoog fysiek
// onmogelijk kan cascaden: geen POST, geen mutatie-pad, geen shared body-
// vlaggen met de destructieve /api/onboarding-cancel.
//
// Query: ?onboarding_id=<uuid>
// Response-shape: annuleringVoorbeeld() uit api/_lib/onboarding-annuleren.js
// (dezelfde als het venster in Hoofdmentor › Onboarding), plus `eerdere` en
// `account` sinds 2 nov 2026. Leest alleen.
//
// Permission: getOnboardingScope.seesAll (zelfde als de execute-endpoint).

import { createUserClient } from './supabase.js';
import { annuleringVoorbeeld } from './_lib/onboarding-annuleren.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

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

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (manager/super_admin/admin vereist).' });
  }

  const onboardingId = typeof req.query?.onboarding_id === 'string'
    ? req.query.onboarding_id.trim()
    : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });
  }

  try {
    // Sinds 2 nov 2026 uit de gedeelde kern (annuleringVoorbeeld, leest
    // alleen): "al geannuleerd" telt ook een annulering van de student op een
    // ander niveau (dossier), en de stand van het LMS-account gaat mee voor
    // "Account ook verwijderen".
    const v = await annuleringVoorbeeld(onboardingId);
    if (!v) return res.status(404).json({ error: 'Onboarding niet gevonden.' });
    return res.status(200).json(v);
  } catch (e) {
    console.error('[onboarding-cancel-impact]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout.' });
  }
}
