// api/_lib/activity-logger.js
//
// Activiteitenlogboek (PR1 fundament) — schrijft naar activity_log +
// user_last_activity (migratie 021). Alle inserts draaien met de
// SERVICE-ROLE (supabaseAdmin) → RLS-policies uit 021 blokkeren geen writes.
//
// FIRE-AND-FORGET: fouten worden alleen console.warn'd, nooit gethrow'd.
// Callers (requirePermission, endpoints) moeten NIET afhankelijk zijn van
// de logging-uitkomst — een gefaalde audit mag de hoofdactie nooit breken.
//
// Client-IP-extractie volgt het patroon uit api/_lib/audit-customer.js.

import { supabaseAdmin } from '../supabase.js';

/**
 * Best-effort client-IP uit Vercel proxy-headers.
 */
function getIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req?.headers?.['x-real-ip'] || null;
}

/**
 * Prefix-matching mapping van endpoint-naam (het pad na /api/) op de
 * sidebar-modules. Volgorde = prioriteit: eerste hit wint (specifiek →
 * algemeen). Case-insensitive. Uitbreiden = regel toevoegen bovenaan.
 *
 * De module wordt bij LOGGEN afgeleid en opgeslagen op activity_log.module.
 * Mapping-wijzigingen gelden vooruit; bestaande rijen zonder module tonen
 * later in het PR2-scherm als 'Overig'.
 */
const MODULE_RULES = [
  { module: 'Finance',         test: (s) => /(payout|invoice|finance|\bbank\b|dunning|cash-traject)/i.test(s) },
  { module: 'Onboarding',      test: (s) => /^onboarding/i.test(s) },
  { module: 'Klanten',         test: (s) => /(customer|klant)/i.test(s) },
  { module: 'E-mail',          test: (s) => /(^email|email-)/i.test(s) },
  { module: 'Events',          test: (s) => /event/i.test(s) },
  { module: 'Mentoren beheer', test: (s) => /(mentor|coaching|1on1)/i.test(s) },
  { module: 'Sales',           test: (s) => /(sales|deal|quote)/i.test(s) },
  { module: 'Tickets',         test: (s) => /ticket/i.test(s) },
  { module: 'Follow-up',       test: (s) => /follow-up/i.test(s) },
  { module: 'Admin',           test: (s) => /(admin|user|permission|role|impersonate)/i.test(s) },
  { module: 'Studenten',       test: (s) => /(student|assessment)/i.test(s) },
  { module: 'Kennisbank',      test: (s) => /kennisbank/i.test(s) },
];

/**
 * Leidt de sidebar-module af uit een endpoint (bv. '/api/mentor-payout-approve'
 * of een action-string). Retourneert 'Overig' bij geen match.
 */
export function deriveModule(endpoint) {
  if (!endpoint) return 'Overig';
  const raw = String(endpoint).replace(/^\/?api\/?/i, ''); // strip /api/ prefix
  for (const rule of MODULE_RULES) {
    if (rule.test(raw)) return rule.module;
  }
  return 'Overig';
}

/**
 * Log een activiteit (permission-check, endpoint-toegang, etc.).
 *
 * Fire-and-forget: dit is `async` maar caller moet 'em NIET await'en in
 * critical paths. Elke fout wordt gesluikt (console.warn).
 *
 * @param {object} opts
 * @param {object} opts.req         — Vercel request (voor IP/UA/endpoint/method)
 * @param {string|null} opts.userId — auth.uid (null bij anoniem)
 * @param {string|null} [opts.userEmail]
 * @param {string|null} [opts.userRole]
 * @param {string} opts.action      — permission-key of endpoint-naam
 * @param {number|null} [opts.statusCode] — HTTP-resultaat (bepaalt success)
 * @param {object|null} [opts.detail] — jsonb, ruimte voor verrijking
 */
export async function logActivity({
  req,
  userId       = null,
  userEmail    = null,
  userRole     = null,
  action,
  statusCode   = null,
  detail       = null,
} = {}) {
  try {
    if (!action) return;
    const ip     = getIp(req);
    const ua     = req?.headers?.['user-agent'] || null;
    const url    = req?.url    || null;
    const method = req?.method || null;
    const success = (typeof statusCode === 'number') ? (statusCode < 400) : null;
    // Module wordt bij LOGGEN afgeleid (niet achteraf) — mapping-wijzigingen
    // gelden vooruit. Voer endpoint mee, val terug op action als endpoint
    // ontbreekt zodat 'audit.log.view' en soortgelijke actie-keys ook mappen.
    const module = deriveModule(url || action);

    // 1) Append naar activity_log — fail-soft.
    supabaseAdmin
      .from('activity_log')
      .insert({
        user_id     : userId,
        user_email  : userEmail,
        user_role   : userRole,
        action,
        endpoint    : url,
        method,
        status_code : statusCode,
        success,
        module,
        ip,
        user_agent  : ua,
        detail      : detail || null,
      })
      .then(({ error }) => {
        if (error) console.warn('[activity-logger] insert failed:', error.message);
      })
      .catch((e) => console.warn('[activity-logger] insert exception:', e?.message));

    // 2) Upsert user_last_activity (alleen als we een userId hebben).
    if (userId) {
      supabaseAdmin
        .from('user_last_activity')
        .upsert({
          user_id          : userId,
          user_email       : userEmail || undefined,
          last_activity_at : new Date().toISOString(),
          last_ip          : ip,
          updated_at       : new Date().toISOString(),
        }, { onConflict: 'user_id' })
        .then(({ error }) => {
          if (error) console.warn('[activity-logger] last-activity upsert failed:', error.message);
        })
        .catch((e) => console.warn('[activity-logger] last-activity exception:', e?.message));
    }
  } catch (e) {
    console.warn('[activity-logger] outer exception:', e?.message);
  }
}

/**
 * Registreer een expliciete login (last_login_at). Wordt vanuit een klein
 * endpoint (api/activity-record-login.js) aangeroepen dat de frontend
 * meteen na succesvolle login triggert.
 *
 * Fire-and-forget: net als logActivity — nooit throw'en.
 */
export async function recordLogin({ userId, userEmail = null, ip = null }) {
  try {
    if (!userId) return;
    const nowIso = new Date().toISOString();
    // Upsert: bestaande rij krijgt alleen last_login_at/last_ip een update;
    // last_activity_at wordt bij de eerste beschermde call sowieso gezet.
    supabaseAdmin
      .from('user_last_activity')
      .upsert({
        user_id       : userId,
        user_email    : userEmail || undefined,
        last_login_at : nowIso,
        last_ip       : ip,
        updated_at    : nowIso,
      }, { onConflict: 'user_id' })
      .then(({ error }) => {
        if (error) console.warn('[activity-logger] recordLogin upsert failed:', error.message);
      })
      .catch((e) => console.warn('[activity-logger] recordLogin exception:', e?.message));
  } catch (e) {
    console.warn('[activity-logger] recordLogin outer exception:', e?.message);
  }
}
