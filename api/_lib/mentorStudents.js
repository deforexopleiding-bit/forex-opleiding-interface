// api/_lib/mentorStudents.js
//
// Gedeelde mentor → Bubble-studenten resolutie. Eén bron van waarheid voor
// elk endpoint dat "wie zijn de studenten van deze mentor?" moet beantwoorden:
//
//   - api/mentor-my-students.js                 → de student-lijst zelf
//   - api/mentor-students-invoice-status.js     → overdue-badge counts
//   - (toekomstige mentor-* readers)
//
// Voor de fix: de overdue-badge in PR #445 gebruikte een ANDER scope-pad
// (onboardings.mentor_user_id via getMentorCustomerIds) dan mentor-my-students
// (team_members.bubble_user_id → Bubble user.mentor_user). Studenten die wel
// in de mentor-lijst zaten maar niet in een onboarding-rij met die mentor
// kregen geen badge ondanks te late facturen.
//
// Deze helper centraliseert de 2 stappen — team_members lookup + Bubble-fetch
// met de constraints — zodat callers niet meer uit elkaar kunnen lopen.

import { supabaseAdmin } from '../supabase.js';
import { bubbleList, bubbleUserDisplay } from './bubble.js';

/**
 * Resolve de effectieve mentor.bubble_user_id voor een gegeven auth.users.id.
 * Returnt null als de team_members-rij ontbreekt, niet actief is, of geen
 * bubble_user_id heeft — caller behandelt dat als "linked:false".
 *
 * Gooit Error op DB-fout zodat de caller er met try/catch op kan reageren.
 *
 * @param {string} effectiveUserId  auth.users.id (self of admin-scoped)
 * @returns {Promise<string|null>}
 */
export async function getMentorBubbleId(effectiveUserId) {
  if (!effectiveUserId || typeof effectiveUserId !== 'string') return null;
  const { data: tm, error } = await supabaseAdmin
    .from('team_members')
    .select('id, bubble_user_id, is_active')
    .eq('user_id', effectiveUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error('team_members lookup: ' + error.message);
  return tm?.bubble_user_id || null;
}

/**
 * Fetcht alle Bubble 'user'-rijen waar mentor_user = bubbleUserId én role
 * = 'student'. Gebruikt EXACT dezelfde constraints + limit als de
 * historische resolutie in mentor-my-students; deze functie IS die
 * resolutie nu (single source of truth).
 *
 * Returnt een array van raw Bubble-rijen. Caller is verantwoordelijk voor
 * de mapping naar de eigen API-shape (mentor-my-students vertaalt naar
 * de rijke student-shape; invoice-status extractet alleen de e-mails).
 *
 * Gooit eventuele Bubble-fouten door (BUBBLE_CONFIG_MISSING /
 * BUBBLE_NETWORK / BUBBLE_HTTP_*) — caller mapt die naar 502/503 zoals
 * mentor-my-students al doet.
 *
 * @param {string|null} bubbleUserId
 * @returns {Promise<Array<object>>}
 */
export async function fetchBubbleStudents(bubbleUserId) {
  if (!bubbleUserId || typeof bubbleUserId !== 'string') return [];
  const constraints = [
    { key: 'mentor_user',              constraint_type: 'equals', value: bubbleUserId },
    { key: 'role_option_os___roles',   constraint_type: 'equals', value: 'student' },
  ];
  const { results } = await bubbleList('user', constraints, { limit: 500 });
  return Array.isArray(results) ? results : [];
}

/**
 * Combineert getMentorBubbleId + fetchBubbleStudents en extracteert de
 * student-e-mails (lowercased + getrimd) — bedoeld voor readers die
 * alléén op email hoeven te matchen (zoals de overdue-badge counts).
 *
 * @param {string} effectiveUserId  auth.users.id
 * @returns {Promise<{ linked: boolean, emails: string[] }>}
 *   linked=false → mentor heeft geen bubble_user_id (team_members-koppeling
 *                  ontbreekt of niet actief).
 *   emails       → gededupliceerde, lowercased, getrimde e-mails uit Bubble.
 */
export async function getMentorStudentEmails(effectiveUserId) {
  const bubbleUserId = await getMentorBubbleId(effectiveUserId);
  if (!bubbleUserId) return { linked: false, emails: [] };
  const results = await fetchBubbleStudents(bubbleUserId);
  const set = new Set();
  for (const u of results) {
    // bubbleUserDisplay (in bubble.js) is de single source of truth voor
    // email-extractie. Behandelt de geneste 'authentication.email.email'-vorm
    // én custom-velden, en lowercased het resultaat al. Door dezelfde helper
    // hier te gebruiken matchen we 1-op-1 wat mentor-my-students's render-
    // mapping als e-mail teruggeeft.
    const { email } = bubbleUserDisplay(u);
    const e = email ? String(email).trim().toLowerCase() : '';
    if (e) set.add(e);
  }
  return { linked: true, emails: Array.from(set) };
}
