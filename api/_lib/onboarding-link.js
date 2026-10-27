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

import { formatteer } from './onboarding-startcode.js';

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
