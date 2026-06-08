// api/_lib/meta-whatsapp.js
// Skeleton voor Meta WhatsApp Cloud API directe integratie (geen BSP).
//
// PR A1 SCOPE: interface-only — alle send-functies gooien 'Not implemented
// in PR A1' tenzij env vars zijn gezet. Webhook-signature en config-status
// zijn wèl al functioneel zodat PR A2 minimum boilerplate hoeft.
//
// Meta Cloud API recon (Graph API v20.0):
//   Base URL       : https://graph.facebook.com/v20.0
//   Auth           : Authorization: Bearer <ACCESS_TOKEN>   (system-user token)
//   Send messages  : POST /{PHONE_NUMBER_ID}/messages
//   Read templates : GET  /{WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates
//   Webhook sig    : X-Hub-Signature-256 header, sha256=<hex>
//                    HMAC-SHA256 over raw body met APP_SECRET
//
// 24h customer-service window (Meta beleid):
//   Free-form text alleen toegestaan binnen 24h sinds laatste inbound msg.
//   Buiten 24h: verplicht een approved template. last_inbound_at uit
//   whatsapp_conversations is hiervoor de bron.
//
// Doc-referenties:
//   - https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
//   - https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
//   - https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples

import { createHmac, timingSafeEqual } from 'node:crypto';

const META_API_VERSION = 'v20.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

class MetaNotConfiguredError extends Error {
  constructor(missing) {
    super(`Meta WhatsApp niet geconfigureerd (ontbrekend: ${missing.join(', ')})`);
    this.name = 'MetaNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Lees Meta-config uit env vars; throw bij ontbrekende vereiste keys.
 *
 * @param {string[]} required keys die deze caller nodig heeft
 */
function getConfig(required = ['META_WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_PHONE_NUMBER_ID']) {
  const env = process.env;
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new MetaNotConfiguredError(missing);
  return {
    accessToken:      env.META_WHATSAPP_ACCESS_TOKEN,
    phoneNumberId:    env.META_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    appSecret:        env.META_WHATSAPP_APP_SECRET || null,
    verifyToken:      env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN || null,
  };
}

/**
 * Wrapper rond fetch met Meta's Bearer-auth + JSON content-type.
 * opts.body wordt gestringified.
 */
async function metaFetch(path, opts = {}) {
  const cfg = getConfig();
  const url = path.startsWith('http') ? path : `${META_BASE_URL}${path}`;
  const res = await fetch(url, {
    method:  opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${cfg.accessToken}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

/**
 * POST een payload naar /{PHONE_NUMBER_ID}/messages en handle Meta's error-shape
 * uniform. Returnt de parsed JSON respons bij 2xx, throws bij non-2xx met een
 * geformatteerde message + logged het volledige error-object naar console.error
 * voor Vercel Logs.
 *
 * @param {object} requestBody — Meta payload (messaging_product, type, etc.)
 * @returns {Promise<object>} Meta's response JSON
 */
async function metaPostMessage(requestBody) {
  const cfg = getConfig();
  const path = `/${cfg.phoneNumberId}/messages`;
  const res = await metaFetch(path, { method: 'POST', body: requestBody });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = parsed && parsed.error ? parsed.error : null;
    const code     = err?.code ?? res.status;
    const subcode  = err?.error_subcode ?? '';
    const msg      = err?.message ?? text.slice(0, 200);
    const fbtrace  = err?.fbtrace_id ?? '';
    console.error('[meta-whatsapp] POST messages failed', {
      http_status: res.status,
      meta_error:  err,
      raw_body:    parsed ? undefined : text.slice(0, 500),
    });
    throw new Error(`Meta API ${code}: ${msg} (subcode=${subcode}, fbtrace=${fbtrace})`);
  }
  return parsed || {};
}

/**
 * Strip leading '+' voor Meta-format ('316XXXXXXX' niet '+316...').
 */
function toMetaPhone(to) {
  return String(to || '').replace(/^\+/, '');
}

// ── Send: free-form tekst (binnen 24h customer-service window) ─────────────
/**
 * Stuur een tekst-bericht via Meta Cloud API. Vereist dat de klant binnen
 * 24h een inbound bericht heeft gestuurd; anders gebruik sendTemplate met
 * een approved template.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1.
 *
 * @param {object} opts
 * @param {string} opts.to    E.164 zonder + (Meta-eis: '316XXXXXXX' niet '+316...')
 * @param {string} opts.body  tekst
 * @returns {Promise<{ wamid: string }>}
 */
export async function sendText({ to, body }) {
  if (!to || !body) throw new Error('sendText: to + body vereist');
  const requestBody = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                toMetaPhone(to),
    type:              'text',
    text:              { body: String(body), preview_url: false },
  };
  const resp = await metaPostMessage(requestBody);
  // Meta response: { messaging_product, contacts:[...], messages:[{ id: 'wamid.XXX' }] }
  const wamid = resp?.messages?.[0]?.id || null;
  if (!wamid) {
    console.error('[meta-whatsapp] sendText: 2xx maar geen wamid in respons', resp);
    throw new Error('Meta API: 2xx zonder wamid in messages[0].id');
  }
  return { wamid };
}

// ── Send: template (buiten 24h window of bootstrap) ────────────────────────
/**
 * Stuur een approved template. Template moet eerst goedgekeurd zijn in
 * Meta's Business Manager voor de WABA.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1.
 *
 * @param {object} opts
 * @param {string} opts.to            E.164 zonder +
 * @param {string} opts.templateName  bv. 'invoice_reminder_v1'
 * @param {string} opts.languageCode  bv. 'nl' of 'en'
 * @param {object[]} [opts.components] Meta template-components array
 *                                     (header, body, button parameters).
 *                                     Zie Meta docs message-template-components.
 */
export async function sendTemplate({ to, templateName, languageCode = 'nl', variables = [], components = null }) {
  if (!to || !templateName) throw new Error('sendTemplate: to + templateName vereist');

  // Twee aanroep-stijlen ondersteund:
  //  1. variables: ['Jeffrey', 'EUR 80,00']  → bouw één 'body'-component met text-parameters.
  //  2. components: [{ type:'header', parameters:[...] }, ...]  → letterlijk doorgegeven
  //     (voor templates met header/buttons).
  let resolvedComponents = null;
  if (Array.isArray(components) && components.length) {
    resolvedComponents = components;
  } else if (Array.isArray(variables) && variables.length) {
    resolvedComponents = [{
      type: 'body',
      parameters: variables.map(v => ({ type: 'text', text: String(v) })),
    }];
  }

  const requestBody = {
    messaging_product: 'whatsapp',
    to:                toMetaPhone(to),
    type:              'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
      ...(resolvedComponents ? { components: resolvedComponents } : {}),
    },
  };
  const resp = await metaPostMessage(requestBody);
  const wamid = resp?.messages?.[0]?.id || null;
  if (!wamid) {
    console.error('[meta-whatsapp] sendTemplate: 2xx maar geen wamid', resp);
    throw new Error('Meta API: 2xx zonder wamid in messages[0].id');
  }
  return { wamid };
}

// ── Mark inbound message as read (UX-nicety: toont blauwe vinkjes) ─────────
/**
 * Markeert een ontvangen bericht als gelezen in WhatsApp. Goed voor UX
 * (klant ziet dat we het hebben opengeklikt). Optioneel.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1.
 *
 * @param {object} opts
 * @param {string} opts.wamid  Meta's 'wamid.XXX' message-id van inbound msg
 */
export async function markAsRead({ wamid }) {
  if (!wamid) throw new Error('markAsRead: wamid vereist');
  const requestBody = {
    messaging_product: 'whatsapp',
    status:            'read',
    message_id:        wamid,
  };
  // markAsRead returnt { success: true } bij 2xx. Geen wamid in respons —
  // we returnen alleen het succes-resultaat.
  const resp = await metaPostMessage(requestBody);
  return { success: resp?.success === true || true };
}

// ── List approved templates (voor UI dropdown bij outbound) ────────────────
/**
 * Haal goedgekeurde message-templates op voor de WABA.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1.
 */
export async function listTemplates() {
  const cfg = getConfig(['META_WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_BUSINESS_ACCOUNT_ID']);
  const path = `/${cfg.businessAccountId}/message_templates`;
  return Promise.reject(new Error(`Not implemented in PR A1 (path=${path})`));
}

// ── Webhook signature verificatie (WEL geïmplementeerd in PR A1) ───────────
/**
 * Verifieer Meta's X-Hub-Signature-256 header. Implementatie volgt Meta's
 * Facebook-Graph webhook standaard: sha256-HMAC over de RAW request body
 * met APP_SECRET als signing key, hex-encoded.
 *
 * Belangrijk: rawBody moet de exacte byte-string van het request zijn —
 * Vercel parsed JSON-body kan whitespace-verschil hebben. Disable
 * bodyParser in de webhook-handler en lees handmatig (zie inbox-webhook.js).
 *
 * @param {string} signatureHeader  waarde van 'x-hub-signature-256' header
 *                                   (formaat: 'sha256=<hex>')
 * @param {Buffer|string} rawBody   de raw request body
 * @returns {boolean}
 */
export function verifyWebhookSignature(signatureHeader, rawBody) {
  if (!signatureHeader || !rawBody) return false;
  const cfg = getConfig(['META_WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_APP_SECRET']);
  const m = String(signatureHeader).match(/^sha256=([a-f0-9]+)$/i);
  if (!m) return false;
  const provided = Buffer.from(m[1], 'hex');
  const expected = createHmac('sha256', cfg.appSecret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  try { return timingSafeEqual(provided, expected); } catch { return false; }
}

// ── Webhook GET-verify (Meta-eis bij subscriben) ───────────────────────────
/**
 * Verifieer Meta's verify-token tijdens webhook-subscription handshake.
 * Meta stuurt: GET ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y.
 * Wij moeten hub.challenge terug-echoen als hub.verify_token klopt.
 *
 * @param {object} query  req.query van het Vercel-handler
 * @returns {string|null} de challenge als de token klopt, anders null
 */
export function verifyWebhookSubscription(query) {
  const cfg = getConfig(['META_WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_WEBHOOK_VERIFY_TOKEN']);
  const mode      = query?.['hub.mode'];
  const token     = query?.['hub.verify_token'];
  const challenge = query?.['hub.challenge'];
  if (mode === 'subscribe' && token === cfg.verifyToken) {
    return String(challenge || '');
  }
  return null;
}

// ── Diagnostics ─────────────────────────────────────────────────────────────
/**
 * Lees config-status zonder Meta-call: welke env vars ontbreken?
 * Voor UI-banner "Meta WhatsApp nog niet geactiveerd".
 *
 * @returns {{ configured: boolean, missing: string[] }}
 */
export function getConfigStatus() {
  const required = [
    'META_WHATSAPP_ACCESS_TOKEN',
    'META_WHATSAPP_PHONE_NUMBER_ID',
    'META_WHATSAPP_BUSINESS_ACCOUNT_ID',
    'META_WHATSAPP_APP_SECRET',
    'META_WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  ];
  const missing = required.filter(k => !process.env[k]);
  return { configured: missing.length === 0, missing };
}

export { MetaNotConfiguredError, META_BASE_URL, META_API_VERSION };
