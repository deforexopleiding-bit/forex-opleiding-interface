// api/onboarding-provision-retry.js
//
// ADMIN — retry de Bubble-provisioning voor een onboarding waarvan de eerste
// poging mislukt is (bubble_provisioned=false, bubble_provision_error gevuld).
// Idempotent: als de onboarding inmiddels al provisioned is, returnt het
// {ok:true, skipped:true} zonder nieuwe Bubble-call.
//
// Permission: onboarding.admin (gelijke gate als detail/list/archive).
//
// Body:
//   { onboarding_id (uuid) }
//
// Response 200:
//   { ok, skipped?, bubble_user_id?, partial?, error? }
//
// (De endpoint gooit zelf NIET 500 bij Bubble-fouten — de provisioner is
//  fail-soft. Een 500 hier betekent dat de input-validatie of permission-
//  check zelf onverwacht crashte.)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { provisionOnboardingStudent } from './_lib/onboarding-provision.js';

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
  if (!(await requirePermission(req, 'onboarding.admin'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });
  }

  // Verifieer dat de onboarding überhaupt bestaat — voorkomt dat we een
  // provisioning-call doen voor een verwijderd of niet-bestaand id.
  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return res.status(404).json({ error: 'Onboarding niet gevonden' });
  } catch (e) {
    console.error('[onboarding-provision-retry]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }

  const result = await provisionOnboardingStudent(onboardingId);
  return res.status(200).json(result);
}
