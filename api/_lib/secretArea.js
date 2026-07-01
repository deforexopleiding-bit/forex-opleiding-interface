// api/_lib/secretArea.js
//
// requireOwner(req) — server-side owner-gate voor ALLE Secret Area endpoints.
// Zelfde patroon als api/secret-area.js (createUserClient → auth.getUser →
// vergelijk met SECRET_AREA_USER_ID env). Fail-closed:
//   - ontbrekende env → null
//   - geen sessie / verkeerde user → null
//   - eigenaar → { userId }
//
// Elke Secret Area handler start met `const ctx = await requireOwner(req);
// if (!ctx) return res.status(403).json({ error: 'Geen toegang' });`.
//
// PIN wordt hier NIET herhaald: de PIN-gate (api/secret-area.js POST)
// unlocked de UI voor deze sessie in-memory. Alle data-endpoints vertrouwen
// dat vervolgens op de user-JWT (owner-check), en PIN blijft nergens buiten
// de check-endpoint bekend.

import { createUserClient } from '../supabase.js';

/**
 * @returns {Promise<{ userId: string } | null>}
 */
export async function requireOwner(req) {
  const ownerId = process.env.SECRET_AREA_USER_ID || '';
  if (!ownerId) return null;
  try {
    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !user.id) return null;
    if (String(user.id) !== String(ownerId)) return null;
    return { userId: String(user.id) };
  } catch (_) {
    return null;
  }
}
