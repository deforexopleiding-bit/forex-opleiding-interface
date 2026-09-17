// api/_lib/event-signup-processor.js
//
// Gedeelde core-flow voor het aanmaken van een event_attendees-rij vanuit een
// externe aanmelding. Was eerder inline in api/events-signup-inbound.js;
// geëxtraheerd zodat de backfill (admin-events-backfill-8-14-sept) exact
// dezelfde code kan draaien i.p.v. een parallel spoor.
//
// Bevat:
//   - findExistingAttendee({ eventId, email, phone }) — email-eerst dedup,
//     phone als fallback (geen UNIQUE in DB).
//   - createAttendee({ event, payload, status, followUpReason, ghlContactId,
//                       ghlFormSubmissionId, createdVia, source }) — insert
//     met race-recovery bij 23505 op (event_id, lower(email)).
//   - processSignup({ event, isAmbiguous, matches, payload, ghlContactId,
//                     ghlFormSubmissionId, createdVia, source }) — de VOLLE
//     post-resolve-flow: capaciteitscheck → dedup → insert → seat-fill
//     cascade (getConfirmedCount / syncGastenlijstWebflow / autoCloseIfFull).
//     Return-shape identiek aan wat de inbound-webhook eerder inline gaf.
//
// De automation-motor (cron-events-automations) pikt nieuwe rijen automatisch
// op zolang `automation_enabled` (DB-default = true) op de rij staat. Deze
// helper zet die kolom NIET expliciet; blijft dus true — bevestiging +
// reminders worden binnen ~1 min via de bestaande automations getriggerd.

import { supabaseAdmin } from '../supabase.js';
import { normaliseerStrict } from './phone-e164.js';

// ── TELEFOON BIJ EEN INSCHRIJVING ────────────────────────────────────────
// Hier zit GEEN mens die het nummer kan corrigeren: dit is het formulierpad.
// Een 400 teruggeven zou de inschrijving weigeren, en een verloren lead is
// erger dan een nummer dat later opgeschoond moet worden.
//
// Dus: omzetten wat eenduidig is ('+…' en '00…', inclusief spaties en
// streepjes eruit), en wat NIET eenduidig is rauw laten staan zoals vandaag.
// Niets weggooien — die rijen zijn precies wat de opschoon-migratie moet
// kunnen vinden. Wel luid loggen, want stil overslaan is hoe dit gat 159
// rijen groot is geworden.
//
// Dat er daarna geen WhatsApp naar zo'n nummer vertrekt zonder dat iemand het
// ziet, is de taak van de send-kant (zie de Meta-weigering op de run).
function _phoneVoorOpslag(raw, eventId) {
  const pn = normaliseerStrict(raw);
  if (pn.e164) return pn.e164;
  if (pn.ambigu || pn.fout) {
    console.warn('[event-signup-processor] telefoonnummer niet eenduidig, rauw opgeslagen'
      + ' (event ' + eventId + '):', String(raw).slice(0, 24));
    return raw == null ? null : String(raw).trim() || null;
  }
  return null;   // geen nummer gegeven
}

import {
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './event-registration.js';

// Losse re-export voor callers die de cascade zelf willen aansturen (bv. de
// backfill die 'em één keer aan het eind draait per uniek event).
export async function runSeatFillCascade(event) {
  try {
    const confirmedCount = await getConfirmedCount(event.id);
    const gastenlijst    = await syncGastenlijstWebflow(event, confirmedCount);
    const autoClose      = await autoCloseIfFull(event, confirmedCount);
    return {
      ok: true, confirmed_count: confirmedCount,
      gastenlijst_label: gastenlijst?.label || null,
      auto_closed: !!autoClose?.auto_closed,
    };
  } catch (e) {
    console.error('[event-signup-processor] runSeatFillCascade:', e.message);
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function findExistingAttendee({ eventId, email, phone }) {
  // Email-eerst dedup (bestaande partial UNIQUE op (event_id, lower(email))).
  // automation_enabled meegeleverd zodat callers (bv. de backfill) een
  // half-verwerkte rij (enabled=false) kunnen detecteren voor resume.
  if (email) {
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone, automation_enabled, created_via')
      .eq('event_id', eventId)
      .ilike('email', email)
      .maybeSingle();
    if (error) console.error('[event-signup-processor] email dedup:', error.message);
    if (data) return data;
  }
  if (phone) {
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone, automation_enabled, created_via')
      .eq('event_id', eventId)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();
    if (error) console.error('[event-signup-processor] phone dedup:', error.message);
    if (data) return data;
  }
  return null;
}

export async function createAttendee({
  event, payload, status = 'aangemeld', followUpReason = null,
  ghlContactId = null, ghlFormSubmissionId = null,
  createdVia = 'ghl_inbound', source = 'ghl',
  automationEnabled,
}) {
  const row = {
    event_id              : event.id,
    first_name            : payload.first_name,
    last_name             : payload.last_name,
    email                 : payload.email,
    phone                 : _phoneVoorOpslag(payload.phone, event.id),
    status                : status,
    created_via           : createdVia,
    source                : source,
    ghl_contact_id        : ghlContactId,
    ghl_form_submission_id: ghlFormSubmissionId,
    assessment_response_id: null,
    follow_up_flagged     : !!followUpReason,
    follow_up_reason      : followUpReason || null,
    registered_at         : payload.registered_at || new Date().toISOString(),
  };
  // automation_enabled alleen expliciet zetten wanneer caller 'em meestuurt.
  // Weglaten → DB-default (true) blijft actief; bestaand inbound-gedrag
  // onveranderd. Backfill zet 'em bewust op false om het enroll-race-venster
  // te sluiten tussen insert en preemptive-cancel van overdue automations.
  if (automationEnabled === true || automationEnabled === false) {
    row.automation_enabled = automationEnabled;
  }
  const { data, error } = await supabaseAdmin
    .from('event_attendees')
    .insert(row)
    .select('id, event_id, email, phone, status, follow_up_flagged, follow_up_reason')
    .maybeSingle();
  if (error) {
    // 23505 = unique_violation op (event_id, lower(email))
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
      const dup = await findExistingAttendee({
        eventId: event.id, email: payload.email, phone: payload.phone,
      });
      if (dup) return { row: dup, deduplicated: true };
    }
    throw new Error('attendee insert: ' + error.message);
  }
  if (!data) throw new Error('attendee insert returnde geen rij');
  return { row: data, deduplicated: false };
}

/**
 * Volle post-resolve flow (identiek aan de core van events-signup-inbound
 * regels 378-446). Geeft dezelfde return-velden terug zodat de handler
 * z'n response ongewijzigd kan bouwen en de backfill exact hetzelfde
 * gedrag krijgt.
 *
 * @returns { attendee_id, deduplicated, confirmed_count, gastenlijst_label,
 *            auto_closed, dedup_note, ambiguous_note }
 */
export async function processSignup({
  event, isAmbiguous = false, matches = null,
  payload, ghlContactId = null, ghlFormSubmissionId = null,
  createdVia = 'ghl_inbound', source = 'ghl',
  automationEnabled,
  // skipSeatFill: sla de seat-fill cascade (getConfirmedCount →
  // syncGastenlijstWebflow → autoCloseIfFull) over. De backfill zet dit op
  // true en draait de sync éénmalig aan het eind per uniek event, om per-rij
  // Webflow-API-latency (10-30s) uit de kritieke pad te halen. Live inbound
  // laat 'em default false → gedrag onveranderd.
  skipSeatFill = false,
}) {
  const followUpReason = isAmbiguous
    ? `AMBIGUOUS_LABEL: ${matches?.length ?? 2} candidates`
    : null;

  const existing = await findExistingAttendee({
    eventId: event.id, email: payload.email, phone: payload.phone,
  });

  let attendeeId, dedupNote = null;
  if (existing) {
    attendeeId = existing.id;
    dedupNote  = 'deduplicated: existing attendee re-used';
  } else {
    // Capaciteitscheck vóór de insert: is het event al vol, dan als
    // 'wachtlijst' toevoegen (niet weggooien).
    let inschrijfStatus = 'aangemeld';
    try {
      const cap = Number(event.capacity);
      if (Number.isInteger(cap) && cap > 0 && (await getConfirmedCount(event.id)) >= cap) {
        inschrijfStatus = 'wachtlijst';
      }
    } catch (e) {
      console.error('[event-signup-processor] capaciteitscheck (soft):', e.message);
    }
    const created = await createAttendee({
      event, payload, status: inschrijfStatus, followUpReason,
      ghlContactId, ghlFormSubmissionId, createdVia, source,
      automationEnabled,
    });
    attendeeId = created.row.id;
    if (created.deduplicated) dedupNote = 'deduplicated: race-condition dup detected';
  }

  // Seat-fill helpers (best-effort; faal blokkeert flow niet). In backfill-
  // mode overslaan we deze cascade en draait de caller 'em één keer per
  // uniek event aan het eind (Webflow-API is ~10-30s per call).
  let confirmedCount = 0;
  let gastenlijst = null;
  let autoClose = null;
  if (!skipSeatFill) {
    try {
      confirmedCount = await getConfirmedCount(event.id);
      gastenlijst    = await syncGastenlijstWebflow(event, confirmedCount);
      autoClose      = await autoCloseIfFull(event, confirmedCount);
    } catch (e) {
      console.error('[event-signup-processor] seat-fill cascade:', e.message);
    }
  }

  return {
    attendee_id      : attendeeId,
    deduplicated     : !!dedupNote,
    confirmed_count  : confirmedCount,
    gastenlijst_label: gastenlijst?.label || null,
    auto_closed      : !!autoClose?.auto_closed,
    dedup_note       : dedupNote,
  };
}
