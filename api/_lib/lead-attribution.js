// api/_lib/lead-attribution.js
//
// Meta/UTM/GHL-attributie vangst per GHL-contact. Fundering voor ROAS-per-
// campagne/ad. Zie migratie docs/sql-migrations/2026-07-18-lead-attribution.sql.
//
// STRATEGIE:
//   - normalizeGhlAttribution(input) — pure function. Accepteert 3 shapes:
//       (a) een volledig GHL-contactobject (met .attributionSource + .lastAttributionSource)
//       (b) een losse attributionSource-object
//       (c) null/undefined → { raw: null, ...alle-velden-null }.
//   - upsertLeadAttribution({ghl_contact_id, email, phone, attr}) —
//     DB-schrijver. First-touch: primaire kolommen worden NIET overschreven
//     bij update; alleen last_seen_at + raw krijgen een refresh.
//     Best-effort: pre-migratie / PGRST205 / 42P01 → console.warn + skip,
//     GEEN throw (caller mag niet breken).

import { supabaseAdmin } from '../supabase.js';

// Alle GHL-veldnamen die we kennen — flexibel gedecoderd omdat GHL de shape
// af en toe wijzigt en velden soms alleen in .attributionSource, soms in
// .lastAttributionSource, soms in beide staan. Voor de primaire (=first-
// touch) kolommen prefereren we .attributionSource; valt terug op
// .lastAttributionSource als de eerste ontbreekt.
const ATTR_FIELDS = {
  utm_source:     ['utmSource', 'utm_source'],
  utm_medium:     ['utmMedium', 'utm_medium'],
  // 'campaign': GHL levert de campagne-id van Meta-attributed leads onder
  // deze key (i.p.v. utmCampaign). Fase-5 capture-fix — zonder deze alias
  // bleef utm_campaign NULL en viel de campagne-fallback-join weg.
  utm_campaign:   ['utmCampaign', 'utm_campaign', 'campaign'],
  utm_content:    ['utmContent', 'utm_content'],
  utm_term:       ['utmTerm', 'utm_term'],
  fbclid:         ['fbclid', 'fbCid'],
  session_source: ['sessionSource', 'session_source'],
  medium:         ['medium'],
  referrer:       ['referrer'],
  landing_url:    ['url', 'landingUrl', 'landing_url'],
};

/**
 * Pak de eerste niet-lege waarde uit een lijst kandidaten.
 */
function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Herken PG/PostgREST-varianten voor "tabel/kolom mist" zodat we bij ontbrekende
 * migratie fail-soft skippen i.p.v. te crashen. Dupliceert het pattern uit
 * _lib/customer-link.js (bewust — geen cross-lib coupling).
 */
function isMissingRelationError(err) {
  if (!err) return false;
  // 42P01 = relation does not exist (tabel bestaat niet)
  // 42703 = column does not exist
  // PGRST204/205 = PostgREST cache-miss varianten
  if (err.code === '42P01' || err.code === '42703') return true;
  if (err.code === 'PGRST204' || err.code === 'PGRST205') return true;
  const msg = String(err.message || '') + ' ' + String(err.details || '') + ' ' + String(err.hint || '');
  return /relation .* does not exist/i.test(msg)
      || /column .* does not exist/i.test(msg)
      || /could not find the/i.test(msg)
      || /schema cache/i.test(msg);
}

/**
 * Normaliseer een GHL-contact of attributionSource-object naar de tabelvelden.
 *
 * @param {object|null|undefined} input  GHL-contact OF losse attributionSource.
 * @returns {{
 *   utm_source: string|null,
 *   utm_medium: string|null,
 *   utm_campaign: string|null,
 *   utm_content: string|null,
 *   utm_term: string|null,
 *   fbclid: string|null,
 *   session_source: string|null,
 *   medium: string|null,
 *   referrer: string|null,
 *   landing_url: string|null,
 *   raw: object|null,
 * }}
 */
export function normalizeGhlAttribution(input) {
  const empty = {
    utm_source: null, utm_medium: null, utm_campaign: null,
    utm_content: null, utm_term: null, fbclid: null,
    session_source: null, medium: null, referrer: null,
    landing_url: null, raw: null,
  };
  if (!input || typeof input !== 'object') return empty;

  // Bepaal welke shape we hebben.
  // (a) Volledig contact: heeft .attributionSource of .lastAttributionSource
  // (b) Losse attributionSource: heeft direct utmSource/etc velden.
  let firstTouch = null;
  let lastTouch  = null;
  if ('attributionSource' in input || 'lastAttributionSource' in input) {
    firstTouch = input.attributionSource || null;
    lastTouch  = input.lastAttributionSource || null;
  } else {
    // Direct een attributionSource-shape → behandel als first-touch.
    firstTouch = input;
  }

  // Primaire kolommen (= first-touch): prefereer firstTouch, val terug op
  // lastTouch als firstTouch de key niet heeft.
  const out = { ...empty };
  for (const [outKey, candidates] of Object.entries(ATTR_FIELDS)) {
    const v = pickFirst(firstTouch, candidates) || pickFirst(lastTouch, candidates);
    out[outKey] = v;
  }

  // Bewaar het volledige object voor fase 3 (last-touch/multi-touch).
  out.raw = {
    attributionSource:     firstTouch || null,
    lastAttributionSource: lastTouch  || null,
  };

  return out;
}

/**
 * Upsert een lead-attribution rij. First-touch primaire kolommen worden bij
 * bestaande rij NIET overschreven (via ON CONFLICT DO UPDATE met COALESCE-pattern
 * dat we hier client-side simuleren). last_seen_at + raw krijgen altijd refresh.
 *
 * @param {object} args
 * @param {string} args.ghl_contact_id  verplicht.
 * @param {string|null} [args.email]
 * @param {string|null} [args.phone]
 * @param {object|null} args.attr       GHL-contact OF attributionSource-object.
 * @returns {Promise<{ok:boolean, inserted?:boolean, updated?:boolean, skipped?:string, error?:string}>}
 */
export async function upsertLeadAttribution({ ghl_contact_id, email, phone, attr }) {
  if (!ghl_contact_id) return { ok: false, skipped: 'no_ghl_contact_id' };
  const norm = normalizeGhlAttribution(attr);

  try {
    // Check of er al een rij is (voor first-touch-preservation semantiek).
    const { data: existing, error: sErr } = await supabaseAdmin
      .from('lead_attribution')
      .select('id, first_seen_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, session_source, medium, referrer, landing_url')
      .eq('ghl_contact_id', ghl_contact_id)
      .maybeSingle();

    if (sErr && isMissingRelationError(sErr)) {
      console.warn('[lead-attribution] tabel/kolom niet beschikbaar — migratie draaien:', sErr.message);
      return { ok: false, skipped: 'migration_required' };
    }
    if (sErr) {
      console.warn('[lead-attribution] select faalde:', sErr.message);
      return { ok: false, error: sErr.message };
    }

    if (!existing) {
      // Insert: alle first-touch velden bewaren + last_seen_at + raw.
      const row = {
        ghl_contact_id,
        email:          email || null,
        phone:          phone || null,
        utm_source:     norm.utm_source,
        utm_medium:     norm.utm_medium,
        utm_campaign:   norm.utm_campaign,
        utm_content:    norm.utm_content,
        utm_term:       norm.utm_term,
        fbclid:         norm.fbclid,
        session_source: norm.session_source,
        medium:         norm.medium,
        referrer:       norm.referrer,
        landing_url:    norm.landing_url,
        raw:            norm.raw,
        // first_seen_at + last_seen_at: DB-default now().
      };
      const { error: iErr } = await supabaseAdmin.from('lead_attribution').insert(row);
      if (iErr) {
        if (isMissingRelationError(iErr)) return { ok: false, skipped: 'migration_required' };
        // 23505 unique-conflict = race (rij is intussen aangemaakt). Behandel
        // als update-pad: geen error, geen retry.
        if (iErr.code === '23505') {
          return { ok: true, updated: true, note: 'race_upgraded_to_update' };
        }
        console.warn('[lead-attribution] insert faalde:', iErr.message);
        return { ok: false, error: iErr.message };
      }
      return { ok: true, inserted: true };
    }

    // Update-pad: FIRST-TOUCH kolommen NIET overschrijven (alleen als OUD null was).
    // last_seen_at (via trigger) + raw krijgen altijd refresh; email/phone
    // eveneens NIET overschrijven als ze al gezet zijn (kan drift met customers-
    // rij veroorzaken).
    const patch = { raw: norm.raw };
    // last_seen_at wordt door de trigger op UPDATE gezet. We updaten alleen
    // velden die in existing null zijn (first-touch preservation).
    for (const [k, v] of Object.entries(norm)) {
      if (k === 'raw') continue;
      if (v == null) continue;
      if (existing[k] == null) patch[k] = v;
    }
    if (email && !existing.email) patch.email = email;
    if (phone && !existing.phone) patch.phone = phone;

    const { error: uErr } = await supabaseAdmin
      .from('lead_attribution')
      .update(patch)
      .eq('ghl_contact_id', ghl_contact_id);
    if (uErr) {
      if (isMissingRelationError(uErr)) return { ok: false, skipped: 'migration_required' };
      console.warn('[lead-attribution] update faalde:', uErr.message);
      return { ok: false, error: uErr.message };
    }
    return { ok: true, updated: true };
  } catch (e) {
    console.warn('[lead-attribution] exception:', e?.message || e);
    return { ok: false, error: e?.message || 'exception' };
  }
}
