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
import {
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './event-registration.js';

export async function findExistingAttendee({ eventId, email, phone }) {
  // Email-eerst dedup (bestaande partial UNIQUE op (event_id, lower(email))).
  if (email) {
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone')
      .eq('event_id', eventId)
      .ilike('email', email)
      .maybeSingle();
    if (error) console.error('[event-signup-processor] email dedup:', error.message);
    if (data) return data;
  }
  if (phone) {
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone')
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
}) {
  const row = {
    event_id              : event.id,
    first_name            : payload.first_name,
    last_name             : payload.last_name,
    email                 : payload.email,
    phone                 : payload.phone,
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
    });
    attendeeId = created.row.id;
    if (created.deduplicated) dedupNote = 'deduplicated: race-condition dup detected';
  }

  // Seat-fill helpers (best-effort; faal blokkeert flow niet).
  let confirmedCount = 0;
  let gastenlijst = null;
  let autoClose = null;
  try {
    confirmedCount = await getConfirmedCount(event.id);
    gastenlijst    = await syncGastenlijstWebflow(event, confirmedCount);
    autoClose      = await autoCloseIfFull(event, confirmedCount);
  } catch (e) {
    console.error('[event-signup-processor] seat-fill cascade:', e.message);
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
