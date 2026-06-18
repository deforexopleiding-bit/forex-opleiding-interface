// api/_lib/event-registration.js
// Shared helpers voor de assessment -> event-registratie flow (Blok 2 PR 3).
//
// 4 pure verantwoordelijkheden:
//   1. niveau-matrix: routing_result -> toegestaan event-niveau
//   2. getConfirmedCount(eventId)
//   3. syncGastenlijstWebflow(event, confirmedCount)
//   4. autoCloseIfFull(event, confirmedCount)
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
import { closeSignupsOutbound } from './event-sync-orchestrator.js';

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

// ── Confirmed-count ─────────────────────────────────────────────────────────
//
// "Bevestigd / actief" = deelnemer met (a) status IN ('aangemeld','aanwezig')
// ÉN (b) een gekoppelde, voltooide Blok-2-assessment (assessment_response_id
// IS NOT NULL). Aanmeldingen zonder assessment blijven 'aangemeld' maar
// tellen NIET mee voor capaciteit — zij gaan pas meetellen zodra hun
// assessment alsnog gekoppeld wordt (Fase 2 / signup-first pad).
//
// Single source of truth: autoCloseIfFull, syncGastenlijstWebflow's label,
// assessment-open-events.has_space én events-list/events-detail's
// 'active'-teller volgen allemaal deze regel. Bestaande status-enum-labels
// blijven onaangetast; de assessment-filter is een EXTRA "telt-mee"-laag
// bovenop de status.
//
// Returnt 0 bij DB-fout (soft-fail) zodat de registratie-flow niet
// blokkeert; error wordt geloggd voor follow-up. Auto-vol blijft dan
// stil staan, maar dat is veiliger dan onterecht sluiten.

export const CONFIRMED_STATUSES = ['aangemeld', 'aanwezig'];

export async function getConfirmedCount(eventId) {
  if (!eventId) return 0;
  const { count, error } = await supabaseAdmin
    .from('event_attendees')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    // Automation-tester: test-attendees nooit meetellen voor capaciteit.
    .eq('is_test', false)
    .in('status', CONFIRMED_STATUSES)
    .not('assessment_response_id', 'is', null);
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
// aan getConfirmedCount: status IN ('aangemeld','aanwezig') AND
// assessment_response_id IS NOT NULL (Fase 1).
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

  // 2) Confirmed counts per event in 1 round-trip — Fase 1 semantiek
  // (status IN CONFIRMED_STATUSES AND assessment_response_id IS NOT NULL).
  const eventIds = events.map((e) => e.id);
  const { data: countRows, error: cntErr } = await supabaseAdmin
    .from('event_attendees')
    .select('event_id')
    .in('event_id', eventIds)
    .in('status', CONFIRMED_STATUSES)
    .not('assessment_response_id', 'is', null);
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
