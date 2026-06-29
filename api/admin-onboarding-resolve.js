// api/admin-onboarding-resolve.js
//
// POST — Markeer een onboarding als "afgehandeld" (intake-fase) of heropen 'm.
// "Afgehandeld" is NIET permanent: zodra er nieuwe activiteit op de onboarding
// is (mentor-update, no-show of completed-call ná intake_handled_at) telt 'm
// automatisch weer als open — die berekening doen we elders bij list/detail.
//
// Body: { onboarding_id: uuid, handled: boolean }.
//   handled=true  → intake_handled_at=now(), intake_handled_by=user.id.
//   handled=false → beide null (heropenen).
//
// Permission: seesAll (onboarding.admin). Mentor → 403.
//
// Geen mentor_notification — afhandelen is een admin-only houding. De timeline
// krijgt wél een markering zodat mentor + admin het zien.
//
// Response 200: { ok:true, handled, intake_handled_at, intake_handled_by }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

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

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });
  }
  if (typeof body.handled !== 'boolean') {
    return res.status(400).json({ error: 'handled (boolean) is verplicht.' });
  }
  const handled = body.handled;

  try {
    // Lookup voor bestaande-rij check.
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return res.status(404).json({ error: 'Onboarding niet gevonden.' });

    const nowIso = new Date().toISOString();
    const patch = handled
      ? { intake_handled_at: nowIso, intake_handled_by: user.id }
      : { intake_handled_at: null,   intake_handled_by: null    };
    const { data: upd, error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update(patch)
      .eq('id', onboardingId)
      .select('intake_handled_at, intake_handled_by')
      .single();
    if (updErr) throw new Error('onboarding update: ' + updErr.message);

    // Tijdlijn-spoor zodat mentor + andere admin het zien.
    try {
      await supabaseAdmin
        .from('onboarding_mentor_updates')
        .insert({
          onboarding_id: onboardingId,
          kind:          'note',
          status:        null,
          note:          handled ? 'Markeer afgehandeld (intake)' : 'Heropend (intake)',
          created_by:    user.id,
        });
    } catch (e) {
      console.warn('[admin-onboarding-resolve] timeline insert (soft):', e?.message || e);
    }

    return res.status(200).json({
      ok:                true,
      handled,
      intake_handled_at: upd.intake_handled_at,
      intake_handled_by: upd.intake_handled_by,
    });
  } catch (e) {
    console.error('[admin-onboarding-resolve]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
