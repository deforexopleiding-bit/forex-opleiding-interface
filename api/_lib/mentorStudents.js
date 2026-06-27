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

/**
 * Fetcht ALLE Bubble 'user'-rijen met role=student ORG-BREED (zonder
 * mentor_user-constraint). Voor admin-readers (overzicht over alle
 * mentoren). bubbleList paginiert intern via z'n cursor-loop; we
 * vragen de maximale cap (2000) op zodat we 1 round-trip-equivalent
 * krijgen voor het hele studentenbestand.
 *
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllBubbleStudents() {
  const constraints = [
    { key: 'role_option_os___roles', constraint_type: 'equals', value: 'student' },
  ];
  const { results } = await bubbleList('user', constraints, { limit: 2000 });
  return Array.isArray(results) ? results : [];
}

// ── Bubble row → API-shape ────────────────────────────────────────────────
// Lift uit mentor-my-students. Defensieve readers voor Bubble's suffix-
// conventie (key_text / key_number / key_option_os___name) met bare-name
// als fallback voor pre-conventie data.

function _readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) if (u[k] !== undefined) return u[k];
  return undefined;
}
function _pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
}
function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Mapt één raw Bubble user-rij naar de student-shape die zowel
 * mentor-my-students als students-overview gebruiken.
 *
 * Naast de bestaande velden returnt deze ook `mentor_bubble_user_id`
 * (uit `mentor_user`) zodat de overview-endpoint per-student de mentor
 * kan resolven. Single source of truth voor "wat is een student-row".
 *
 * @returns { bubble_student_id, name, email, program, membership,
 *            onboarding_status, calls_1on1_done, calls_1on1_total,
 *            group_done, group_total, no_shows, mentor_bubble_user_id }
 */
export function mapBubbleStudentRow(u) {
  const { name, email } = bubbleUserDisplay(u);
  const program          = _pickOption(_readFirst(u, ['learning_type_option_os___learning_type', 'learning type']));
  const onboardingStatus = _pickOption(_readFirst(u, ['onboarding_status_option_os___onboarding_status', 'Onboarding Status']));
  const membership       = _pickOption(_readFirst(u, ['membership_option_os___membership', 'membership']));
  const callsDone   = _num(_readFirst(u, ['1_call_completed_number',   '1_call_completed']));
  const callsTotal  = _num(_readFirst(u, ['1_call_alpha_total_number', '1_call_total_number', '1_call_delta_total_number', '1_call_alpha_total']));
  const groupDone   = _num(_readFirst(u, ['group_call_completed_number', 'group_call_completed']));
  const groupTotal  = _num(_readFirst(u, ['group_call_total_number',     'group_call_total']));
  const noShows     = _num(_readFirst(u, ['no_show_count_number',       'no show count']));
  // mentor_user is in Bubble een User-link; we lezen de bare-name primary
  // met defensieve fallback op de suffix-vorm. Null als de student geen
  // mentor heeft.
  const mentorBubbleId = (() => {
    const raw = _readFirst(u, ['mentor_user', 'mentor_user_user']);
    if (raw == null) return null;
    if (typeof raw === 'string') return raw.trim() || null;
    if (typeof raw === 'object' && raw._id) return String(raw._id) || null;
    return null;
  })();
  return {
    bubble_student_id     : String(u?._id || ''),
    name,
    email,
    program,
    membership,
    onboarding_status     : onboardingStatus,
    calls_1on1_done       : callsDone,
    calls_1on1_total      : callsTotal,
    group_done            : groupDone,
    group_total           : groupTotal,
    no_shows              : noShows,
    mentor_bubble_user_id : mentorBubbleId,
  };
}
