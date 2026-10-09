// api/onboarding-credentials-reset.js
//
// ADMIN/MENTOR — de LMS-uitnodiging OPNIEUW sturen: nieuwe welkomstmail met
// een nieuw wachtwoord, het oude vervalt. Loopt via dezelfde machine-ingang
// van het LMS als de eerste uitnodiging (api/_lib/dfo-lms-uitnodiging.js,
// x-dfo-secret), met `opnieuw: true` zodat de grendel niet aanslaat.
//
// GESCHIEDENIS (9 okt 2026, Maxim): hier stond de Bubble-wachtwoordreset
// (workflow reset_student_password + credentials-mail). Bubble gaat dicht;
// de klant logt in het LMS in, dus de reset hoort daar.
//
// Permission:
//   - onboarding.admin (seesAll) → mag elke onboarding.
//   - onboarding.view_own (mentor, seesOwn) → alleen z'n eigen toegewezen
//     onboarding (extra ownership-check op onboarding.mentor_user_id).
//   - rest → 403.
//
// Body:   { onboarding_id (uuid) }
// Response 200:
//   { ok:true,  sent:true, verstuurd_naar? }
//   { ok:false, error:string, actie_vereist?, herstelbaar? }
//
// Pre-conditie: de onboarding heeft een LMS-student (dfo_lms_student_id) en
// de klant een e-mailadres. Anders 400 — eerst "Student aanmaken in LMS".

import { createUserClient, supabaseAdmin } from './supabase.js';
import { stuurLmsUitnodiging } from './_lib/dfo-lms-uitnodiging.js';
import { noteerUitnodiging } from './_lib/dfo-lms-student.js';
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

  const scope = await getOnboardingScope(req);
  if (!scope.seesAll && !scope.seesOwn) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin of onboarding.view_own)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });
  }

  let onboarding = null;
  let customer = null;
  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, mentor_user_id, dfo_lms_student_id')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)   return res.status(404).json({ error: 'Onboarding niet gevonden' });
    onboarding = ob;
    if (ob.customer_id) {
      const { data: c, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, email')
        .eq('id', ob.customer_id)
        .maybeSingle();
      if (cErr) throw new Error('customer lookup: ' + cErr.message);
      customer = c || null;
    }
  } catch (e) {
    console.error('[onboarding-credentials-reset] lookup:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }

  if (!scope.seesAll && onboarding.mentor_user_id !== scope.userId) {
    return res.status(403).json({ error: 'Onboarding is niet aan jou toegewezen.' });
  }
  if (!onboarding.dfo_lms_student_id) {
    return res.status(400).json({
      ok: false,
      error: 'Deze klant staat nog niet in het LMS — maak eerst de student aan in het LMS.',
    });
  }
  if (!customer || !customer.email) {
    return res.status(400).json({ ok: false, error: 'klant of e-mailadres ontbreekt — kan geen mail versturen' });
  }

  let r;
  try {
    r = await stuurLmsUitnodiging({ email: customer.email, opnieuw: true });
  } catch (e) {
    // De helper gooit nooit; dit is een vangnet.
    r = { ok: false, fout: e?.message || String(e) };
  }
  await noteerUitnodiging(onboarding.id, r);

  if (r && r.ok === true && r.verstuurd === true) {
    return res.status(200).json({ ok: true, sent: true, verstuurd_naar: r.verstuurd_naar || null });
  }
  return res.status(200).json({
    ok: false,
    error: (r && r.fout) || 'LMS-uitnodiging niet verstuurd',
    actie_vereist: !!(r && r.actie_vereist),
    herstelbaar: !!(r && r.herstelbaar),
  });
}
