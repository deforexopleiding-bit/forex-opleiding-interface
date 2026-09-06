// api/onboarding-dfo-lms-provision.js
//
// ADMIN — maak (of hergebruik) de studentrij in het NIEUWE LMS (dfo-lms,
// hlms_student) voor ÉÉN onboarding. Uitsluitend handmatig: dit is de knop
// per klant in het onboarding-detailscherm.
//
// BEWUST GEEN INHAALSLAG. Er is geen batch-, cron- of "doe alles"-variant
// van dit endpoint, en die hoort er ook niet te komen zonder expliciete
// opdracht. Bestaande onboardings gaan één voor één, met een mens die kijkt.
// Nieuwe onboardings lopen automatisch mee via api/onboarding-create.js.
//
// Permission: onboarding.admin (zelfde poort als detail / list / archive /
// provision-retry).
//
// Body:
//   { onboarding_id (uuid), send_invite?: boolean }
//
// send_invite is STANDAARD FALSE en dat is met opzet. Deze knop wordt op
// BESTAANDE klanten gebruikt, en die horen niet onverwacht een mail te
// krijgen omdat iemand de studentrij wilde aanmaken. Alleen wanneer de
// operator er uitdrukkelijk om vraagt gaat de uitnodiging eruit. De grendel
// op uitnodiging_verstuurd_op beschermt daarnaast tegen een tweede mail.
//
// Response 200 (de provisioner is fail-soft en geeft zijn eigen vorm terug):
//   { ok, created?, adopted?, skipped?, student_id?, mentor_id?,
//     mentor_warning?, reason?, error? }
//
// Een 500 hier betekent dat de invoercontrole of de permission-check zelf
// onverwacht crashte — niet dat de LMS-koppeling mislukte. Die laatste komt
// als { ok:false, error } met status 200 terug, en staat dan óók in
// onboardings.dfo_lms_provision_error.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { provisionDfoLmsStudent, noteerUitnodiging } from './_lib/dfo-lms-student.js';
import { stuurLmsUitnodiging } from './_lib/dfo-lms-uitnodiging.js';

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

  // Bestaanscontrole vóór we een externe databank aanspreken.
  try {
    const { data: ob, error } = await supabaseAdmin
      .from('onboardings')
      .select('id, status')
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) throw new Error('onboarding lookup: ' + error.message);
    if (!ob) return res.status(404).json({ error: 'Onboarding niet gevonden' });
    if (ob.status === 'gearchiveerd') {
      return res.status(409).json({ error: 'Onboarding is gearchiveerd — eerst herstellen' });
    }
  } catch (e) {
    console.error('[onboarding-dfo-lms-provision]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }

  const result = await provisionDfoLmsStudent(onboardingId);

  // Uitnodiging alleen op uitdrukkelijk verzoek, en alleen als de studentrij
  // er staat. Faalzacht: een mislukte mail maakt de koppeling niet ongedaan.
  const wilUitnodigen = body.send_invite === true;
  if (wilUitnodigen && result && result.ok === true && result.email) {
    let uitnodiging;
    try {
      uitnodiging = await stuurLmsUitnodiging({ email: result.email });
    } catch (e) {
      console.error('[onboarding-dfo-lms-provision] uitnodiging threw:', e?.message || e);
      uitnodiging = { ok: false, fout: e?.message || 'uitnodiging-threw' };
    }
    await noteerUitnodiging(onboardingId, uitnodiging);
    result.uitnodiging = uitnodiging;
  } else if (wilUitnodigen) {
    result.uitnodiging = { ok: false, overgeslagen: true,
      fout: 'geen studentrij — uitnodiging niet geprobeerd' };
  }

  return res.status(200).json(result);
}
