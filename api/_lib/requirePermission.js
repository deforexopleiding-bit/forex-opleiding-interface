// api/_lib/requirePermission.js
// RBAC permission-check voor API-endpoints (server-side enforcement).
// Map start met '_' → Vercel behandelt dit NIET als route, alleen als helper.
//
// Gebruikt de DB-functie user_has_permission(user_uuid, fkey) uit migratie 002
// (super_admin = altijd true; anders union over user_roles × role_permissions).
//
// STATUS (Fase 4):
// WEL afgedwongen (token aanwezig, ondubbelzinnige actie, hoog-risico):
//   - send-email.js          → email.reply.send / email.forward.send (reply vs forward)
//   - email-reclassify.js    → email.reclassify.run
//   - reanalyze-all.js       → email.heranalyseer.run
//
// BEWUST NIET server-side afgedwongen op de overige (interne) modules — alleen
// frontend-gating + bestaande auth/RLS. Reden (zie diagnose RBAC Fase 4):
//   1) Inert: meerdere endpoints worden vanuit de frontend met raw fetch (zonder
//      Bearer-token) aangeroepen → requirePermissionFailOpen valt fail-open terug,
//      dus de check zou niets doen. O.a. alle follow-up-* endpoints
//      (follow-up.html gebruikt 13× raw fetch, 0× apiFetch).
//   2) Ambigu / false-positive-risico: gedeelde multi-purpose endpoints koppelen
//      meerdere frontend-feature-keys aan één pad, dus een enkele key-check zou
//      legitiem-toegestane acties onterecht met 403 blokkeren. O.a.:
//        - kennisbank-sync.js  (POST action=upsert_item dekt faq.add + material.upload
//                               + item.edit; PUT/DELETE = item.edit/delete; sync_profile)
//        - taken.js            (POST met body.action voor create/edit/status/delete)
//        - agent-approval.js / agent-meeting.js (gedeeld over control-center/agents/
//                               follow-up-admin met verschillende keys per module)
// Echte server-side afdwinging hier vereist OR-over-meerdere-keys + apiFetch-omzetting
// en is laag-waarde/hoog-risico voor deze interne tools — daarom uitgesteld.

import { supabase, supabaseAdmin } from '../supabase.js';
import { logActivity } from './activity-logger.js';

/**
 * Fire-and-forget wrapper: probeer profiel-email/rol op te halen voor
 * betere leesbaarheid in het logboek. Fout stil wegslikken.
 */
async function _fetchUserProfile(userId) {
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('email, role')
      .eq('id', userId)
      .maybeSingle();
    return data || null;
  } catch { return null; }
}

/**
 * Log de uitkomst van een permissie-check. Volledig fire-and-forget: geen
 * await in de caller, geen throw. Draait profile-lookup + logActivity
 * asynchroon zodat requirePermission's timing niet raakt.
 */
function _fireLog({ req, userId, featureKey, allowed }) {
  try {
    _fetchUserProfile(userId).then((prof) => {
      logActivity({
        req,
        userId,
        userEmail : prof?.email || null,
        userRole  : prof?.role  || null,
        action    : featureKey,
        statusCode: allowed ? 200 : 403,
      });
    }).catch(() => {});
  } catch { /* nooit door laten stromen */ }
}

/**
 * @returns {Promise<boolean>} true als de Bearer-user de feature mag.
 * Zelfde token-patroon als verifyAdmin(): anon-client valideert de token,
 * service-role draait de RPC.
 *
 * De uitkomst (allow of deny) wordt naar activity_log geschreven —
 * fire-and-forget, dus timing/return van deze functie is ongewijzigd. Ook
 * super_admin-acties worden gelogd (super_admin bypasst permission-check
 * in de DB-functie user_has_permission, maar valt hier gewoon door en
 * krijgt data===true).
 */
export async function requirePermission(req, featureKey) {
  try {
    const authHeader = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return false;

    const { data, error } = await supabaseAdmin.rpc('user_has_permission', {
      user_uuid: user.id,
      fkey: featureKey,
    });
    if (error) {
      console.error('[requirePermission] RPC fout:', error.message);
      _fireLog({ req, userId: user.id, featureKey, allowed: false });
      return false;
    }
    const allowed = data === true;
    _fireLog({ req, userId: user.id, featureKey, allowed });
    return allowed;
  } catch (err) {
    console.error('[requirePermission] fout:', err.message);
    return false;
  }
}

/**
 * Fail-open variant: returnt TRUE bij elk twijfelgeval (geen token, token-fout,
 * RPC-fout). ALLEEN FALSE als de RPC bewezen 'false' teruggeeft (geen permission).
 * Gebruik tijdens de migratiefase zodat DB-/auth-problemen niemand buitensluiten.
 * Let op: een request zonder Bearer-token → fail-open (allow). Endpoints die via
 * window.open of raw fetch (zonder auth-header) worden aangeroepen, worden hierdoor
 * dus NIET afgedwongen tot de frontend de token meestuurt.
 * @returns {Promise<boolean>}
 */
export async function requirePermissionFailOpen(req, featureKey) {
  try {
    const authHeader = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return true;        // geen token → fail-open (niet gelogd — geen user)
    const token = authHeader.slice(7);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return true;                          // token-validatie faalt → fail-open (geen user om te loggen)

    const { data, error } = await supabaseAdmin.rpc('user_has_permission', {
      user_uuid: user.id,
      fkey: featureKey,
    });
    if (error) {
      console.error('[requirePermissionFailOpen] RPC fout (fail-open):', error.message);
      _fireLog({ req, userId: user.id, featureKey, allowed: true });   // effectief allowed (fail-open)
      return true;
    }
    const allowed = data !== false;                             // ALLEEN false = bewezen-geen-permission
    _fireLog({ req, userId: user.id, featureKey, allowed });
    return allowed;
  } catch (err) {
    console.error('[requirePermissionFailOpen] fout (fail-open):', err.message);
    return true;                                                // elke fout → fail-open
  }
}

/**
 * Stuurt 403 en returnt false als de user de feature niet mag; anders true.
 *   if (!(await checkPermissionOrDeny(req, res, 'email.reclassify.run'))) return;
 */
export async function checkPermissionOrDeny(req, res, featureKey) {
  const allowed = await requirePermission(req, featureKey);
  if (!allowed) {
    res.status(403).json({ error: 'Insufficient permissions', feature: featureKey });
    return false;
  }
  return true;
}
