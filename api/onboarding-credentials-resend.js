// api/onboarding-credentials-resend.js
//
// POST → resend de Bubble-inloggegevens via WhatsApp (handmatige fallback
// voor het geval de welkomstmail niet werkte/niet aankwam).
//
// Flow:
//   1. Auth: X-Internal-Token (system) OF Bearer + onboarding.inbox.send.
//   2. Onboarding-row laden + bubble_provisioned-gate (er moet een account
//      bestaan om de credentials voor te resenden).
//   3. Customer laden (e-mail + naam) — vereist om create_student_basic
//      opnieuw te kunnen aanroepen.
//   4. bubbleWorkflow('create_student_basic', { email, first_name, last_name })
//      OPNIEUW aanroepen. Bubble's workflow is idempotent op email — geeft
//      het bestaande user-id terug + een VERS temp_password. NIETS in DB
//      persisten.
//   5. sendCredentialsWhatsApp({onboardingId, tempPassword, …}) via de
//      gedeelde helper. Template-config in joost_config.knowledge_base.credentials.
//   6. Update credentials_wa_sent_at bij succes.
//
// Fail-soft over hele pipeline; gooit nooit door naar de caller.
// Geen wachtwoord-persist (alleen tijdstempel).
//
// Body: { onboarding_id (uuid) }
//
// Response 200 (fail-soft over de helper-output):
//   { sent:boolean, reason?, error?, template_name?, meta_wamid?, conv_id?, message_id? }
// 401  unauth, 403 geen rechten, 400 body-validatie, 500 onverwacht.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleWorkflow } from './_lib/bubble.js';
import { sendCredentialsWhatsApp } from './_lib/onboarding-credentials.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// Mirror van extractTempPasswordFromWf uit onboarding-provision.js
// (bewust geen import om de helper-graph plat te houden — beide
// functies hebben dezelfde 4-regel-shape).
function extractTempPasswordFromWf(wf) {
  if (!wf || typeof wf !== 'object') return null;
  if (typeof wf.temp_password === 'string' && wf.temp_password.trim()) return wf.temp_password.trim();
  const r = wf.response;
  if (r && typeof r === 'object' && typeof r.temp_password === 'string' && r.temp_password.trim()) {
    return r.temp_password.trim();
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const internalTokenHeader   = req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || null;
  const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
  const isInternalCall = !!(
    internalTokenHeader &&
    expectedInternalToken &&
    typeof internalTokenHeader === 'string' &&
    internalTokenHeader === expectedInternalToken
  );

  let user = null;
  if (!isInternalCall) {
    const userClient = createUserClient(req);
    const { data: { user: u }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !u) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    user = u;
    if (!(await requirePermission(req, 'onboarding.inbox.send'))) {
      return res.status(403).json({ error: 'Geen rechten (onboarding.inbox.send)' });
    }
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!isUuid(onboardingId)) return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });

  try {
    // 1) Onboarding-row laden.
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, bubble_provisioned, archived_at')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) return res.status(200).json({ sent: false, reason: 'db-error', error: 'onboarding lookup: ' + obErr.message });
    if (!ob) return res.status(200).json({ sent: false, reason: 'not-found' });
    if (ob.archived_at) return res.status(200).json({ sent: false, reason: 'archived' });
    if (ob.bubble_provisioned !== true) {
      return res.status(200).json({ sent: false, reason: 'niet-geprovisioned' });
    }
    if (!ob.customer_id) return res.status(200).json({ sent: false, reason: 'no-customer' });

    // 2) Customer laden.
    const { data: customer, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email')
      .eq('id', ob.customer_id)
      .maybeSingle();
    if (cErr) return res.status(200).json({ sent: false, reason: 'db-error', error: 'customer lookup: ' + cErr.message });
    if (!customer) return res.status(200).json({ sent: false, reason: 'customer-not-found' });
    if (!customer.email) return res.status(200).json({ sent: false, reason: 'geen-email' });

    // 3) Workflow opnieuw aanroepen voor een VERS temp_password.
    //    BUBBLE_WF_SECRET wordt meegestuurd zodat Bubble de publieke
    //    workflow kan beveiligen. Lege string bij ontbrekende env.
    //    Reist alleen outbound; diagnostiek logt geen request-body.
    let tempPassword = null;
    try {
      const wf = await bubbleWorkflow('create_student_basic', {
        email:      String(customer.email).trim().toLowerCase(),
        first_name: String(customer.first_name || '').trim(),
        last_name:  String(customer.last_name  || '').trim(),
        secret:     (process.env.BUBBLE_WF_SECRET || ''),
      });
      tempPassword = extractTempPasswordFromWf(wf);
    } catch (e) {
      console.error('[onboarding-credentials-resend] workflow fail:', e?.code || '', e?.message || e);
      return res.status(200).json({
        sent: false, reason: 'workflow-fail',
        error: (e?.code ? String(e.code) + ' ' : '') + (e?.message || String(e)),
      });
    }
    if (!tempPassword) {
      return res.status(200).json({ sent: false, reason: 'geen-temp-password' });
    }

    // 4) WhatsApp-resend via gedeelde helper.
    const result = await sendCredentialsWhatsApp({
      onboardingId,
      tempPassword,
      sentByUserId: user ? user.id : null,
      source:       isInternalCall ? 'system' : 'manual-wa-resend',
    });

    // 5) Bij succes marker zetten (alleen tijdstempel, GEEN wachtwoord).
    if (result && result.sent === true) {
      try {
        await supabaseAdmin
          .from('onboardings')
          .update({ credentials_wa_sent_at: new Date().toISOString() })
          .eq('id', onboardingId);
      } catch (e) {
        console.error('[onboarding-credentials-resend] mark fail:', e?.message || e);
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error('[onboarding-credentials-resend]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
