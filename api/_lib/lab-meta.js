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
export function labUserData({ email, telefoonE164, voornaam, externalId, fbc, fbp, ip, userAgent }) {
  const ud = {};
  const em = normalizeEmail(email);
  if (em) ud.em = [hashSha256(em)];
  const ph = String(telefoonE164 || '').replace(/\D/g, '');
  if (ph.length >= 8) ud.ph = [hashSha256(ph)];
  const fn = String(voornaam || '').trim().toLowerCase();
  if (fn) ud.fn = [hashSha256(fn)];
  if (externalId) ud.external_id = [hashSha256(String(externalId))];
  if (fbc) ud.fbc = fbc;
  if (fbp) ud.fbp = fbp;
  if (ip) ud.client_ip_address = ip;
  if (userAgent) ud.client_user_agent = userAgent;
  return ud;
}

function matchKeys(ud) {
  return { em: !!ud.em, ph: !!ud.ph, fn: !!ud.fn, external_id: !!ud.external_id, fbc: !!ud.fbc, fbp: !!ud.fbp, ip: !!ud.client_ip_address };
}

async function log(rij) {
  const { error } = await supabaseAdmin.from('lab_meta_events').insert(rij);
  // 23505 = dit event is al eens gelogd → Meta kreeg het al. Geen fout.
  if (error && String(error.code) !== '23505') console.warn('[lab-meta] log (soft):', error.message);
  return error;
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
 */
export async function stuurLabEvent({ eventName, eventId, aanmeldingId = null, userData, bronUrl = null, tijd = null, customData = null }) {
  const cfg = labMetaConfig();
  const basis = { aanmelding_id: aanmeldingId, event_name: eventName, event_id: eventId, match_keys: matchKeys(userData || {}) };
  if (!LAB_EVENTS.includes(eventName) || !eventId) return { ok: false, status: 'ongeldig' };
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
  url.searchParams.set('access_token', cfg.token);
  if (cfg.appSecret) url.searchParams.set('appsecret_proof', computeAppsecretProof(cfg.token, cfg.appSecret));
  const body = { data: [event] };
  if (cfg.testCode) body.test_event_code = cfg.testCode;

  let ok = false; let resp = null;
  try {
    const r = await fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    ok = r.ok;
    try { resp = await r.json(); } catch { resp = { status: r.status }; }
  } catch (e) {
    resp = { fout: String(e?.message || e).slice(0, 300) };
  }
  if (al) {
    const { error } = await supabaseAdmin.from('lab_meta_events')
      .update({ status: ok ? 'sent' : 'failed', meta_response: resp }).eq('id', al.id);
    if (error) console.warn('[lab-meta] log bijwerken (soft):', error.message);
  } else {
    await log({ ...basis, status: ok ? 'sent' : 'failed', meta_response: resp });
  }
  if (!ok) console.warn('[lab-meta] event mislukt', { eventName, eventId });
  return { ok, status: ok ? 'verstuurd' : 'fout' };
}
