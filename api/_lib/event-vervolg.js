// api/_lib/event-vervolg.js
//
// STAP 2 — gedeelde helpers voor de INFO-ONLY vervolgvragenlijst.
//
// OUDE-FLOW-VEILIG: dit raakt de assessment-submit/-scoring/-questions NIET en
// verandert de ACTIEVE (gescoorde) questionnaire niet. We targeten expliciet
// de aparte info-only questionnaire met slug 'event-vervolg'
// (assessment_questionnaires.is_active = false, info_only = true).

import { supabaseAdmin } from '../supabase.js';

export const VERVOLG_SLUG = 'event-vervolg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

/** De info-only vervolg-questionnaire (op slug). null als 'ie (nog) niet bestaat. */
export async function getVervolgQuestionnaire() {
  const { data, error } = await supabaseAdmin
    .from('assessment_questionnaires')
    .select('id, slug, name, info_only')
    .eq('slug', VERVOLG_SLUG)
    .maybeSingle();
  if (error) throw new Error('getVervolgQuestionnaire: ' + error.message);
  return data || null;
}

/** Attendee op choice_token (de gate-aanmelder). */
export async function getAttendeeByToken(token) {
  if (!isUuid(token)) return null;
  const { data, error } = await supabaseAdmin
    .from('event_attendees')
    .select('id, event_id, first_name, last_name, email, phone, status, customer_id, source, choice_token, assessment_response_id, created_via')
    .eq('choice_token', token)
    .maybeSingle();
  if (error) throw new Error('getAttendeeByToken: ' + error.message);
  return data || null;
}

/** Eén event met de velden die de finalisatie/weergave nodig heeft. */
export async function getEvent(eventId) {
  if (!isUuid(eventId)) return null;
  const { data, error } = await supabaseAdmin
    .from('events')
    .select('id, title, starts_at, ends_at, location, niveau, capacity, status, signups_closed')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error('getEvent: ' + error.message);
  return data || null;
}
