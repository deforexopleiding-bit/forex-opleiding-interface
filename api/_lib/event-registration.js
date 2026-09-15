// api/_lib/event-registration.js
// Shared helpers voor de assessment -> event-registratie flow (Blok 2 PR 3).
//
// 4 pure verantwoordelijkheden:
//   1. niveau-matrix: routing_result -> toegestaan event-niveau
//   1b. isPlekBezet(row) / applyPlekBezetFilter(query) — de "neemt een plek
//       in"-regel, als pure JS-check en als Supabase-filter
//   2. getConfirmedCount(eventId)
//   3. syncGastenlijstWebflow(event, confirmedCount)
//   4. autoCloseIfFull(event, confirmedCount)
//   5. herevalueerCapaciteit(eventId)  — auto-reopen (spiegel van 4)
//
// Hergebruikt:
//   - api/_lib/webflow-client.js (updateLiveFields helper)
//   - api/_lib/event-sync-orchestrator.js (closeSignupsOutbound voor de
//     Blok-1 close-cascade: Webflow unpublish + GHL recompute).
//
// Het inserten van de event_attendees-rij doet de caller zelf (transactie-
// scope blijft in api/assessment-register.js); dit lib is voor de cascade
// die DAARNA komt.

import { supabaseAdmin } from '../supabase.js';
import { updateLiveFields } from './webflow-client.js';
import { closeSignupsOutbound, reopenSignupsOutbound } from './event-sync-orchestrator.js';
import { computeReopenDeadlineUtc } from './reopen-deadline.js';

// ── Niveau-matrix ────────────────────────────────────────────────────────────
//
// Routing-resultaat uit Blok 2 PR 2 mapt 1-op-1 op het event-niveau dat een
// deelnemer mag kiezen:
//   gevorderd -> alleen gevorderd-events
//   basis     -> alleen basis-events
//   incomplete-> NIET registreren (UI biedt deze keuze ook niet aan)
//
// Apart object zodat we het in 1 plek kunnen aanpassen als er ooit een
// tussenniveau bijkomt.
export const NIVEAU_FROM_ROUTING = {
  gevorderd: 'gevorderd',
  basis    : 'basis',
};

/**
 * isNiveauMatch(routing_result, eventNiveau)
 * Returnt true als routing_result toestaat in te schrijven op een event
 * van eventNiveau. Onbekende of incomplete routing_result -> false.
 */
export function isNiveauMatch(routingResult, eventNiveau) {
  const allowed = NIVEAU_FROM_ROUTING[routingResult];
  if (!allowed) return false;
  return allowed === eventNiveau;
}

// ── "Neemt een plek in" — de enige definitie ────────────────────────────────
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
// SQL-SPIEGEL — houd deze twee gelijk:
//   public.event_attendee_is_confirmed(text, uuid, boolean, text)
//   in docs/sql-migrations/2026-09-15-events-belstatus-bevestigd-telt-mee.sql
// Wijzigt de een, wijzig de ander; anders tellen DB-trigger en Node anders.
//
// Single source of truth: autoCloseIfFull, syncGastenlijstWebflow's label,
// assessment-open-events.has_space, events-list/events-detail's
// 'active'-teller en de bezetting in de UI volgen allemaal deze regel.

export const CONFIRMED_STATUSES = ['aangemeld', 'aanwezig'];

/** De belstatus die — zonder vragenlijst — tóch een plek inneemt. */
export const PLEK_BEZET_CALL_STATUS = 'bevestigd';

/** Belstatus is een vrije text-kolom: altijd trimmen + lowercasen vóór vergelijk. */
export function normalizeCallStatus(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

/**
 * isPlekBezet(row) — JS-spiegel van de regel hierboven, op één attendee-rij.
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

// ── Confirmed-count ─────────────────────────────────────────────────────────
//
// Returnt 0 bij DB-fout (soft-fail) zodat de registratie-flow niet
// blokkeert; error wordt geloggd voor follow-up. Auto-vol blijft dan
// stil staan, maar dat is veiliger dan onterecht sluiten.

export async function getConfirmedCount(eventId) {
  if (!eventId) return 0;
  const { count, error } = await applyPlekBezetFilter(
    supabaseAdmin
      .from('event_attendees')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
  );
  if (error) {
    console.error('[event-registration] getConfirmedCount error:', error.message);
    return 0;
  }
  return Number.isFinite(count) ? count : 0;
}

// ── Open events met has_space (publieke event-keuze) ────────────────────────
//
// Gedeeld door /api/assessment-open-events (na voltooide assessment) én
// /api/event-choice-get (publieke choice-link). Single source of truth voor
// "welke events kan een deelnemer kiezen?" — capaciteits-regel is identiek
// aan getConfirmedCount / isPlekBezet: status IN ('aangemeld','aanwezig') AND
// is_test = false AND (vragenlijst ingevuld OF belstatus bevestigd).
//
// Params:
//   niveau  — string 'basis' | 'gevorderd' (filter) of null / undefined
//             (geen niveau-filter → alle open events teruggeven).
//   limit   — int (default 50, clamp 1..200).
//
// Returnt (op success):
//   Array<{ id, title, starts_at, ends_at, capacity, location, niveau,
//           confirmed_count, has_space }>
// Bij DB-fout: throws Error (caller bepaalt response-shape).

const OPEN_EVENTS_DEFAULT_LIMIT = 50;
const OPEN_EVENTS_MAX_LIMIT     = 200;

export async function getOpenEventsWithSpace({ niveau = null, limit = OPEN_EVENTS_DEFAULT_LIMIT } = {}) {
  const lim = Math.max(1, Math.min(OPEN_EVENTS_MAX_LIMIT, Number.isFinite(Number(limit)) ? Number(limit) : OPEN_EVENTS_DEFAULT_LIMIT));
  const nowIso = new Date().toISOString();

  // 1) Open events filter
  let q = supabaseAdmin
    .from('events')
    .select('id, title, starts_at, ends_at, capacity, location, niveau, image_url')
    .eq('status', 'published')
    .eq('signups_closed', false)
    .gt('starts_at', nowIso)
    .order('starts_at', { ascending: true })
    .limit(lim);
  if (niveau) q = q.eq('niveau', niveau);

  const { data: events, error: evErr } = await q;
  if (evErr) throw new Error('open events select: ' + evErr.message);
  if (!events || events.length === 0) return [];

  // 2) Bezette plekken per event in 1 round-trip — exact gelijk aan
  // getConfirmedCount via applyPlekBezetFilter: is_test = false AND status IN
  // CONFIRMED_STATUSES AND (vragenlijst ingevuld OF belstatus bevestigd).
  // Zonder de is_test-filter telde de kiezer test-attendees mee en toonde
  // 'Vol' terwijl de strikte telling (badge + website_events) nog plek had.
  const eventIds = events.map((e) => e.id);
  const { data: countRows, error: cntErr } = await applyPlekBezetFilter(
    supabaseAdmin
      .from('event_attendees')
      .select('event_id')
      .in('event_id', eventIds)
  );
  if (cntErr) {
    // Soft-fail: log + return events met confirmed_count=0 zodat de caller
    // bruikbare output krijgt. Auto-vol mist signaal maar dat heeft het
    // registratie-endpoint server-side z'n eigen guard.
    console.error('[event-registration] getOpenEventsWithSpace count error:', cntErr.message);
  }
  const countsByEvent = {};
  for (const r of (countRows || [])) {
    countsByEvent[r.event_id] = (countsByEvent[r.event_id] || 0) + 1;
  }

  // 2b) Niveau-fallback foto's voor events zonder eigen image_url (optie B).
  const nivDefaults = {};
  const niveausNeedingDefault = [...new Set(
    events.filter((e) => !e.image_url && e.niveau).map((e) => e.niveau)
  )];
  if (niveausNeedingDefault.length > 0) {
    const { data: nivRows, error: nivErr } = await supabaseAdmin
      .from('event_niveau_options')
      .select('slug, default_image_url')
      .in('slug', niveausNeedingDefault);
    if (nivErr) {
      console.error('[event-registration] niveau default_image_url error:', nivErr.message);
    } else {
      for (const r of (nivRows || [])) nivDefaults[r.slug] = r.default_image_url || null;
    }
  }

  return events.map((e) => {
    const cnt = countsByEvent[e.id] || 0;
    const cap = Number.isInteger(Number(e.capacity)) ? Number(e.capacity) : null;
    return {
      id              : e.id,
      title           : e.title,
      starts_at       : e.starts_at,
      ends_at         : e.ends_at,
      capacity        : cap,
      location        : e.location,
      niveau          : e.niveau || null,
      image_url       : e.image_url || nivDefaults[e.niveau] || null,
      confirmed_count : cnt,
      has_space       : cap == null ? true : cnt < cap,
      spots_left      : cap == null ? null : Math.max(0, cap - cnt),
    };
  });
}

/**
 * Formatteert het Gastenlijst-label:
 *   - capacity gevuld -> "<bevestigd> / <capacity>"
 *   - capacity NULL   -> "<bevestigd>"
 */
export function formatGastenlijstLabel(confirmedCount, capacity) {
  const cnt = Number.isFinite(confirmedCount) ? confirmedCount : 0;
  if (capacity == null || !Number.isInteger(Number(capacity))) {
    return String(cnt);
  }
  return `${cnt}/${Number(capacity)}`;
}

// ── Webflow Gastenlijst-sync ────────────────────────────────────────────────
//
// Idempotent: PATCH /items/{id}/live met alleen het Gastenlijst-veld.
// Werkt op het LIVE record (event is published, dus item bestaat live).
// Bij ontbrekend webflow_item_id, ontbrekende slug, of Webflow-fout:
// log + return graceful skip-object (registratie-flow gaat door).
export async function syncGastenlijstWebflow(event, confirmedCount) {
  if (!event?.webflow_item_id) {
    return { ok: true, skipped: true, reason: 'no webflow_item_id' };
  }
  const label = formatGastenlijstLabel(confirmedCount, event.capacity);
  try {
    const result = await updateLiveFields({
      webflowItemId: event.webflow_item_id,
      fieldData    : { gastenlijst: label },
    });
    if (result?.skipped) {
      console.warn(
        `[event-registration] gastenlijst skip voor ${event.id}: ${result.reason}`
      );
      return { ok: true, skipped: true, reason: result.reason, label };
    }
    return { ok: true, label, raw: result.raw };
  } catch (e) {
    console.error(
      `[event-registration] syncGastenlijstWebflow failed event=${event.id}: ${e?.message || e}`
    );
    return { ok: false, error: e?.message || String(e), label };
  }
}

// ── Auto-vol close ──────────────────────────────────────────────────────────
//
// Idempotent flow:
//   1. Race-guard: UPDATE events SET signups_closed=true ... WHERE id=$1
//      AND signups_closed=false AND capacity IS NOT NULL.
//      Geen rij terug = al gesloten door iemand anders. Skip.
//   2. closeSignupsOutbound: Webflow unpublish + GHL recompute (Blok 1).
//
// Wordt alleen aangeroepen door de caller als capacity gezet is en
// confirmedCount >= capacity.

export async function autoCloseIfFull(event, confirmedCount) {
  if (!event?.id) return { ok: false, skipped: true, reason: 'no event id' };
  if (event.capacity == null) return { ok: true, skipped: true, reason: 'capacity is NULL' };
  const cap = Number(event.capacity);
  if (!Number.isInteger(cap)) return { ok: true, skipped: true, reason: 'capacity not integer' };
  if (!(confirmedCount >= cap)) {
    return { ok: true, skipped: true, reason: 'not full', confirmedCount, capacity: cap };
  }
  if (event.signups_closed === true) {
    return { ok: true, skipped: true, reason: 'already closed' };
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('events')
    .update({
      signups_closed           : true,
      signups_closed_at        : new Date().toISOString(),
      signups_closed_reason    : 'auto_full',
      signups_closed_by_user_id: null,
    })
    .eq('id', event.id)
    .eq('signups_closed', false)
    .select('id')
    .maybeSingle();
  if (updErr) {
    console.error('[event-registration] autoCloseIfFull db_update:', updErr.message);
    return { ok: false, error: updErr.message };
  }
  if (!updated) {
    // Race: andere registratie heeft 'm net dichtgezet.
    return { ok: true, skipped: true, reason: 'race lost - other run closed first' };
  }

  // Outbound sync (Webflow unpublish + GHL recompute). Fail = log + continue,
  // DB-state is al consistent. Retry-cron pakt 'm via event_sync_log.
  let sync = null;
  try {
    sync = await closeSignupsOutbound(event.id);
  } catch (syncErr) {
    console.error('[event-registration] autoCloseIfFull sync:', syncErr?.message || syncErr);
    sync = { error: syncErr?.message || 'sync exception' };
  }

  return {
    ok        : true,
    auto_closed: true,
    reason    : 'auto_full',
    confirmedCount,
    capacity  : cap,
    sync,
  };
}

// ── Auto-reopen ───────────────────────────────────────────────────────────────
//
// Spiegelbeeld van autoCloseIfFull. Aan te roepen wanneer de bevestigde telling
// van een event kan zijn gezakt (switch-away, annulering / status-uit). Heropent
// inschrijvingen ALLEEN wanneer aan ALLE voorwaarden is voldaan:
//   - signups_closed = true
//   - signups_closed_reason = 'auto_full'  (NOOIT 'manual'/'auto_time' — dat is
//     een bewuste admin- of deadline-sluiting die dicht moet blijven)
//   - status = 'published' (niet archived/draft/cancelled)
//   - reopen-deadline nog niet verstreken (middernacht Europe/Amsterdam op de
//     dag vóór het event) — exact dezelfde guard als het handmatige endpoint,
//     via de gedeelde computeReopenDeadlineUtc
//   - getConfirmedCount(eventId) < capacity  (er is echt weer plek)
//
// Idempotent + fail-soft: mag de aanroepende flow nooit breken. Race-safe via
// .eq('signups_closed', true).eq('signups_closed_reason', 'auto_full') zodat een
// gelijktijdige (her)sluiting/heropening niet dubbel flipt.
export async function herevalueerCapaciteit(eventId) {
  if (!eventId) return { ok: false, skipped: true, reason: 'no event id' };

  const { data: ev, error: fetchErr } = await supabaseAdmin
    .from('events')
    .select('id, capacity, status, signups_closed, signups_closed_reason, starts_at')
    .eq('id', eventId)
    .maybeSingle();
  if (fetchErr) {
    console.error('[event-registration] herevalueerCapaciteit fetch:', fetchErr.message);
    return { ok: false, error: fetchErr.message };
  }
  if (!ev) return { ok: false, skipped: true, reason: 'event not found' };

  // Alleen auto_full-sluitingen heropenen — manual/auto_time blijven dicht.
  if (ev.signups_closed !== true) {
    return { ok: true, skipped: true, reason: 'not closed' };
  }
  if (ev.signups_closed_reason !== 'auto_full') {
    return { ok: true, skipped: true, reason: `closed reason=${ev.signups_closed_reason || 'n/a'} (geen auto_full)` };
  }
  if (ev.status !== 'published') {
    return { ok: true, skipped: true, reason: `status=${ev.status} (niet published)` };
  }

  const cap = Number(ev.capacity);
  if (!Number.isInteger(cap)) {
    return { ok: true, skipped: true, reason: 'capacity not integer' };
  }

  // Deadline-parity met het handmatige reopen-endpoint.
  const deadlineUtc = computeReopenDeadlineUtc(ev.starts_at);
  if (!deadlineUtc) {
    return { ok: true, skipped: true, reason: 'geen geldige starts_at' };
  }
  if (new Date() >= deadlineUtc) {
    return { ok: true, skipped: true, reason: 'reopen-deadline verstreken' };
  }

  // Er moet echt weer plek zijn.
  const confirmedCount = await getConfirmedCount(eventId);
  if (!(confirmedCount < cap)) {
    return { ok: true, skipped: true, reason: 'nog vol', confirmedCount, capacity: cap };
  }

  // DB-flip, race-safe: alleen als hij NU nog auto_full-gesloten is. Velden
  // nullen zoals het handmatige endpoint, zodat een latere close verse audit-
  // data krijgt.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('events')
    .update({
      signups_closed           : false,
      signups_closed_at        : null,
      signups_closed_reason    : null,
      signups_closed_by_user_id: null,
    })
    .eq('id', eventId)
    .eq('signups_closed', true)
    .eq('signups_closed_reason', 'auto_full')
    .select('id')
    .maybeSingle();
  if (updErr) {
    console.error('[event-registration] herevalueerCapaciteit db_update:', updErr.message);
    return { ok: false, error: updErr.message };
  }
  if (!updated) {
    // Race: iemand anders heeft 'm net heropend of (her)gesloten.
    return { ok: true, skipped: true, reason: 'race lost - other run changed state' };
  }

  // Outbound sync (Webflow republish + GHL recompute). Fail = log + door;
  // DB-state is al consistent, retry-cron pakt 'm via event_sync_log.
  let sync = null;
  try {
    sync = await reopenSignupsOutbound(eventId);
  } catch (syncErr) {
    console.error('[event-registration] herevalueerCapaciteit sync:', syncErr?.message || syncErr);
    sync = { error: syncErr?.message || 'sync exception' };
  }

  return { ok: true, reopened: true, confirmedCount, capacity: cap, sync };
}
