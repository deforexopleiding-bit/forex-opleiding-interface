// modules/klanten-v2/views/klant-rechten.js
//
// Knop-zichtbaarheid voor klant-acties. Geen imports, geen side-effects:
// list.js laadt dit dynamisch (zijn modals mogen de lijst nooit breken),
// detail.js en tabs/profiel.js importeren het statisch.

// Mag de huidige gebruiker een klant bewerken? Spiegel van de server-check op
// PATCH /api/customer: verifyAdmin (super_admin/admin/manager) OF het recht
// `customer.edit`. In de shell is Supabase-'admin' de shell-rol 'super_admin'
// (design-system/roles.js), dus super_admin + manager dekken verifyAdmin.
// FAIL-OPEN: zijn de rechten (nog) niet geladen, dan tonen we de knop — de
// server blijft de echte poort. Puur cosmetisch: geen knop die op 403 loopt.
const KLANT_BEWERKEN_ROLLEN = ['super_admin', 'admin', 'manager'];
export function magKlantBewerken() {
  try {
    const rollen = (window.DFO && window.DFO.S && window.DFO.S.roles) || [];
    if (rollen.some((r) => KLANT_BEWERKEN_ROLLEN.includes(String(r).toLowerCase()))) return true;
    const R = window.RBAC;
    if (!R || typeof R.canSync !== 'function') return true;
    if (typeof R.permissiesGeladen === 'function' && !R.permissiesGeladen()) return true;
    return R.canSync('customer.edit') === true;
  } catch (_) { return true; }
}
