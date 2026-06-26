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

// Fase 2b — inbox-scoping. Hulp-functies voor het filteren van de
// onboarding-tak van het gedeelde inbox-systeem voor een view_own-mentor.

/**
 * Returnt de unieke set customer_id's waar de gegeven user (typisch een
 * view_own-mentor) als mentor aan gekoppeld is via een onboarding-rij.
 * Wordt door inbox-conversations-list?module=onboarding gebruikt als
 * harde server-side WHERE-clause: customer_id IN (...).
 *
 * Onboardings zonder customer_id worden overgeslagen — die hebben sowieso
 * geen WhatsApp-conversatie en horen niet in de set. is_test=true rijen
 * blijven we hier WEL meenemen (komen niet in de echte inbox, geen lek).
 *
 * Fail-closed: bij elke fout returnt deze functie een lege array. Met een
 * lege array filtert de caller naar 0 hits — strikter is veiliger dan
 * fail-open (geen lijst < verkeerde mentor's lijst).
 *
 * @param {string} userId  auth.users.id
 * @returns {Promise<string[]>}
 */
export async function getMentorCustomerIds(userId) {
  if (!userId || typeof userId !== 'string') return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('onboardings')
      .select('customer_id')
      .eq('mentor_user_id', userId)
      .not('customer_id', 'is', null);
    if (error) {
      console.error('[onboardingScope.getMentorCustomerIds]', error.message);
      return [];
    }
    const set = new Set();
    for (const r of (data || [])) {
      if (r && typeof r.customer_id === 'string') set.add(r.customer_id);
    }
    return Array.from(set);
  } catch (err) {
    console.error('[onboardingScope.getMentorCustomerIds] exception:', err?.message || err);
    return [];
  }
}

/**
 * Per-conversatie ownership-guard. Returnt true als de user als mentor aan
 * minstens één onboarding van customerId gekoppeld is. Wordt door alle
 * per-conv inbox-endpoints (messages-list / context / send / template /
 * mark-read / suggest / etc.) aangeroepen NA de autoritatieve conv→module-
 * resolve, voor conversaties in de onboarding-tak.
 *
 * customerId=null/undefined → false (een conv zonder customer kan een
 * mentor sowieso niet "bezitten" — admin moet 'm eerst koppelen).
 *
 * Fail-closed: bij elke fout returnt false (denied is veiliger dan allow).
 *
 * @param {string} userId
 * @param {string|null} customerId
 * @returns {Promise<boolean>}
 */
export async function mentorOwnsCustomer(userId, customerId) {
  if (!userId || typeof userId !== 'string') return false;
  if (!customerId || typeof customerId !== 'string') return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('onboardings')
      .select('id')
      .eq('mentor_user_id', userId)
      .eq('customer_id', customerId)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[onboardingScope.mentorOwnsCustomer]', error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.error('[onboardingScope.mentorOwnsCustomer] exception:', err?.message || err);
    return false;
  }
}

/**
 * Resolve de inbox-module van een conversatie via z'n phone_number_id.
 * Returnt 'finance' | 'events' | 'onboarding' | null. null bij onbekend
 * pn-id of fout — caller behandelt dat als "niet-onboarding" (skipt de
 * onboarding-specifieke ownership-guard).
 *
 * @param {string|null} phoneNumberId
 * @returns {Promise<string|null>}
 */
export async function resolveConversationModule(phoneNumberId) {
  if (!phoneNumberId || typeof phoneNumberId !== 'string') return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('module')
      .eq('phone_number_id', phoneNumberId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      console.error('[onboardingScope.resolveConversationModule]', error.message);
      return null;
    }
    return (data && typeof data.module === 'string') ? data.module : null;
  } catch (err) {
    console.error('[onboardingScope.resolveConversationModule] exception:', err?.message || err);
    return null;
  }
}

/**
 * Block-helper voor klant-doorzoeken / koppel-endpoints (customer-search /
 * link-conv-to-customer / unlink / attendee-search / link-conv-to-attendee /
 * inbox-conversation-by-customer). Een view_own-only-mentor mag NIET:
 *   - door alle klanten in de admin-customer-zoek heen.
 *   - conversaties zelf aan andere klanten/attendees koppelen of ontkoppelen.
 *   - finance-WABA-conv-id's enumeren voor klant-ids die niet van 'm zijn.
 *
 * Returnt true als de caller geblokkeerd moet worden (mentor-only),
 * anders false (finance/events/admin → bestaand gedrag).
 *
 * @returns {Promise<boolean>}
 */
export async function isMentorOnly(req) {
  const scope = await getOnboardingScope(req);
  return !!(scope.seesOwn && !scope.seesAll);
}

/**
 * Centrale per-conversatie ownership-check voor de onboarding-tak.
 *
 * Gebruik na de bestaande OR-gate + na de conv-fetch:
 *   const acl = await checkOnboardingConvAccess(req, { phoneNumberId, customerId });
 *   if (!acl.ok) return res.status(acl.status).json({ error: acl.error });
 *
 * Logica:
 *   - scope.seesAll (onboarding.admin / super_admin) → ALTIJD ok (bestaand
 *     gedrag, geen extra DB-call voor module-resolve).
 *   - !seesAll:
 *       - resolveConversationModule(phoneNumberId).
 *       - module !== 'onboarding' → ok (conv hoort bij finance/events tak;
 *         daar is de bestaande view/send-gate van het endpoint
 *         autoritatief, scope-check niet relevant).
 *       - module === 'onboarding':
 *           - !seesOwn → 403 (alleen onboarding.view_own-houders mogen
 *             onboarding-convs zien zonder onboarding.admin).
 *           - !mentorOwnsCustomer(userId, customerId) → 403 (mentor mag
 *             alleen z'n eigen studenten).
 *
 * Fail-closed: een view_own-only-user zonder bekende customerId
 * (customerId=null) krijgt 403 op de onboarding-tak. Een unbekende
 * convModule (resolve faalde) wordt als "niet-onboarding" behandeld; het
 * onderliggende endpoint heeft 'm dan via z'n eigen gate moeten blokken.
 *
 * @returns {Promise<{ok:true} | {ok:false, status:number, error:string}>}
 */
export async function checkOnboardingConvAccess(req, { phoneNumberId, customerId }) {
  const scope = await getOnboardingScope(req);
  if (scope.seesAll) return { ok: true };
  const convModule = await resolveConversationModule(phoneNumberId);
  if (convModule !== 'onboarding') return { ok: true };
  if (!scope.seesOwn) {
    return { ok: false, status: 403, error: 'Geen toegang tot onboarding-conversaties (onboarding.view_own vereist)' };
  }
  const owns = await mentorOwnsCustomer(scope.userId, customerId);
  if (!owns) {
    return { ok: false, status: 403, error: 'Geen toegang tot deze onboarding-conversatie' };
  }
  return { ok: true };
}
