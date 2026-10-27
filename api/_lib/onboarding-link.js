// api/_lib/onboarding-link.js
//
// DE LINK NAAR DE ONBOARDING VAN EEN KLANT — één plek.
//
// Twee bestemmingen:
//   · de PORTAL op de website: `${ONBOARDING_PORTAL_URL}?code=XXXX-XXXX`
//     (standaard https://www.deforexopleiding.nl/onboarding). De klant ziet
//     zijn startcode en klikt zelf "Open mijn onboarding".
//   · de KLASSIEKE wizard: `/modules/onboarding.html?t=<token>` (rollback-pad).
//
// PURE functies — de vlag (app_settings 'onboarding_portal_live') leest de
// aanroeper zelf; zie onboardingLink().

import { formatteer, kenStartcodeToe } from './onboarding-startcode.js';

export const PORTAL_URL_STANDAARD = 'https://www.deforexopleiding.nl/onboarding';

/** De basis-URL van de portal: env ONBOARDING_PORTAL_URL (https) of de standaard. */
export function portalBasis(env = process.env.ONBOARDING_PORTAL_URL) {
  const s = String(env || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s?#]+$/i.test(s) ? s : PORTAL_URL_STANDAARD;
}

/** `${basis}?code=XXXX-XXXX`, of null zonder (geldige) startcode. */
export function portalLink(startcode, env) {
  const code = formatteer(startcode);
  return code ? `${portalBasis(env)}?code=${code}` : null;
}

/** Het pad van de klassieke wizard (relatief, zoals overal in het CRM). */
export function klassiekPad(token) {
  return token ? '/modules/onboarding.html?t=' + encodeURIComponent(token) : null;
}

// ── De vlag + de persoonlijke link (PR5, 27 okt 2026) ─────────────────────
//
// app_settings 'onboarding_portal_live' (default false). Staat hij AAN, dan
// wijzen ALLE persoonlijke links (mail, WhatsApp, automations, kopieerknoppen,
// de redirect op modules/onboarding.html) naar de portal met de startcode.
// Staat hij UIT, dan precies zoals vroeger naar de klassieke wizard.

const PUBLIC_BASE_URL = () => (process.env.PUBLIC_BASE_URL || 'https://crm.deforexopleiding.nl').replace(/\/+$/, '');
export const PORTAL_VLAG = 'onboarding_portal_live';
const CACHE_MS = 30 * 1000;
let _cache = { op: 0, live: false };

/** De klassieke wizard, absoluut. */
export function klassiekeLink(token) {
  return token ? `${PUBLIC_BASE_URL()}/modules/onboarding.html?t=${encodeURIComponent(String(token))}` : '';
}

/** Is de vlag aan? Een jsonb true / "true" / {live:true} telt. PURE. */
export function vlagAan(waarde) {
  if (waarde === true) return true;
  if (typeof waarde === 'string') return ['true', '1', 'aan', 'on', 'ja'].includes(waarde.trim().toLowerCase());
  if (waarde && typeof waarde === 'object') return waarde.live === true || waarde.aan === true || waarde.enabled === true;
  return false;
}

/**
 * Leest de vlag (30 s gecachet per functie-instantie). Faalzacht: bij een fout
 * UIT — dan blijft alles bij het oude, beproefde pad.
 */
export async function portalLive(db, { nu = Date.now(), vers = false } = {}) {
  if (!vers && nu - _cache.op < CACHE_MS) return _cache.live;
  try {
    const { data, error } = await db.from('app_settings').select('value').eq('key', PORTAL_VLAG).maybeSingle();
    if (error) throw new Error(error.message);
    _cache = { op: nu, live: vlagAan(data?.value) };
  } catch (e) {
    console.warn('[onboarding-link] vlag lezen (soft, UIT):', e?.message || e);
    _cache = { op: nu, live: false };
  }
  return _cache.live;
}
/** Alleen voor tests. */
export function _resetVlagCache() { _cache = { op: 0, live: false }; }

/** De persoonlijke link voor een onboarding. PURE. */
export function persoonlijkeLink({ token, startcode, live }) {
  if (live) {
    const p = portalLink(startcode);
    if (p) return p;
  }
  return klassiekeLink(token);
}

/**
 * De persoonlijke link, met alles wat erbij hoort: leest de vlag en kent zo
 * nodig nog een startcode toe (een onboarding zonder code krijgt er meteen
 * één — ook bij een vlag die uit staat, want {{onboarding.startcode}} kan in
 * een mail staan).
 * @returns {Promise<{link: string, live: boolean, startcode: string|null}>}
 */
export async function linkVoorOnboarding(db, ob) {
  const live = await portalLive(db);
  let startcode = ob?.startcode || null;
  if (!startcode && ob?.id) startcode = await kenStartcodeToe(db, ob.id);
  return { link: persoonlijkeLink({ token: ob?.token, startcode, live }), live, startcode };
}
