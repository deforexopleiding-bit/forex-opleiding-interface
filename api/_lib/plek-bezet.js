// api/_lib/plek-bezet.js
//
// "NEEMT EEN PLEK IN" — DE ENIGE DEFINITIE.
//
// Sinds 15 september 2026 (Maxim): wie in de eventmodule op belstatus
// "Bevestigd" staat, neemt een plek in — ook zonder ingevulde vragenlijst.
// Bevestigd overrult de vragenlijst voor de capaciteit.
//
//   status IN ('aangemeld','aanwezig')
//   AND is_test = false
//   AND ( assessment_response_id IS NOT NULL
//         OR lower(trim(call_status)) = 'bevestigd' )
//
// Enkel de status telt nog steeds: wachtlijst / geannuleerd / no_show /
// switched_to_other_event nemen géén plek in, ook niet met belstatus
// bevestigd. Een testrij (is_test) telt nooit mee.
//
// DIT BESTAND HEEFT MET OPZET GEEN ENKELE IMPORT.
// De regel wordt gelezen door callers die géén databank-client willen laden:
// template-variables.js bouwt bewust geen Supabase-client op module-niveau, en
// event-registration.js hangt wél aan supabaseAdmin + webflow-client. Stond de
// regel daar, dan sleepte elke lezer die hele keten mee (en webflow-client
// importeert event-registration terug — een cyclus die je er niet bij wil).
// event-registration.js her-exporteert alles hieronder, dus bestaande imports
// blijven werken.
//
// SQL-SPIEGEL — houd deze twee gelijk:
//   public.event_attendee_is_confirmed(text, uuid, boolean, text)
//   in docs/sql-migrations/2026-09-15-events-belstatus-bevestigd-telt-mee.sql
// Wijzigt de een, wijzig de ander; anders tellen DB-trigger en Node anders.
// De browser heeft een derde spiegel in modules/klanten-v2/views/events-v2.js.

export const CONFIRMED_STATUSES = ['aangemeld', 'aanwezig'];

/** De belstatus die — zonder vragenlijst — tóch een plek inneemt. */
export const PLEK_BEZET_CALL_STATUS = 'bevestigd';

/** Belstatus is een vrije text-kolom: altijd trimmen + lowercasen vóór vergelijk. */
export function normalizeCallStatus(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

/**
 * isPlekBezet(row) — de regel hierboven, op één attendee-rij.
 *
 * Verwacht de velden status, is_test, assessment_response_id en call_status.
 * Ontbrekende velden lezen als "niet gezet" (undefined is_test = geen testrij,
 * undefined call_status = geen belstatus), zodat een rij uit een select die
 * call_status niet meenam nooit stilletjes 'bezet' wordt op een lege waarde.
 */
export function isPlekBezet(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.is_test === true) return false;
  if (!CONFIRMED_STATUSES.includes(String(row.status ?? ''))) return false;
  if (row.assessment_response_id != null && String(row.assessment_response_id) !== '') return true;
  return normalizeCallStatus(row.call_status) === PLEK_BEZET_CALL_STATUS;
}

/**
 * heeftVragenlijst(row) — letterlijk "de vragenlijst is ingevuld".
 *
 * Bewust apart van isPlekBezet: een paar plekken gaan écht over de vragenlijst
 * (de kolom Vragenlijst, de teller vragenlijst_ingevuld, de tekst van de
 * bevestigingsmail) en mogen NIET meeveranderen met de capaciteitsregel.
 */
export function heeftVragenlijst(row) {
  if (!row || typeof row !== 'object') return false;
  return row.assessment_response_id != null && String(row.assessment_response_id) !== '';
}

/**
 * De OR-tak van de regel als PostgREST-filterstring.
 *
 * `ilike` doet het hoofdlettergedeelte van lower(); trimmen kan PostgREST niet
 * (geen functie-aanroepen in filters). Dat is veilig omdat elk schrijfpad naar
 * call_status trimt + lowercased (events-attendee-update, zetBelstatusBevestigd,
 * follow-up-lead-outcome) en alle waarden in productie lowercase zijn.
 * isPlekBezet trimt wél, zodat een met de hand ingevoerde ' Bevestigd ' in de
 * UI-telling en in de cascade-vergelijking alsnog goed valt.
 */
export const PLEK_BEZET_OR_FILTER =
  `assessment_response_id.not.is.null,call_status.ilike.${PLEK_BEZET_CALL_STATUS}`;

/**
 * applyPlekBezetFilter(query) — zet de volledige regel op een Supabase-query
 * over event_attendees. Caller zet zelf de scope (event_id, in-lijst, …).
 *
 * LET OP — ÉÉN `.or()` PER QUERY.
 * supabase-js doet `searchParams.append('or', ...)`, dus een tweede `.or()` op
 * dezelfde query levert twee `or=`-parameters op. Reken daar niet op: wie hier
 * nog een disjunctie bij nodig heeft, bouwt ÉÉN string met PostgREST-nesting
 * (`.or('and(a,b),and(c,d)')`) in plaats van twee `.or()`-aanroepen. Deze
 * helper voegt er precies één toe — tests/events-plek-bezet.test.js bewaakt dat.
 */
export function applyPlekBezetFilter(query) {
  return query
    // Automation-tester: test-attendees nooit meetellen voor capaciteit.
    .eq('is_test', false)
    .in('status', CONFIRMED_STATUSES)
    .or(PLEK_BEZET_OR_FILTER);
}
