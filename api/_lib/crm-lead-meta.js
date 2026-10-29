// api/_lib/crm-lead-meta.js
//
// Meta "Lead"-event voor CRM-funnel-opt-ins die een lead aanmaken maar nog geen
// Lead naar Meta sturen (opstartsessie-boeking, webinar-vangnet). Hergebruikt de
// bestaande poort (meta-lead-poort.js) + de pure sender-delen van lab-meta.js, en
// logt idempotent naar een NIET-lab-specifieke tabel `meta_lead_events`.
//
// Waarom apart van lab-meta.js: de live Lab-flow (stuurLabEvent → lab_meta_events)
// blijft bewust ongemoeid. Deze helper deelt alleen de PURE bouwstenen
// (labUserData, labMetaConfig, verstuurMetHerhaling) zodat matchkwaliteit en
// retry-gedrag 1-op-1 gelijk zijn.
//
// Dedup: event_id = `lead_<lead_id>` (metaLeadEventId, via beslisMetaLead), exact
// dezelfde sleutel als de site-Pixel + site-CAPI. De claim leads.meta_lead_op
// zorgt dat per lead maar één kanaal (site OF CRM) daadwerkelijk verstuurt.
//
// Consent-gate: beslisMetaLead stuurt NIETS zonder advertentie-toestemming. Die
// gate blijft volledig intact; deze helper omzeilt hem niet.
//
// Alles fail-soft: gooit nooit (nooit een boeking/aanmelding breken).

import { supabaseAdmin } from '../supabase.js';
import { beslisMetaLead, metaLeadEventId } from './meta-lead-poort.js';
import { leadHeeftToestemming, legToestemmingVast } from './advertentie-toestemming.js';
import { labUserData, labMetaConfig, verstuurMetHerhaling } from './lab-meta.js';
import { computeAppsecretProof, META_API_VERSION } from './meta-capi.js';
import { leesMetaLeadSettings, funnelAan, effectieveTestCode } from './meta-lead-settings.js';

const LOG_TABEL = 'meta_lead_events';

function matchKeys(ud) {
  return {
    em: !!ud.em, ph: !!ud.ph, fn: !!ud.fn, ln: !!ud.ln,
    country: !!ud.country, external_id: !!ud.external_id,
    fbc: !!ud.fbc, fbp: !!ud.fbp, ip: !!ud.client_ip_address,
  };
}

async function log(rij) {
  const { error } = await supabaseAdmin.from(LOG_TABEL).insert(rij);
  // 23505 = al gelogd (unique event_name+event_id) → Meta kreeg het al. Geen fout.
  if (error && String(error.code) !== '23505') console.warn('[crm-lead-meta] log (soft):', error.message);
  return error;
}

// Log een uitkomst zonder verzending (consent/dedup/funnel-uit), zodat het
// overzicht klopt. event_id = lead_<id> zodat een latere echte verzending
// diezelfde rij naar 'sent' bijwerkt (UNIQUE event_name+event_id; 23505 soft).
async function logUitkomst({ leadId, bron, status, skip_reason }) {
  if (!leadId) return;
  await log({
    bron: bron || null, referentie_id: leadId, event_name: 'Lead',
    event_id: metaLeadEventId(leadId), match_keys: null, status, skip_reason: skip_reason || null,
  });
}

// Strip querystring (geen PII/fbclid in event_source_url of logs).
function schoonUrl(u) {
  if (!u) return null;
  try { const url = new URL(String(u)); return `${url.origin}${url.pathname}`; } catch { return null; }
}

/**
 * Stuurt één 'Lead'-event. Idempotent op (event_name,event_id); een id dat al
 * als 'sent' gelogd staat wordt niet opnieuw verstuurd. Gooit nooit.
 */
async function stuurLeadEvent({ eventId, userData, bronUrl = null, customData = null, bron = null, referentieId = null, testCode = null }) {
  const cfg = labMetaConfig();
  const basis = { bron, referentie_id: referentieId, event_name: 'Lead', event_id: eventId, match_keys: matchKeys(userData || {}) };
  if (!eventId) return { ok: false, status: 'ongeldig' };
  if (!cfg.aan) {
    await log({ ...basis, status: 'skipped', skip_reason: 'META_PIXEL_ID/META_CAPI_TOKEN niet gezet' });
    return { ok: false, status: 'uit' };
  }

  const { data: al } = await supabaseAdmin.from(LOG_TABEL)
    .select('id, status').eq('event_name', 'Lead').eq('event_id', eventId).maybeSingle();
  if (al?.status === 'sent') return { ok: true, status: 'al_verstuurd' };

  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData || {},
  };
  if (bronUrl) event.event_source_url = bronUrl;
  if (customData && typeof customData === 'object') event.custom_data = customData;

  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(cfg.pixelId)}/events`;
  // Token (+ appsecret_proof) in de BODY: nooit in URL/log.
  const body = { data: [event], access_token: cfg.token };
  if (cfg.appSecret) body.appsecret_proof = computeAppsecretProof(cfg.token, cfg.appSecret);
  // Testmode/code komt uit de Meta-koppeling-instelling (env als fallback);
  // zie api/_lib/meta-lead-settings.js (effectieveTestCode).
  if (testCode) body.test_event_code = testCode;

  const { ok, resp } = await verstuurMetHerhaling(url, body);
  if (al) {
    await supabaseAdmin.from(LOG_TABEL).update({ status: ok ? 'sent' : 'failed', meta_response: resp }).eq('id', al.id);
  } else {
    await log({ ...basis, status: ok ? 'sent' : 'failed', meta_response: resp });
  }
  if (!ok) console.error('[crm-lead-meta] Lead mislukt na herhaling', { eventId, status: resp?.status ?? null, fbtrace_id: resp?.error?.fbtrace_id || resp?.fbtrace_id || null });
  return { ok, status: ok ? 'verstuurd' : 'fout' };
}

/** Bewaar fbp/fbc op de lead - alleen als nog leeg (fail-soft; kolom mag ontbreken). */
export async function bewaarFbCookies(sb, leadId, { fbp = null, fbc = null } = {}) {
  if (!leadId || (!fbp && !fbc)) return;
  try {
    const { data, error } = await sb.from('leads').select('fbp, fbc').eq('id', leadId).maybeSingle();
    if (error) return; // kolom ontbreekt of leesfout → stil overslaan
    const patch = {};
    if (fbp && !data?.fbp) patch.fbp = String(fbp).slice(0, 255);
    if (fbc && !data?.fbc) patch.fbc = String(fbc).slice(0, 255);
    if (!Object.keys(patch).length) return;
    const { error: uErr } = await sb.from('leads').update(patch).eq('id', leadId);
    if (uErr && !['42703', 'PGRST204'].includes(String(uErr.code))) console.warn('[crm-lead-meta] fbp/fbc bewaren (soft):', uErr.message);
  } catch (e) {
    console.warn('[crm-lead-meta] fbp/fbc exception (soft):', e?.message || e);
  }
}

/**
 * Stuur het Lead-event voor een CRM-funnel-lead (poort + matching + log). Gooit
 * nooit. `toestemming` undefined → val terug op de keuze die op de lead staat.
 *
 * @param {object} sb  service-role client
 * @param {object} p
 * @param {string} p.leadId
 * @param {string} p.email
 * @param {string} [p.telefoonE164]
 * @param {string} [p.voornaam]
 * @param {string} [p.achternaam]
 * @param {boolean} [p.toestemming]   expliciete body-keuze; anders lead.advertentie_toestemming
 * @param {string} [p.userAgent]      ECHTE bezoeker-UA (door de site doorgestuurd), niet de proxy
 * @param {string} [p.fbp] @param {string} [p.fbc]
 * @param {string} [p.clientIp] @param {string} [p.referer]
 * @param {string} [p.bron]           funnel-slug / endpoint (voor custom_data + log)
 */
export async function meldCrmLead(sb, p = {}) {
  try {
    const { leadId, email, telefoonE164, voornaam, achternaam, userAgent, fbp, fbc, clientIp, referer, bron } = p;

    const settings = await leesMetaLeadSettings(sb);
    // Funnel door de operator uitgezet → niets sturen, wel loggen.
    if (!funnelAan(settings, bron)) {
      await logUitkomst({ leadId, bron, status: 'skipped', skip_reason: 'funnel uitgezet' });
      return { verstuurd: false, reden: 'funnel_uit' };
    }

    let consent = p.toestemming;
    if (consent !== true && consent !== false) consent = await leadHeeftToestemming(sb, { leadId });

    const { eventId, reden } = await beslisMetaLead(sb, { leadId, email, userAgent, toestemming: consent === true });
    if (!eventId) {
      // Consent- en dedup-skips (en de rest) expliciet loggen i.p.v. stil overslaan.
      const skip_reason = reden === 'geen_toestemming' ? 'geen advertentie-toestemming'
        : reden === 'al_gemeld' ? 'al geteld (dedup)'
          : `overgeslagen (${reden})`;
      await logUitkomst({ leadId, bron, status: 'skipped', skip_reason });
      return { verstuurd: false, reden };
    }

    const userData = labUserData({ email, telefoonE164, voornaam, achternaam, externalId: leadId, fbp, fbc, ip: clientIp, userAgent });
    const r = await stuurLeadEvent({
      eventId, userData, bronUrl: schoonUrl(referer),
      customData: bron ? { content_category: String(bron) } : null,
      bron: bron || null, referentieId: leadId,
      testCode: effectieveTestCode(settings),
    });
    return { verstuurd: r.ok, status: r.status, eventId };
  } catch (e) {
    console.error('[crm-lead-meta] meldCrmLead exception (soft):', e?.message || e);
    return { verstuurd: false, reden: 'exception' };
  }
}

/**
 * Alles-in-één voor een funnel-endpoint: legt de advertentie-keuze op de lead
 * vast, bewaart fbp/fbc, en stuurt het Lead-event. Bedoeld voor waitUntil().
 */
export async function verwerkLeadMeta(sb, p = {}) {
  const { leadId, bron } = p;
  if (!leadId) return { verstuurd: false, reden: 'geen_lead' };
  // Advertentie-keuze vastleggen zodra expliciet meegegeven (laatste keuze telt).
  if (p.toestemming === true || p.toestemming === false) {
    await legToestemmingVast(sb, leadId, p.toestemming, bron || 'crm-lead-meta');
  }
  await bewaarFbCookies(sb, leadId, { fbp: p.fbp, fbc: p.fbc });
  return meldCrmLead(sb, p);
}
