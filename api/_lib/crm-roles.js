// api/_lib/crm-roles.js
//
// Eén plek voor "wie is CRM-staff?" en "waar landt een uitnodigingslink?".
//
// Achtergrond: handle_new_user() geeft elk nieuw auth-account automatisch een
// profiles-rij met rol 'viewer' (of 'student' via het LMS-provisioning-pad).
// Zulke accounts horen NOOIT in het CRM te komen — niet in de data (RLS via
// public.is_crm_staff(), zie docs/sql-migrations/2026-08-19-crm-rls-role-check-
// hardening.sql), niet in de UI (modules/shared/crm-guard.js) en dus ook niet
// via de uitnodigings-/recovery-link die ze in hun mailbox krijgen.
//
// De rollenlijst hieronder moet 1-op-1 gelijk blijven aan:
//   • public.is_crm_staff()            (SQL-hardening)
//   • CRM_STAFF_ROLES                  (modules/shared/crm-guard.js)

/** CRM-medewerkersrollen. 'viewer' en 'student' staan hier bewust NIET in. */
export const CRM_STAFF_ROLES = [
  'super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing',
];

/** CRM-frontend (Agency Command Center). */
export const CRM_SITE_URL = (process.env.CRM_SITE_URL || 'https://forex-opleiding-interface.vercel.app')
  .replace(/\/+$/, '');

/**
 * LMS-frontend. Dit domein staat al in de Supabase Redirect-URL-allowlist.
 * De algemene Supabase Site URL blijft ongemoeid — die gebruiken CRM-staff
 * voor login/wachtwoord-reset.
 */
export const LMS_SITE_URL = (process.env.LMS_SITE_URL || 'https://dfo-lms-prototype.vercel.app')
  .replace(/\/+$/, '');

/** Is deze rol een CRM-medewerkersrol? Onbekend/leeg → false (whitelist). */
export function isCrmStaffRole(role) {
  return CRM_STAFF_ROLES.includes(String(role || ''));
}

/**
 * Waar moet de action_link van een invite/recovery-mail op uitkomen?
 * CRM-staff → de CRM-reset-pagina. Alle andere rollen (viewer/student/
 * onbekend) → het LMS, zodat een student nooit in het CRM belandt.
 */
export function authRedirectUrlForRole(role) {
  return isCrmStaffRole(role)
    ? `${CRM_SITE_URL}/reset-password.html`
    : LMS_SITE_URL;
}

/**
 * Server-side rolpoort voor endpoints die met de SERVICE-ROLE client werken.
 *
 * Belangrijk: de service-role client omzeilt RLS. Een endpoint dat alleen
 * checkt "is er een geldig JWT?" heeft daarmee exact hetzelfde lek als de
 * zwakke RLS-policies — elk auto-aangemaakt viewer/student-account komt erdoor.
 * Deze helper checkt daarom óók de rol.
 *
 * @returns {Promise<{user: object, profile: object}|null>} null = weigeren (403)
 */
export async function requireCrmStaff(req) {
  // Header-check vóór de import: zonder token is er niets op te zoeken, en zo
  // heeft de weiger-tak geen enkele side-effect (handig in tests).
  const authHeader = req?.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const { supabaseAdmin } = await import('../supabase.js');

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  const user = data?.user || null;
  if (error || !user) return null;

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr) {
    console.error('[crm-roles] profiel-lookup mislukt:', profileErr.message);
    return null;
  }
  if (!profile || profile.is_active === false || !isCrmStaffRole(profile.role)) return null;

  return { user, profile };
}
