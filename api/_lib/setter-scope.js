// api/_lib/setter-scope.js
//
// BP2 setter-scope: helper die bepaalt of de ingelogde user in het
// "appointmentsetter"-scope-regime valt en welke leads (email + telefoon-
// last9) daarbij horen — op basis van follow_up_appointments.setter_user_id.
//
// Callers (leadsonderhoud read-endpoints) doen na `requirePermission`:
//   const scope = await getSetterScope(user.id, supabaseAdmin);
//   if (scope.isScoped) {
//     // filter query.in('email', scope.emails) + telefoon-last9-match client-side
//   } else {
//     // manager/admin/super_admin/sales/mentor — ongefilterd (bestaand gedrag)
//   }
//
// Fail-closed: bij DB-fout of lege boekingen-set → isScoped=true met lege
// arrays. Endpoint filtert dan op lege set → 0 rijen. Betere UX dan
// per-ongeluk alles tonen.
//
// INCASSO-VEILIG: leest alleen profiles + user_roles + follow_up_appointments.
// Schrijft niets.

const SETTER_ROLE = 'appointmentsetter';

/**
 * Bepaal of user in setter-scope zit + haal haar lead-emails + telefoon-last9's op.
 *
 * @param {string} userId — auth.users.id van de ingelogde user
 * @param {object} supabaseAdmin — service-role client
 * @returns {Promise<{
 *   isScoped: boolean,       // true = strikt gescoped op eigen calls
 *   emails: string[],        // lowercase emails uit haar boekingen
 *   phoneLast9: string[],    // telefoon-last9-digits uit haar boekingen
 *   appointmentIds: string[],// alle appointment-ids (voor Mijn afspraken)
 * }>}
 */
export async function getSetterScope(userId, supabaseAdmin) {
  const empty = { isScoped: false, emails: [], phoneLast9: [], appointmentIds: [] };
  if (!userId || !supabaseAdmin) return empty;

  try {
    // 1) Rol-check: is user een appointmentsetter?
    //    Kijk in user_roles (multi-role) én profiles.role (primary).
    //    Manager/admin/super_admin krijgen NOOIT scoping — die krijgen
    //    ongefilterde toegang zoals nu.
    const [profRes, urRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('role, is_active').eq('id', userId).maybeSingle(),
      supabaseAdmin.from('user_roles').select('role').eq('user_id', userId),
    ]);

    const primary = String(profRes?.data?.role || '').toLowerCase();
    const allRoles = new Set((urRes?.data || []).map((r) => String(r.role || '').toLowerCase()));
    if (primary) allRoles.add(primary);

    // Bypass-rollen: als user OOK een management-rol heeft, geen scoping.
    // (Setter+manager combo: manager wint → ongefilterd.)
    const BYPASS = ['super_admin', 'admin', 'manager'];
    for (const b of BYPASS) if (allRoles.has(b)) return empty;

    // Alleen scopen als appointmentsetter-rol expliciet aanwezig is.
    if (!allRoles.has(SETTER_ROLE)) return empty;

    // 2) Haal alle boekingen op met setter_user_id = user.
    //    Bounded op 5000 (defensief; setter zal in de praktijk ver onder
    //    dit aantal calls hebben — dit is de anker voor alle scoping).
    const { data: appts, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_email, lead_phone')
      .eq('setter_user_id', userId)
      .limit(5000);
    if (error) {
      console.warn('[setter-scope] appointments lookup fail:', error.message);
      // Fail-closed: setter blijft in scope-regime met lege set → 0 rijen.
      return { isScoped: true, emails: [], phoneLast9: [], appointmentIds: [] };
    }

    const emails = new Set();
    const phones = new Set();
    const ids = [];
    for (const a of (appts || [])) {
      if (a.id) ids.push(a.id);
      if (a.lead_email) emails.add(String(a.lead_email).trim().toLowerCase());
      const digits = String(a.lead_phone || '').replace(/\D/g, '');
      if (digits.length >= 8) phones.add(digits.slice(-9));
    }

    return {
      isScoped: true,
      emails: [...emails],
      phoneLast9: [...phones],
      appointmentIds: ids,
    };
  } catch (e) {
    console.warn('[setter-scope] exception:', e?.message || e);
    // Fail-closed: onbekende staat → als een setter behandelen met lege set.
    return { isScoped: true, emails: [], phoneLast9: [], appointmentIds: [] };
  }
}

/**
 * Client-side helper voor callers die zelf al een lijst hebben en willen
 * filteren op de setter-scope. Retourneert alleen items waar:
 *   emailField (lowercase) in scope.emails
 *   OF phoneField (last-9-digits) in scope.phoneLast9
 *
 * @param {Array} items — de te filteren array
 * @param {object} scope — resultaat van getSetterScope
 * @param {object} keys — { email: 'email-fieldname', phone: 'phone-fieldname' }
 * @returns {Array} — gefilterde subset
 */
export function filterBySetterScope(items, scope, keys = {}) {
  if (!scope?.isScoped) return items;
  const emailKey = keys.email || 'email';
  const phoneKey = keys.phone || 'telefoon';
  const emailSet = new Set(scope.emails || []);
  const phoneSet = new Set(scope.phoneLast9 || []);
  if (emailSet.size === 0 && phoneSet.size === 0) return [];  // fail-closed
  return (items || []).filter((it) => {
    const em = String(it?.[emailKey] || '').trim().toLowerCase();
    if (em && emailSet.has(em)) return true;
    const ph = String(it?.[phoneKey] || '').replace(/\D/g, '');
    if (ph.length >= 8 && phoneSet.has(ph.slice(-9))) return true;
    return false;
  });
}
