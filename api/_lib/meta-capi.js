// api/_lib/meta-capi.js
//
// Meta Conversions API-helper (fase 6). Server-side terugsturen van
// "klant geworden"-events naar een Meta-dataset zodat Meta op ECHTE
// klanten kan optimaliseren.
//
// STRATEGIE:
//   - Pure helpers (hashSha256 / normalizeEmail / normalizePhoneE164 /
//     extractFbAttribution / buildUserData / buildCapiEvent /
//     computeAppsecretProof) zijn zonder DB/HTTP en unit-testbaar.
//   - postCapiEvents(...) POST naar Graph v20.0 /{dataset}/events
//     met access_token + optioneel appsecret_proof + test_event_code.
//   - Env-gated: getMetaCapiConfig() gooit MetaCapiNotConfiguredError als
//     META_CAPI_DATASET_ID of META_CAPI_ACCESS_TOKEN ontbreekt.
//     Optioneel: META_CAPI_APP_SECRET (voor appsecret_proof),
//     META_CAPI_TEST_EVENT_CODE (test-modus; telt NIET voor optimalisatie).
//
// EVENT-NAAM: bewust 'CRMCustomer' (géén Lead/Purchase — die draaien al
// server-side via het bureau). Custom conversion in Events Manager op
// deze naam om op te optimaliseren.
//
// PHONE-NORMALISATIE: strip alle non-digits; als de eerste digit '0' is
// (typisch Nederlands +0 → 06...), strip die en prepend '31' (NL). Anders
// laat de digits staan (aanname: al met landcode). Meta wil E.164 ZONDER
// '+'-teken, alleen digits. Wij hashen daarna met SHA-256.

import crypto from 'node:crypto';

export const META_API_VERSION = 'v20.0';
export const DEFAULT_EVENT_NAME = 'CRMCustomer';

export class MetaCapiNotConfiguredError extends Error {
  constructor(missing) {
    super('Meta CAPI niet geconfigureerd: ' + missing.join(', '));
    this.name = 'MetaCapiNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Lees en valideer env-config. Gooit MetaCapiNotConfiguredError als
 * verplichte env-vars ontbreken. Callers gebruiken getMetaCapiConfigStatus()
 * eerst voor no-throw-check.
 */
export function getMetaCapiConfig() {
  const datasetId   = process.env.META_CAPI_DATASET_ID || '';
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN || '';
  const appSecret   = process.env.META_CAPI_APP_SECRET || '';
  const testCode    = process.env.META_CAPI_TEST_EVENT_CODE || '';
  const missing = [];
  if (!datasetId)   missing.push('META_CAPI_DATASET_ID');
  if (!accessToken) missing.push('META_CAPI_ACCESS_TOKEN');
  if (missing.length) throw new MetaCapiNotConfiguredError(missing);
  return { datasetId, accessToken, appSecret: appSecret || null, testCode: testCode || null };
}

export function getMetaCapiConfigStatus() {
  try {
    const cfg = getMetaCapiConfig();
    return {
      configured: true,
      test_mode:  !!cfg.testCode,
      appsecret_proof: !!cfg.appSecret,
      missing: [],
    };
  } catch (e) {
    return {
      configured: false,
      test_mode:  false,
      appsecret_proof: false,
      missing: e?.missing || [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 hex-hash van een string. */
export function hashSha256(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/** Trim + lowercase. Return null bij empty. */
export function normalizeEmail(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return s;
}

/**
 * Normaliseer telefoon naar E.164-digits (geen '+', geen spaties). NL-
 * conventie: leading 0 → 31. Return null bij <5 digits (te kort om zinvol
 * te hashen).
 */
export function normalizePhoneE164(raw) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Nederlandse gewoonte: 0031... → 31...
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Puur '0XXXXXXXXX' → prepend NL landcode.
  if (digits.startsWith('0')) digits = '31' + digits.slice(1);
  if (digits.length < 5) return null;
  return digits;
}

export function hashedEmail(raw) {
  const n = normalizeEmail(raw);
  return n ? hashSha256(n) : null;
}
export function hashedPhone(raw) {
  const n = normalizePhoneE164(raw);
  return n ? hashSha256(n) : null;
}

/**
 * Uit lead_attribution.raw (jsonb {attributionSource, lastAttributionSource})
 * de Meta-specifieke match-signalen halen. attributionSource wint;
 * lastAttributionSource is fallback per veld.
 */
export function extractFbAttribution(rawJsonb) {
  if (!rawJsonb || typeof rawJsonb !== 'object') return {};
  const first = rawJsonb.attributionSource || {};
  const last  = rawJsonb.lastAttributionSource || {};
  const pick = (k) => {
    const v = (first && first[k] != null && String(first[k]).trim() !== '') ? first[k]
            : (last  && last[k]  != null && String(last[k]).trim()  !== '') ? last[k]
            : null;
    return v == null ? null : String(v).trim();
  };
  const out = {};
  const fbc = pick('fbc');       if (fbc) out.fbc = fbc;
  const fbp = pick('fbp');       if (fbp) out.fbp = fbp;
  // GHL-shapes variëren; probeer meerdere key-varianten voor ip/ua.
  const ip  = pick('ip') || pick('ipAddress') || pick('client_ip_address');
  if (ip)  out.client_ip_address  = ip;
  const ua  = pick('userAgent') || pick('user_agent') || pick('client_user_agent');
  if (ua)  out.client_user_agent  = ua;
  return out;
}

/**
 * Bouw het user_data-object dat Meta CAPI verwacht. Alleen velden met
 * waarde worden opgenomen (Meta accepteert géén "em":[null] of lege
 * arrays). em/ph zijn arrays van SHA-256 hex-strings (Meta wil array,
 * ook al is er 1 waarde).
 *
 * @param {object} args
 * @param {{email?:string, phone?:string}} args.customer
 * @param {object|null} args.attrRaw   lead_attribution.raw jsonb
 * @returns {object}  user_data (mogelijk leeg als er geen sleutels zijn)
 */
export function buildUserData({ customer, attrRaw }) {
  const out = {};
  const em = customer ? hashedEmail(customer.email) : null;
  if (em) out.em = [em];
  const ph = customer ? hashedPhone(customer.phone) : null;
  if (ph) out.ph = [ph];
  Object.assign(out, extractFbAttribution(attrRaw));
  return out;
}

/**
 * True als user_data een sleutel bevat waarmee Meta een user kan matchen.
 * ip/ua alleen is NIET voldoende volgens Meta's minimum-match-key beleid.
 */
export function hasUsableMatchKey(userData) {
  if (!userData || typeof userData !== 'object') return false;
  return !!(userData.em || userData.ph || userData.fbc);
}

/**
 * Bouw het complete CAPI-event-object.
 * @param {object} args
 * @param {string} args.dealId
 * @param {string|Date|number} args.dealCreatedAt
 * @param {number} args.value             deals.total_amount
 * @param {object} args.customer          {email, phone}
 * @param {object|null} args.attrRaw      lead_attribution.raw
 * @param {string} [args.eventName='CRMCustomer']
 * @param {string} [args.currency='EUR']
 * @returns {{event:object, userData:object, matchKeys:object}}
 */
export function buildCapiEvent({ dealId, dealCreatedAt, value, customer, attrRaw, eventName, currency }) {
  const userData = buildUserData({ customer, attrRaw });
  const matchKeys = {
    em:         !!userData.em,
    ph:         !!userData.ph,
    fbc:        !!userData.fbc,
    fbp:        !!userData.fbp,
    client_ip:  !!userData.client_ip_address,
    client_ua:  !!userData.client_user_agent,
  };
  // event_time in unix-sec — Meta accepteert tot 7 dagen terug.
  const dt = new Date(dealCreatedAt || Date.now());
  const eventTime = Math.floor(dt.getTime() / 1000);
  const eventNameFinal = eventName || DEFAULT_EVENT_NAME;
  const event = {
    event_name:    eventNameFinal,
    event_time:    eventTime,
    action_source: 'system_generated',
    event_id:      'crm_customer_' + String(dealId),
    user_data:     userData,
    custom_data: {
      value:    Number(value || 0),
      currency: currency || 'EUR',
    },
  };
  return { event, userData, matchKeys };
}

/**
 * Meta appsecret_proof = HMAC-SHA256(access_token, app_secret) hex.
 * Aanbevolen door Meta voor server-side calls; niet strikt vereist.
 */
export function computeAppsecretProof(accessToken, appSecret) {
  return crypto.createHmac('sha256', String(appSecret)).update(String(accessToken)).digest('hex');
}

/**
 * POST events-array naar Graph /{dataset}/events.
 * @param {object} args
 * @param {object|Array} args.event   event-object OF array van events
 * @param {string} [args.testCode]    override; anders uit env META_CAPI_TEST_EVENT_CODE
 * @returns {Promise<{ok:boolean, status:number, body:any, url:string}>}
 */
export async function postCapiEvents({ event, testCode } = {}) {
  const cfg = getMetaCapiConfig();
  const events = Array.isArray(event) ? event : [event];
  const effectiveTestCode = testCode !== undefined ? testCode : cfg.testCode;

  const url = new URL('https://graph.facebook.com/' + META_API_VERSION + '/' + encodeURIComponent(cfg.datasetId) + '/events');
  url.searchParams.set('access_token', cfg.accessToken);
  if (cfg.appSecret) {
    url.searchParams.set('appsecret_proof', computeAppsecretProof(cfg.accessToken, cfg.appSecret));
  }

  const body = { data: events };
  if (effectiveTestCode) body.test_event_code = effectiveTestCode;

  const resp = await fetch(url.toString(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  let respBody;
  try { respBody = await resp.json(); } catch (_) { respBody = null; }
  // URL-zonder-token in return zodat callers 'em kunnen loggen zonder secret te lekken.
  const safeUrl = 'https://graph.facebook.com/' + META_API_VERSION + '/' + cfg.datasetId + '/events';
  return { ok: resp.ok, status: resp.status, body: respBody, url: safeUrl };
}
