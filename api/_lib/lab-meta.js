// api/_lib/lab-meta.js
//
// Meta Conversions API voor The Lab. STAAT UIT zolang META_PIXEL_ID of
// META_CAPI_TOKEN leeg is: dan wordt elk event als 'skipped' gelogd en gaat er
// niets naar Meta.
//
// Events en hun event_id (deduplicatie met de browser-pixel, die dezelfde id
// meekrijgt in de response van de aanmelding):
//   Lead          lab_lead_<aanmelding_id>          bij de aanmelding
//   LabGestart    lab_gestart_<lms_auth_id>         eerste stap in The Lab
//   LabAfgewerkt  lab_afgewerkt_<lms_auth_id>       laatste stap bereikt
//   Schedule      lab_schedule_<afspraak_id>        strategiesessie geboekt
//
// Geen persoonsgegevens in URL's of logs: e-mail, telefoon en voornaam gaan
// alleen gehasht (sha256) in de body naar Meta; de log bewaart enkel welke
// sleutels er waren (booleans).
//
// Matchkwaliteit + betrouwbaarheid (2026-10-25, gelijk aan dfo-website lib/meta-capi.ts):
// ook achternaam (ln) en land (country, uit het E.164-nummer); namen zonder
// leestekens/spaties; de token (+ appsecret_proof) in de BODY i.p.v. de URL;
// tot 3 pogingen (0/500/1500 ms) bij netwerkfout, 5xx of 429; definitief
// mislukt → console.error (en status 'failed' in lab_meta_events).

import { supabaseAdmin } from '../supabase.js';
import { hashSha256, normalizeEmail, computeAppsecretProof, META_API_VERSION } from './meta-capi.js';

export const LAB_EVENTS = Object.freeze(['Lead', 'LabGestart', 'LabAfgewerkt', 'Schedule']);

export function labMetaConfig() {
  const pixelId = String(process.env.META_PIXEL_ID || '').trim();
  const token = String(process.env.META_CAPI_TOKEN || '').trim();
  return {
    aan: !!(pixelId && token),
    pixelId, token,
    appSecret: String(process.env.META_CAPI_APP_SECRET || '').trim() || null,
    testCode: String(process.env.META_CAPI_TEST_EVENT_CODE || '').trim() || null,
  };
}

/** De event_id voor een event. PURE. */
export function labEventId(eventName, sleutel) {
  const prefix = { Lead: 'lab_lead', LabGestart: 'lab_gestart', LabAfgewerkt: 'lab_afgewerkt', Schedule: 'lab_schedule' }[eventName];
  if (!prefix || !sleutel) return null;
  return `${prefix}_${sleutel}`;
}

/**
 * user_data volgens de Meta-spec. PURE.
 * Telefoon: E.164 zonder '+', zoals Meta het wil — al genormaliseerd door de
 * NL/BE-regel bij de aanmelding (de oude normalizePhoneE164 plakte +31 voor
 * elk Belgisch nummer).
 */
/** Namen: lowercase, zonder leestekens/spaties (letters met accenten blijven). PURE. */
export function normaliseerNaam(v) {
  return String(v || '').normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{M}]/gu, '');
}

/** Land (ISO-2, lowercase) uit een E.164-nummer — alleen NL/BE. PURE. */
export function landUitE164(e164) {
  const d = String(e164 || '').replace(/[^0-9+]/g, '');
  if (d.startsWith('+31')) return 'nl';
  if (d.startsWith('+32')) return 'be';
  return null;
}

export function labUserData({ email, telefoonE164, voornaam, achternaam, externalId, fbc, fbp, ip, userAgent }) {
  const ud = {};
  const em = normalizeEmail(email);
  if (em) ud.em = [hashSha256(em)];
  const ph = String(telefoonE164 || '').replace(/\D/g, '');
  if (ph.length >= 8) ud.ph = [hashSha256(ph)];
  const fn = normaliseerNaam(voornaam);
  if (fn) ud.fn = [hashSha256(fn)];
  const ln = normaliseerNaam(achternaam);
  if (ln) ud.ln = [hashSha256(ln)];
  const land = landUitE164(telefoonE164);
  if (land) ud.country = [hashSha256(land)];
  if (externalId) ud.external_id = [hashSha256(String(externalId))];
  if (fbc) ud.fbc = fbc;
  if (fbp) ud.fbp = fbp;
  if (ip) ud.client_ip_address = ip;
  if (userAgent) ud.client_user_agent = userAgent;
  return ud;
}

function matchKeys(ud) {
  return { em: !!ud.em, ph: !!ud.ph, fn: !!ud.fn, ln: !!ud.ln, country: !!ud.country, external_id: !!ud.external_id, fbc: !!ud.fbc, fbp: !!ud.fbp, ip: !!ud.client_ip_address };
}

async function log(rij) {
  const { error } = await supabaseAdmin.from('lab_meta_events').insert(rij);
  // 23505 = dit event is al eens gelogd → Meta kreeg het al. Geen fout.
  if (error && String(error.code) !== '23505') console.warn('[lab-meta] log (soft):', error.message);
  return error;
}

export const LAB_CAPI_WACHT_MS = Object.freeze([0, 500, 1500]);

/**
 * POST met herhaalpogingen: alleen bij netwerkfout, 5xx of 429 (een 4xx is een
 * fout event of token — herhalen helpt niet). Gooit nooit.
 */
export async function verstuurMetHerhaling(url, body, { fetchFn = fetch, wacht = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let resp = null;
  for (let i = 0; i < LAB_CAPI_WACHT_MS.length; i += 1) {
    if (LAB_CAPI_WACHT_MS[i]) await wacht(LAB_CAPI_WACHT_MS[i]);
    try {
      const r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      try { resp = await r.json(); } catch { resp = {}; }
      resp = { ...(resp && typeof resp === 'object' ? resp : {}), status: r.status, pogingen: i + 1 };
      if (r.ok) return { ok: true, resp };
      if (r.status !== 429 && r.status < 500) return { ok: false, resp };
    } catch (e) {
      resp = { fout: String(e?.message || e).slice(0, 300), pogingen: i + 1 };
    }
  }
  return { ok: false, resp };
}

/**
 * Stuurt één event. Gooit nooit. Idempotent: een event_id dat al als 'sent'
 * gelogd staat wordt niet opnieuw verstuurd.
 *
 * @param {object} p
 * @param {'Lead'|'LabGestart'|'LabAfgewerkt'|'Schedule'} p.eventName
 * @param {string} p.eventId
 * @param {string|null} [p.aanmeldingId]
 * @param {object} p.userData         uit labUserData
 * @param {string|null} [p.bronUrl]   event_source_url (zonder querystring)
 * @param {number} [p.tijd]           unix seconden
 * @param {object|null} [p.customData] custom_data (content_category, funnel, ...)
 * @param {boolean} p.toestemming     toestemming advertentiecookies — VERPLICHT; zonder gaat er niets naar Meta
 */
export async function stuurLabEvent({ eventName, eventId, aanmeldingId = null, userData, bronUrl = null, tijd = null, customData = null, toestemming = false }) {
  const cfg = labMetaConfig();
  const basis = { aanmelding_id: aanmeldingId, event_name: eventName, event_id: eventId, match_keys: matchKeys(userData || {}) };
  if (!LAB_EVENTS.includes(eventName) || !eventId) return { ok: false, status: 'ongeldig' };
  // Geen toestemming voor advertentiecookies → niets naar Meta (2026-10-25).
  if (toestemming !== true) {
    await log({ ...basis, status: 'skipped', skip_reason: 'geen_toestemming' });
    return { ok: false, status: 'geen_toestemming' };
  }
  if (!cfg.aan) {
    await log({ ...basis, status: 'skipped', skip_reason: 'META_PIXEL_ID/META_CAPI_TOKEN niet gezet' });
    return { ok: false, status: 'uit' };
  }

  const { data: al } = await supabaseAdmin.from('lab_meta_events')
    .select('id, status').eq('event_name', eventName).eq('event_id', eventId).maybeSingle();
  if (al?.status === 'sent') return { ok: true, status: 'al_verstuurd' };

  const event = {
    event_name: eventName,
    event_time: tijd || Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData || {},
  };
  if (bronUrl) event.event_source_url = bronUrl;
  if (customData && typeof customData === 'object') event.custom_data = customData;

  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(cfg.pixelId)}/events`);
  // Token (+ appsecret_proof) in de BODY: nooit in een URL, log of foutmelding.
  const body = { data: [event], access_token: cfg.token };
  if (cfg.appSecret) body.appsecret_proof = computeAppsecretProof(cfg.token, cfg.appSecret);
  if (cfg.testCode) body.test_event_code = cfg.testCode;

  const { ok, resp } = await verstuurMetHerhaling(url.toString(), body);
  if (al) {
    const { error } = await supabaseAdmin.from('lab_meta_events')
      .update({ status: ok ? 'sent' : 'failed', meta_response: resp }).eq('id', al.id);
    if (error) console.warn('[lab-meta] log bijwerken (soft):', error.message);
  } else {
    await log({ ...basis, status: ok ? 'sent' : 'failed', meta_response: resp });
  }
  if (!ok) console.error('[lab-meta] event mislukt na herhaalpogingen', { eventName, eventId, status: resp?.status ?? null, fbtrace_id: resp?.error?.fbtrace_id || resp?.fbtrace_id || null });
  return { ok, status: ok ? 'verstuurd' : 'fout' };
}
