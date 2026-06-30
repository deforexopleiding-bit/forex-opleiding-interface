// api/onboarding-credentials-reset.js
//
// ADMIN — genereer een nieuw temp_password in Bubble voor een reeds-
// geprovisioneerde student en mail die opnieuw via sendCredentialsEmail.
// Mirror van api/onboarding-provision-retry.js qua opzet en resilience:
// Bubble-fouten + e-mail-fouten worden afgevangen en als clean
// { ok:false, error } teruggegeven, niet als 500.
//
// Permission:
//   - onboarding.admin (seesAll) → mag elke onboarding (bestaand gedrag).
//   - onboarding.view_own (mentor, seesOwn) → alleen z'n eigen toegewezen
//     onboarding (extra ownership-check op onboarding.mentor_user_id).
//   - rest → 403.
//
// Body:
//   { onboarding_id (uuid) }
//
// Response 200:
//   { ok:true,  sent:true,  email_sent_at? }
//   { ok:false, error:string }
//
// Pre-conditie: onboarding.bubble_provisioned === true && bubble_user_id
// aanwezig. Anders 400 — voor MISLUKT accounts gebruik je provision-retry.
//
// VEILIGHEID:
// - tempPassword wordt NOOIT gelogd (geen console.log), NOOIT gepersist,
//   en alleen aan sendCredentialsEmail doorgegeven.
// - Bij ontbrekend wachtwoord uit Bubble of mail-fout zetten we
//   credentials_email_sent_at niét.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { bubbleWorkflow } from './_lib/bubble.js';
import { extractTempPasswordFromWf } from './_lib/onboarding-provision.js';
import { sendCredentialsEmail } from './_lib/onboarding-credentials.js';
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

  // Coarse gate: alleen onboarding.admin (seesAll) of onboarding.view_own
  // (mentor, seesOwn) mag deze endpoint überhaupt aanroepen. De fijne
  // ownership-check op mentor_user_id volgt na de onboarding-lookup.
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

  // 1) Onboarding + customer ophalen. Faalt deze stap technisch → 500.
  let onboarding = null;
  let customer = null;
  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, mentor_user_id, bubble_user_id, bubble_provisioned')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)   return res.status(404).json({ error: 'Onboarding niet gevonden' });
    onboarding = ob;

    if (ob.customer_id) {
      const { data: c, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, email, first_name, last_name')
        .eq('id', ob.customer_id)
        .maybeSingle();
      if (cErr) throw new Error('customer lookup: ' + cErr.message);
      customer = c || null;
    }
  } catch (e) {
    console.error('[onboarding-credentials-reset] lookup:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }

  // 1b) Ownership-check (fijn): een mentor zonder seesAll mag uitsluitend
  //     z'n eigen toegewezen onboarding resetten. seesAll (onboarding.admin
  //     / super_admin) → mag elke onboarding (bestaand gedrag).
  if (!scope.seesAll && onboarding.mentor_user_id !== scope.userId) {
    return res.status(403).json({ error: 'Onboarding is niet aan jou toegewezen.' });
  }

  // 2) Pre-conditie: alleen voor reeds-geprovisioneerde accounts.
  if (!onboarding.bubble_provisioned || !onboarding.bubble_user_id) {
    return res.status(400).json({
      ok: false,
      error: 'account nog niet geprovisioned — gebruik provision-retry',
    });
  }

  if (!customer || !customer.email) {
    return res.status(400).json({
      ok: false,
      error: 'klant of e-mailadres ontbreekt — kan geen mail versturen',
    });
  }

  // 3) Bubble-workflow reset_student_password. Gooi GEEN 500 bij Bubble-
  //    fouten — match het fail-soft-gedrag van provision-retry.
  let wfRaw = null;
  try {
    wfRaw = await bubbleWorkflow('reset_student_password', {
      user_id:    onboarding.bubble_user_id,
      email:      customer.email,
      first_name: customer.first_name || '',
      last_name:  customer.last_name  || '',
    });
  } catch (e) {
    console.warn('[onboarding-credentials-reset] Bubble workflow faalde:', e?.message || e);
    return res.status(200).json({
      ok: false,
      error: 'Bubble-workflow faalde: ' + (e?.message || String(e)),
    });
  }

  // 4) Hergebruik dezelfde extractor als provision (geen duplicaat).
  const tempPassword = extractTempPasswordFromWf(wfRaw);
  if (!tempPassword) {
    return res.status(200).json({
      ok: false,
      error: 'geen wachtwoord ontvangen van Bubble',
    });
  }

  // 5) Mail versturen. sendCredentialsEmail is fail-soft (gooit nooit door)
  //    en returnt { sent: bool, reason?, message_id? }.
  let mailRes = null;
  try {
    mailRes = await sendCredentialsEmail({
      onboarding: { id: onboarding.id },
      customer,
      tempPassword,
    });
  } catch (e) {
    console.warn('[onboarding-credentials-reset] mail exception:', e?.message || e);
    return res.status(200).json({
      ok: false,
      error: 'mail-fout: ' + (e?.message || String(e)),
    });
  }

  if (!mailRes || mailRes.sent !== true) {
    return res.status(200).json({
      ok: false,
      error: 'mail niet verstuurd: ' + (mailRes?.reason || 'onbekende reden'),
    });
  }

  // 6) Stempel credentials_email_sent_at (alleen bij succesvol verstuurd).
  //    Fail-soft: een falende update mag de geslaagde mail-response niet
  //    teniet doen.
  const nowIso = new Date().toISOString();
  try {
    const { error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update({ credentials_email_sent_at: nowIso })
      .eq('id', onboarding.id);
    if (updErr) {
      console.warn('[onboarding-credentials-reset] sent-stamp update:', updErr.message);
    }
  } catch (e) {
    console.warn('[onboarding-credentials-reset] sent-stamp exception:', e?.message || e);
  }

  return res.status(200).json({
    ok: true,
    sent: true,
    email_sent_at: nowIso,
  });
}
