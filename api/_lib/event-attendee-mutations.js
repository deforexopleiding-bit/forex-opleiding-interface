// api/_lib/event-attendee-mutations.js
//
// Central shared helper voor de "na-de-write"-cascade op event_attendees.
//
// Doel: elk endpoint dat een BEVESTIGDE attendee kan creëren of promoveren
// (status IN ('aangemeld','aanwezig') AND assessment_response_id IS NOT NULL
// AND is_test=false) roept ÉÉN functie aan i.p.v. de triplet
// getConfirmedCount + syncGastenlijstWebflow + autoCloseIfFull +
// herevalueerCapaciteit los te schrijven. Voorkomt gaten zoals eerder in
// events-attendee-move en events-signup-inbound.
//
// Werkt fail-soft: mag de aanroepende flow NOOIT breken. Log-only op fouten.
//
// Ondersteunt single of multi eventIds — voor de move-flow (source + target)
// waar beide events geraakt worden. NULL/duplicaten worden gefilterd.
//
// Defense-in-depth: naast deze helper flipt de DB-trigger
// trg_event_attendees_auto_close reeds signups_closed=true in de DB. Deze
// helper zorgt voor de outbound-cascade (Webflow unpublish + GHL recompute
// via autoCloseIfFull -> closeSignupsOutbound). Als een caller deze helper
// mist maar de trigger wél firet, vangt cron-events-close-reconcile de
// Webflow-drift op binnen 10 minuten.

import { supabaseAdmin } from '../supabase.js';
import {
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
  herevalueerCapaciteit,
} from './event-registration.js';

/**
 * onConfirmedAttendeeMutation(eventIds, opts)
 *
 * Draait de complete post-write cascade voor 1 of meer events.
 *
 * @param {string|string[]} eventIds - uuid(s) van het/de geraakte event(s).
 *   Voor moves: [sourceEventId, targetEventId]. NULL / undefined / lege
 *   strings worden overgeslagen.
 * @param {object} [opts]
 * @param {string} [opts.reason] - label voor log-lines (bv. 'assessment-submit').
 * @param {boolean} [opts.skipReopen] - default false. Op true slaan we
 *   herevalueerCapaciteit over (alleen close-check). Bruikbaar voor endpoints
 *   die zeker weten dat count omhoog gaat en niet omlaag (bv. new-registrations).
 * @returns {Promise<Array<{event_id:string, ok:boolean, reason?:string}>>}
 *   Per event 1 rij met resultaat. Log-only bij fouten — de resultaten zijn
 *   alleen voor debugging / tests, niet voor caller-branching.
 */
export async function onConfirmedAttendeeMutation(eventIds, opts = {}) {
  const rawList = Array.isArray(eventIds) ? eventIds : [eventIds];
  const ids = [...new Set(
    rawList
      .filter((x) => x != null && String(x).trim() !== '')
      .map((x) => String(x).trim())
  )];
  const reason     = opts?.reason ? String(opts.reason) : 'unspecified';
  const skipReopen = opts?.skipReopen === true;

  const results = [];
  for (const eventId of ids) {
    try {
      const { data: ev, error: evErr } = await supabaseAdmin
        .from('events')
        .select('id, capacity, signups_closed, signups_closed_reason, webflow_item_id, status')
        .eq('id', eventId)
        .maybeSingle();
      if (evErr) {
        console.warn(`[onConfirmedAttendeeMutation:${reason}] ev-fetch ${eventId} (soft):`, evErr.message);
        results.push({ event_id: eventId, ok: false, reason: 'ev-fetch: ' + evErr.message });
        continue;
      }
      if (!ev) {
        results.push({ event_id: eventId, ok: false, reason: 'event not found' });
        continue;
      }

      const cnt = await getConfirmedCount(eventId);

      // Gastenlijst-label sync (Webflow "X/Y"). Idempotent. Fail-soft binnen
      // de helper zelf.
      const gastenlijst = await syncGastenlijstWebflow(ev, cnt);

      // Close-check + outbound cascade. autoCloseIfFull is idempotent (guarded
      // UPDATE + race-check) en veilig om vaker aan te roepen dan strikt nodig.
      // De DB-trigger flipt signups_closed reeds in de DB; deze call zorgt
      // voor Webflow unpublish + GHL recompute die de trigger NIET kan doen.
      const autoClose = await autoCloseIfFull(ev, cnt);

      // Reopen-check (spiegel van close). Slaat over als het event niet
      // auto_full-gesloten is of de deadline verstreken is.
      let reopen = null;
      if (!skipReopen) {
        reopen = await herevalueerCapaciteit(eventId);
      }

      results.push({
        event_id         : eventId,
        ok               : true,
        confirmed_count  : cnt,
        capacity         : ev.capacity,
        gastenlijst_label: gastenlijst?.label || null,
        gastenlijst_sync : gastenlijst?.ok && !gastenlijst?.skipped ? 'updated'
                          : (gastenlijst?.skipped ? 'skipped' : 'failed'),
        auto_closed      : !!autoClose?.auto_closed,
        reopened         : !!reopen?.reopened,
      });
    } catch (e) {
      console.warn(`[onConfirmedAttendeeMutation:${reason}] ev=${eventId} (soft):`, e?.message || e);
      results.push({ event_id: eventId, ok: false, reason: e?.message || 'exception' });
    }
  }
  return results;
}
