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

// ── 360dialog (2026-10-05) ─────────────────────────────────────────────────
// De oude Meta-WABA is geblokkeerd. Alle verzendingen lopen nog steeds via
// de functies hieronder (sendText/sendTemplate/sendMedia/markAsRead), maar
// metaPostMessage kiest nu per bericht de PROVIDER:
//   - lijn (phoneNumberId) is een 360dialog-nummer uit api/_lib/wa-nummers.js
//     → POST https://waba-v2.360dialog.io/messages met header D360-API-KEY;
//   - geen lijn → het nummer voor `module` uit de registry (of een nummer met
//     standaard:true — het hoofdnummer is dat bewust NIET), mits de API-key staat;
//   - anders → het oude Meta-pad (ongewijzigd).
// 360dialog spreekt hetzelfde Cloud-API-formaat (body én foutvorm), dus de
// callers merken niets. ONBOARDING mag nooit via het hoofdnummer: met
// module:'onboarding' weigert de transport dat (WaGeenNummerError).

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  D360_BASE_URL, actieveNummers, apiKeyVan, phoneNumberIdUitEnv, nummerVoorModule,
  standaardNummer, moduleMagViaNummer, templateNaamVoor, nummerStatus, NOOIT_VIA_WILDCARD,
  nummerVoorVervangenLijn,
} from './wa-nummers.js';

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
 * @param {object} [opts]
 * @param {string} [opts.phoneNumberId] — override voor cfg.phoneNumberId
 *                                        (multi-line support; bv. module-scoped
 *                                        finance-lijn uit whatsapp_module_config).
 *                                        Bij ontbreken: fallback op env-var.
 * @returns {Promise<object>} Meta's response JSON
 */
async function metaPostMessage(requestBody, opts = {}) {
  const route = await kiesVerzendroute(opts);
  if (route.provider === '360dialog') return d360PostMessage(route.nummer, requestBody);
  const cfg = getConfig();
  const pnId = opts.phoneNumberId || cfg.phoneNumberId;
  const path = `/${pnId}/messages`;
  const res = await metaFetch(path, { method: 'POST', body: requestBody });
  return verwerkMessagesAntwoord(res, 'meta-whatsapp');
}

/** Gedeelde afhandeling van een /messages-antwoord (Meta en 360dialog: zelfde Cloud-API-foutvorm). */
async function verwerkMessagesAntwoord(res, bron) {
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = parsed && parsed.error ? parsed.error : null;
    const code     = err?.code ?? res.status;
    const subcode  = err?.error_subcode ?? '';
    const msg      = err?.message ?? text.slice(0, 200);
    const fbtrace  = err?.fbtrace_id ?? '';
    // error_data bevat bij parameter-fouten (131008 verplichte param ontbreekt,
    // 132000 aantal params) vaak een `details`-string die het ontbrekende/foute
    // onderdeel benoemt. Vastleggen zodat callers niet hoeven te raden.
    const errData  = err?.error_data ?? null;
    const details  = errData && typeof errData.details === 'string' ? errData.details : null;
    console.error(`[${bron}] POST messages failed`, {
      http_status: res.status,
      meta_error:  err,
      error_data:  errData,
      raw_body:    parsed ? undefined : text.slice(0, 500),
    });
    // Attach de gestructureerde Meta-velden aan de Error zodat callers
    // ze kunnen inspecteren (bv. re-engagement 131047 als 24h_window_expired
    // vertalen) i.p.v. te moeten regex'en over de message-string.
    const throwErr = new Error(`Meta API ${code}: ${msg}${details ? ' — ' + details : ''} (subcode=${subcode}, fbtrace=${fbtrace})`);
    throwErr.metaCode      = code;
    throwErr.metaSubcode   = subcode;
    throwErr.metaMessage   = msg;
    throwErr.metaFbtrace   = fbtrace;
    throwErr.metaErrorData = errData;
    throwErr.metaDetails   = details;
    throwErr.httpStatus    = res.status;
    throwErr.provider      = bron === 'meta-whatsapp' ? 'meta' : '360dialog';
    throw throwErr;
  }
  return parsed || {};
}

// ── 360dialog-route ─────────────────────────────────────────────────────────

class WaGeenNummerError extends Error {
  constructor(module, reden) {
    super(`Geen WhatsApp-nummer voor module '${module || '-'}': ${reden}`);
    this.name = 'WaGeenNummerError';
    this.module = module || null;
    this.code = 'WA_GEEN_NUMMER';
  }
}

const D360_TIMEOUT_MS = 15000;
// phone_number_id per 360dialog-nummer, per serverinstantie onthouden als hij
// niet in env staat (GET /health_status?fields=id). Mislukt → null, geen crash.
const _pnIdCache = new Map();

async function d360Fetch(nummer, path, init = {}) {
  const key = apiKeyVan(nummer);
  if (!key) throw new MetaNotConfiguredError([nummer.api_key_env]);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), D360_TIMEOUT_MS);
  try {
    return await fetch(`${D360_BASE_URL}${path}`, {
      ...init,
      headers: { 'D360-API-KEY': key, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Meta's phone_number_id van een 360dialog-nummer: env, anders één keer opvragen. */
export async function d360PhoneNumberId(nummer) {
  const uitEnv = phoneNumberIdUitEnv(nummer);
  if (uitEnv) return uitEnv;
  if (_pnIdCache.has(nummer.sleutel)) return _pnIdCache.get(nummer.sleutel);
  if (!apiKeyVan(nummer)) return null;
  let pnId = null;
  try {
    const res = await d360Fetch(nummer, '/health_status?fields=id');
    const j = res.ok ? await res.json().catch(() => null) : null;
    pnId = j && j.id ? String(j.id) : null;
    if (!pnId) console.warn('[360dialog] phone_number_id niet op te vragen voor', nummer.sleutel, 'HTTP', res.status);
  } catch (e) {
    console.warn('[360dialog] health_status mislukt voor', nummer.sleutel, e?.message || e);
  }
  if (pnId) _pnIdCache.set(nummer.sleutel, pnId);
  return pnId;
}

/**
 * Is deze phone_number_id een van onze 360dialog-nummers? → het nummer, anders null.
 * Ook een VERVANGEN (oude) lijn-ID telt: een send uit een gesprek dat nog op
 * een opgeheven lead-lijn staat, gaat via de opvolger (vervangt_phone_number_ids).
 */
export async function d360NummerVoorPhoneNumberId(pnId) {
  if (!pnId) return null;
  const p = String(pnId).trim();
  const opvolger = nummerVoorVervangenLijn(p);
  if (opvolger && opvolger.provider === '360dialog') return opvolger;
  for (const n of actieveNummers()) {
    if (n.provider !== '360dialog') continue;
    if (phoneNumberIdUitEnv(n) === p) return n;
  }
  for (const n of actieveNummers()) {
    if (n.provider !== '360dialog' || phoneNumberIdUitEnv(n)) continue;
    if ((await d360PhoneNumberId(n)) === p) return n;
  }
  return null;
}

/**
 * De HUIDIGE lijn-ID voor een (mogelijk oude) lijn-ID: een vervangen lijn →
 * het phone_number_id van de opvolger; anders ongewijzigd. Lukt het opvragen
 * van de opvolger-ID niet, dan ook ongewijzigd (fail-soft).
 */
export async function huidigeLijnId(pnId) {
  if (!pnId) return pnId;
  const opvolger = nummerVoorVervangenLijn(pnId);
  if (!opvolger) return String(pnId);
  return (await d360PhoneNumberId(opvolger)) || String(pnId);
}

/**
 * Alle lijn-ID's die bij dezelfde lijn horen: [huidig, ...vervangen]. Voor een
 * lijn die nergens in de registry staat: alleen zichzelf.
 */
export async function lijnFamilie(pnId) {
  if (!pnId) return { huidig: pnId, alle: pnId ? [String(pnId)] : [] };
  const huidig = await huidigeLijnId(pnId);
  const nummer = nummerVoorVervangenLijn(pnId) || (await d360NummerVoorPhoneNumberId(huidig));
  const oud = nummer ? [...(nummer.vervangt_phone_number_ids || [])] : [];
  return { huidig, alle: [...new Set([huidig, ...oud])] };
}

/**
 * Welke provider/welk nummer voor dit bericht?
 * @param {{ phoneNumberId?: string, module?: string }} opts
 * @returns {Promise<{ provider: 'meta' } | { provider: '360dialog', nummer: object }>}
 */
export async function kiesVerzendroute(opts = {}) {
  const module = opts.module ? String(opts.module).toLowerCase() : null;
  if (opts.phoneNumberId) {
    const nummer = await d360NummerVoorPhoneNumberId(opts.phoneNumberId);
    if (nummer) {
      if (module && !moduleMagViaNummer(module, nummer)) {
        throw new WaGeenNummerError(module, `${nummer.sleutel} is niet voor deze module`);
      }
      return { provider: '360dialog', nummer };
    }
    // Onbekende lijn: legacy Meta-pad — behalve voor een module die een eigen
    // registry-nummer heeft (dan dat nummer; de oude Meta-lijn is dicht).
    if (module) {
      const viaModule = nummerVoorModule(module);
      if (viaModule && apiKeyVan(viaModule)) return { provider: '360dialog', nummer: viaModule };
      if (!viaModule && NOOIT_VIA_WILDCARD.includes(module)) {
        throw new WaGeenNummerError(module, 'nog geen eigen nummer');
      }
    }
    return { provider: 'meta' };
  }
  if (module) {
    const viaModule = nummerVoorModule(module);
    if (viaModule && apiKeyVan(viaModule)) return { provider: '360dialog', nummer: viaModule };
    if (!viaModule && NOOIT_VIA_WILDCARD.includes(module)) {
      throw new WaGeenNummerError(module, 'nog geen eigen nummer');
    }
    return { provider: 'meta' };
  }
  const std = standaardNummer();
  if (std && apiKeyVan(std)) return { provider: '360dialog', nummer: std };
  return { provider: 'meta' };
}

async function d360PostMessage(nummer, requestBody) {
  let body = requestBody;
  if (body && body.type === 'template' && body.template && body.template.name) {
    const naam = templateNaamVoor(nummer, body.template.name);
    if (naam !== body.template.name) body = { ...body, template: { ...body.template, name: naam } };
  }
  const res = await d360Fetch(nummer, '/messages', { method: 'POST', body: JSON.stringify(body) });
  return verwerkMessagesAntwoord(res, '360dialog:' + nummer.sleutel);
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
 * @param {string} opts.to              E.164 zonder + (Meta-eis: '316XXXXXXX' niet '+316...')
 * @param {string} opts.body            tekst
 * @param {string} [opts.phoneNumberId] optionele afzendlijn-override (module-scoped).
 *                                      Bij ontbreken: env-var fallback via getConfig.
 * @returns {Promise<{ wamid: string }>}
 */
export async function sendText({ to, body, phoneNumberId, module } = {}) {
  if (!to || !body) throw new Error('sendText: to + body vereist');
  const requestBody = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                toMetaPhone(to),
    type:              'text',
    text:              { body: String(body), preview_url: false },
  };
  const resp = await metaPostMessage(requestBody, { phoneNumberId, module });
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
 * @param {string} opts.to              E.164 zonder +
 * @param {string} opts.templateName    bv. 'invoice_reminder_v1'
 * @param {string} opts.languageCode    bv. 'nl' of 'en'
 * @param {object[]} [opts.components]  Meta template-components array
 *                                      (header, body, button parameters).
 *                                      Zie Meta docs message-template-components.
 * @param {string} [opts.phoneNumberId] optionele afzendlijn-override (module-scoped).
 *                                      Bij ontbreken: env-var fallback via getConfig.
 */
export async function sendTemplate({ to, templateName, languageCode = 'nl', variables = [], components = null, phoneNumberId, module } = {}) {
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
  const resp = await metaPostMessage(requestBody, { phoneNumberId, module });
  const wamid = resp?.messages?.[0]?.id || null;
  if (!wamid) {
    console.error('[meta-whatsapp] sendTemplate: 2xx maar geen wamid', resp);
    throw new Error('Meta API: 2xx zonder wamid in messages[0].id');
  }
  return { wamid };
}

// ── Send: media (image/document/video) via publieke URL ──────────────────
/**
 * Verzend een image/document/video via de Cloud API met een publieke URL
 * (link-mode; alternatief is media-id na upload naar Meta zelf — voor onze
 * eigen bucket-URLs is link-mode simpelst en robuust).
 *
 * Vereist het 24u customer-service-venster (net als sendText). Buiten
 * venster: gebruik sendTemplate met media-header.
 *
 * @param {object} opts
 * @param {string} opts.to              E.164 zonder +
 * @param {string} opts.kind            'image' | 'document' | 'video'
 * @param {string} opts.link            HTTPS-URL naar de bijlage
 * @param {string} [opts.caption]       optionele bijschrift
 * @param {string} [opts.filename]      alleen relevant bij document (Meta toont deze naam)
 * @param {string} [opts.phoneNumberId]
 * @returns {Promise<{ wamid: string }>}
 */
export async function sendMedia({ to, kind, link, caption, filename, phoneNumberId, module } = {}) {
  if (!to || !kind || !link) throw new Error('sendMedia: to + kind + link vereist');
  const validKind = kind === 'image' || kind === 'document' || kind === 'video';
  if (!validKind) throw new Error(`sendMedia: kind '${kind}' niet ondersteund (image|document|video)`);
  if (!/^https:\/\//i.test(link)) throw new Error('sendMedia: link moet https:// zijn');

  const mediaPayload = { link };
  if (caption) mediaPayload.caption = String(caption);
  // Meta accepteert filename alleen op document (image/video negeren het).
  if (kind === 'document' && filename) mediaPayload.filename = String(filename);

  const requestBody = {
    messaging_product: 'whatsapp',
    recipient_type   : 'individual',
    to               : toMetaPhone(to),
    type             : kind,
    [kind]           : mediaPayload,
  };
  const resp = await metaPostMessage(requestBody, { phoneNumberId, module });
  const wamid = resp?.messages?.[0]?.id || null;
  if (!wamid) {
    console.error('[meta-whatsapp] sendMedia: 2xx maar geen wamid', resp);
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
 * @param {string} opts.wamid           Meta's 'wamid.XXX' message-id van inbound msg
 * @param {string} [opts.phoneNumberId] optionele afzendlijn-override (module-scoped).
 *                                      Bij ontbreken: env-var fallback via getConfig.
 */
export async function markAsRead({ wamid, phoneNumberId, module } = {}) {
  if (!wamid) throw new Error('markAsRead: wamid vereist');
  const requestBody = {
    messaging_product: 'whatsapp',
    status:            'read',
    message_id:        wamid,
  };
  // markAsRead returnt { success: true } bij 2xx. Geen wamid in respons —
  // we returnen alleen het succes-resultaat.
  const resp = await metaPostMessage(requestBody, { phoneNumberId, module });
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
  // 2026-10-05: een 360dialog-nummer met API-key telt ook als "geconfigureerd".
  // Veel callers gebruiken dit als poort vóór een verzending; de transport
  // kiest daarna per bericht de juiste route (en weigert wat niet mag).
  const nummers = nummerStatus();
  const d360 = nummers.some((n) => n.provider === '360dialog' && n.api_key);
  return {
    configured: missing.length === 0 || d360,
    missing: d360 ? [] : missing,
    meta: { configured: missing.length === 0, missing },
    d360: { configured: d360, nummers },
  };
}

export { MetaNotConfiguredError, WaGeenNummerError, META_BASE_URL, META_API_VERSION };
