// api/_lib/dfo-lms-db.js
//
// Service-role client voor het NIEUWE LMS-project (dfo-lms,
// absicpdidnoblirngiia). Bewust een APARTE client naast api/supabase.js:
// dat is het CRM-project (forex-command-center) en die twee mogen elkaar
// nooit per ongeluk raken.
//
// LET OP — naamgeving. Er lopen drie systemen door dit repo:
//   1. Bubble            — het oude LMS (api/_lib/bubble.js).
//   2. de trial-site     — 7-daagse / mini-cursus voor leads, met de
//                          lms_gebruikers / lms_toegang / lms_producten-
//                          tabellen IN het CRM-project en een koppeling
//                          naar dfo-website. Zie api/_lib/lms-provisioning.js.
//                          Dat systeem is van een collega: NIET AANRAKEN.
//   3. dfo-lms           — het nieuwe LMS in een eigen Supabase-project,
//                          met de hlms_*-tabellen. Dat is wat dit bestand doet.
//
// Alles wat bij (3) hoort krijgt daarom de prefix `dfo_lms` / `dfoLms`, en
// nooit het generieke `lms` — dat is in dit repo al bezet door (2).
//
// Env (Vercel, alle omgevingen, Sensitive):
//   DFO_LMS_SUPABASE_URL
//   DFO_LMS_SUPABASE_SERVICE_ROLE_KEY
//
// Ontbreekt er één, dan geeft getDfoLmsClient() null terug en slaat de
// aanroeper zijn werk over met een waarschuwing. Nooit een crash: een
// config-probleem mag de onboarding-flow niet breken.

import { createClient } from '@supabase/supabase-js';

let _client = null;
let _warned = false;

/**
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 *   null wanneer de env-vars ontbreken.
 */
export function getDfoLmsClient() {
  if (_client) return _client;

  const url = (process.env.DFO_LMS_SUPABASE_URL || '').trim();
  const key = (process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !key) {
    // Alleen de NAMEN loggen, nooit de waarden.
    if (!_warned) {
      _warned = true;
      const mist = [
        !url ? 'DFO_LMS_SUPABASE_URL' : null,
        !key ? 'DFO_LMS_SUPABASE_SERVICE_ROLE_KEY' : null,
      ].filter(Boolean).join(' + ');
      console.warn('[dfo-lms-db] ontbreekt in env: ' + mist + ' — dfo-lms-koppeling overgeslagen');
    }
    return null;
  }

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

/** Postgres unique_violation. Betekent hier: de rij bestond al. */
export const UNIQUE_VIOLATION = '23505';

/** True als deze Supabase-fout een unique-constraint-botsing is. */
export function isUniqueViolation(error) {
  return !!error && String(error.code || '') === UNIQUE_VIOLATION;
}
