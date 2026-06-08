// api/admin-whatsapp-webhook-subscribe.js
// POST → subscribe een WhatsApp Business Account (WABA) op onze Meta-app
// voor webhook-delivery. Bevestigt daarna met een GET op subscribed_apps.
//
// SUPER_ADMIN ONLY. Audit-log entry per call.
//
// Body:
//   { business_account_id : string (required, Meta WABA-ID) }
//
// Response 200:
//   { subscribed: true, subscribed_apps: [...] }
//
// BELANGRIJK:
//   Dit endpoint subscribet alleen de WABA op onze app via POST
//   /<WABA_ID>/subscribed_apps. De daadwerkelijke webhook-fields
//   (messages, message_template_status_update, etc) worden geconfigureerd
//   op app-niveau in Meta Developer Console → WhatsApp → Configuration →
//   Webhooks → Manage. Dit endpoint kan dat niet via Graph API doen.
//
//   Onboarding-stappen voor C2 templates:
//     1) In Meta Developer Console: zorg dat 'messages' EN
//        'message_template_status_update' beide aan staan in de
//        webhook-fields configuratie.
//     2) Run dit endpoint per WABA om de subscription te activeren.
//     3) Verifieer met GET https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps
//        dat onze app erin staat.

import { createUserClient, supabaseAdmin } from './supabase.js';

const META_API_VERSION = 'v25.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

async function logAudit({ action, payload, status = 'success', error_message = null, userId }) {
  try {
    const { error } = await supabaseAdmin.from('agent_audit_log').insert({
      agent_name:    'admin',
      action,
      payload,
      result:        {},
      status,
      error_message,
      triggered_by:  userId || 'system',
    });
    if (error) console.error('[admin-whatsapp-webhook-subscribe] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-whatsapp-webhook-subscribe] audit exception:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    // Auth: Bearer → user → profile.role === 'super_admin'.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    // Body parsing
    const body = req.body || {};
    const businessAccountId = body.business_account_id
      ? String(body.business_account_id).trim()
      : null;
    if (!businessAccountId) {
      return res.status(400).json({ error: 'business_account_id is verplicht' });
    }
    if (!/^[0-9]+$/.test(businessAccountId)) {
      return res.status(400).json({ error: 'business_account_id moet numeriek zijn (Meta WABA-ID)' });
    }

    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(503).json({ error: 'META_WHATSAPP_ACCESS_TOKEN niet geconfigureerd' });
    }

    // 1) POST /<WABA_ID>/subscribed_apps — subscribe onze app op deze WABA
    const subscribeUrl = `${META_BASE_URL}/${encodeURIComponent(businessAccountId)}/subscribed_apps`;
    let subscribeResp;
    let subscribeText = '';
    try {
      subscribeResp = await fetch(subscribeUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
      });
      subscribeText = await subscribeResp.text();
    } catch (e) {
      console.error('[admin-whatsapp-webhook-subscribe] fetch fail:', e.message);
      await logAudit({
        action:        'whatsapp.webhook_subscribe',
        payload:       { business_account_id: businessAccountId },
        status:        'error',
        error_message: 'fetch fail: ' + e.message,
        userId:        user.id,
      });
      return res.status(502).json({ error: 'Meta API onbereikbaar: ' + e.message });
    }

    let subscribeJson = null;
    try { subscribeJson = subscribeText ? JSON.parse(subscribeText) : null; } catch {}

    if (!subscribeResp.ok) {
      const metaErr = subscribeJson?.error || null;
      const errMsg = metaErr
        ? `[${metaErr.code}] ${metaErr.message} (subcode=${metaErr.error_subcode || ''}, fbtrace=${metaErr.fbtrace_id || ''})`
        : `HTTP ${subscribeResp.status}`;
      console.error('[admin-whatsapp-webhook-subscribe] POST subscribed_apps failed:', errMsg, subscribeText.slice(0, 500));
      await logAudit({
        action:        'whatsapp.webhook_subscribe',
        payload:       { business_account_id: businessAccountId, meta_error: metaErr },
        status:        'error',
        error_message: errMsg.slice(0, 500),
        userId:        user.id,
      });
      return res.status(502).json({ error: 'Meta subscribe fail: ' + errMsg });
    }

    // 2) GET /<WABA_ID>/subscribed_apps — bevestigen
    const verifyUrl = `${META_BASE_URL}/${encodeURIComponent(businessAccountId)}/subscribed_apps`;
    let subscribedApps = [];
    try {
      const verifyResp = await fetch(verifyUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const verifyText = await verifyResp.text();
      let verifyJson = null;
      try { verifyJson = verifyText ? JSON.parse(verifyText) : null; } catch {}
      if (verifyResp.ok && Array.isArray(verifyJson?.data)) {
        subscribedApps = verifyJson.data;
      } else {
        console.warn('[admin-whatsapp-webhook-subscribe] GET verify niet OK:', verifyResp.status, verifyText.slice(0, 300));
      }
    } catch (e) {
      // Verify-fout is niet-fataal: de POST is al gelukt. Loggen en doorgaan.
      console.warn('[admin-whatsapp-webhook-subscribe] GET verify exception:', e.message);
    }

    await logAudit({
      action:  'whatsapp.webhook_subscribe',
      payload: {
        business_account_id: businessAccountId,
        subscribed_apps_count: subscribedApps.length,
      },
      status:  'success',
      userId:  user.id,
    });

    return res.status(200).json({
      subscribed: true,
      business_account_id: businessAccountId,
      subscribed_apps: subscribedApps,
    });
  } catch (e) {
    console.error('[admin-whatsapp-webhook-subscribe] unhandled exception:', e.message);
    return res.status(500).json({ error: 'Interne fout: ' + e.message });
  }
}
