// api/_lib/onboardingScope.js
// Scope-helper voor de Onboarding-endpoints. Bepaalt op basis van de
// ingelogde user welke onboarding-rijen die mag zien:
//   - seesAll  : onboarding.admin (huidig admin/manager-gedrag; super_admin
//                via bypass in user_has_permission()). Geen scope-restrictie.
//   - seesOwn  : onboarding.view_own (Fase 2a — mentor mag alleen rijen waar
//                onboardings.mentor_user_id === userId). Wordt door de
//                endpoint vertaald naar een hard server-side filter +
//                ownership-guard.
//   - geen van beide → 403 op de endpoints die deze helper gebruiken.
//
// userId == auth.users.id (via supabase.auth.getUser(token)). Bevestigd
// door de FK-chain: onboardings.mentor_user_id matched team_members.user_id
// die op zijn beurt REFERENCES auth.users.id (zie migraties 002 / F5).
// Vergelijken met userId is dus direct sluitend zonder lookup.
//
// Fail-closed: geen/ongeldige Bearer-token → userId=null, seesAll=false,
// seesOwn=false. De caller checkt de combinatie en stuurt 403 als beide
// false zijn.

import { supabase, supabaseAdmin } from '../supabase.js';

/**
 * @returns {Promise<{ userId: string|null, seesAll: boolean, seesOwn: boolean }>}
 *
 * Implementatie-noot: we doen 2 RPC-calls (1× per feature_key) in plaats van
 * 1 batch — user_has_permission() heeft geen batch-variant. Beide RPCs
 * faal-veilig: bij RPC-fout returnen we false (geen permission), nooit
 * een uitzondering die de caller meeneemt naar 500.
 */
export async function getOnboardingScope(req) {
  const empty = { userId: null, seesAll: false, seesOwn: false };
  try {
    const authHeader = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return empty;
    const token = authHeader.slice(7);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return empty;

    const out = { userId: user.id, seesAll: false, seesOwn: false };

    try {
      const { data, error } = await supabaseAdmin.rpc('user_has_permission', {
        user_uuid: user.id,
        fkey:      'onboarding.admin',
      });
      if (error) { console.error('[onboardingScope] admin RPC:', error.message); }
      else       { out.seesAll = data === true; }
    } catch (e) { console.error('[onboardingScope] admin RPC exception:', e?.message || e); }

    // Als seesAll al true is hoeven we view_own niet meer te checken — de
    // rij-set is altijd al de unie. We checken 'm toch zodat decision-logs
    // duidelijk laten zien welke keys de user expliciet had.
    try {
      const { data, error } = await supabaseAdmin.rpc('user_has_permission', {
        user_uuid: user.id,
        fkey:      'onboarding.view_own',
      });
      if (error) { console.error('[onboardingScope] view_own RPC:', error.message); }
      else       { out.seesOwn = data === true; }
    } catch (e) { console.error('[onboardingScope] view_own RPC exception:', e?.message || e); }

    return out;
  } catch (err) {
    console.error('[onboardingScope] fout:', err?.message || err);
    return empty;
  }
}
