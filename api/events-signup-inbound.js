// api/events-signup-inbound.js
// PUBLIEK secret-protected webhook-endpoint voor inbound event-signups
// (initieel: GHL Conversation/Form-submits).
//
// Flow:
//   1. Secret-check via header X-Webhook-Secret tegen env
//      EVENTS_INBOUND_WEBHOOK_SECRET. Mismatch -> 401, geen DB-mutatie.
//   2. Honeypot 'hp_company' moet leeg/ontbrekend zijn (bots vullen 'm).
//   3. IP-rate-limit: max 1 inzending per IP-hash per 5s (zelfde IP-pattern
//      als assessment-submit, maar tegen event_signup_inbox-tabel).
//   4. Schrijf ALTIJD eerst een event_signup_inbox-rij (raw_payload). Dat
//      garandeert audit-trail ook als reverse-lookup of seat-fill faalt.
//   5. Reverse-lookup via findEventsByLabel (zelfde formatEventLabel als
//      F2 outbound):
//        0 matches -> match_status='no_match', geen attendee.
//        1 match   -> attendee aanmaken (status='aangemeld',
//                     created_via='ghl_inbound'), match_status='matched'.
//        2+ matches -> attendee bij EERSTE match + follow_up_flagged=true,
//                     match_status='ambiguous'.
//   6. Bij attendee-aanmaak: run seat-fill helpers (getConfirmedCount ->
//      syncGastenlijstWebflow -> autoCloseIfFull) zoals assessment-register.
//   7. Return ALTIJD 200 (webhook-vriendelijk; GHL retried niet eindeloos).
//
// Body shape (flexibel; GHL custom-fields kunnen verschillen):
//   {
//     first_name, last_name, email, phone,
//     ghl_contact_id?, ghl_form_submission_id?,
//     event_date_label,
//     hp_company?    // honeypot
//   }
//
// Response 200: { ok, inbox_id, match_status, attendee_id?,
//                  matched_event_id?, candidate_count }
// Response 401: secret-mismatch (geen DB-mutatie)
// Response 405: POST only
// Response 422: honeypot tripped (geen DB-mutatie)
// Response 429: rate-limit hit (geen DB-mutatie)

import { supabaseAdmin } from './supabase.js';
import { extractClientIp, hashIp } from './_lib/assessment-validation.js';
import { resolveEventByLabel } from './_lib/event-label-matcher.js';
import {
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './_lib/event-registration.js';

const RATE_LIMIT_SECONDS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pickString(v, maxLen = 500) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

async function isIpRateLimited(ipHash) {
  if (!ipHash) return false;
  const since = new Date(Date.now() - RATE_LIMIT_SECONDS * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('event_signup_inbox')
    .select('id')
    .eq('submitter_ip_hash', ipHash)
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[events-signup-inbound] rate-limit query:', error.message);
    return false; // soft-fail
  }
  return !!data;
}

async function insertInboxRow(rowFields) {
  const { data, error } = await supabaseAdmin
    .from('event_signup_inbox')
    .insert(rowFields)
    .select('id')
    .maybeSingle();
  if (error) throw new Error('inbox insert: ' + error.message);
  if (!data)  throw new Error('inbox insert returnde geen rij');
  return data.id;
}

async function patchInboxRow(id, patch) {
  const { error } = await supabaseAdmin
    .from('event_signup_inbox')
    .update({ ...patch })
    .eq('id', id);
  if (error) console.error('[events-signup-inbound] inbox patch:', error.message);
}

async function findExistingAttendee({ eventId, email, phone }) {
  // Email-eerst dedup (bestaande partial UNIQUE op (event_id, lower(email))).
  if (email) {
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone')
      .eq('event_id', eventId)
      .ilike('email', email)
      .maybeSingle();
    if (error) console.error('[events-signup-inbound] email dedup:', error.message);
    if (data) return data;
  }
  // Geen email -> code-level dedup op phone (geen UNIQUE in DB).
  if (phone) {
    const { data, error } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone')
      .eq('event_id', eventId)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();
    if (error) console.error('[events-signup-inbound] phone dedup:', error.message);
    if (data) return data;
  }
  return null;
}

async function createAttendee({ event, payload, followUpReason = null, ghlContactId, ghlFormSubmissionId }) {
  const row = {
    event_id              : event.id,
    first_name            : payload.first_name,
    last_name             : payload.last_name,
    email                 : payload.email,
    phone                 : payload.phone,
    status                : 'aangemeld',
    created_via           : 'ghl_inbound',
    ghl_contact_id        : ghlContactId,
    ghl_form_submission_id: ghlFormSubmissionId,
    assessment_response_id: null,
    follow_up_flagged     : !!followUpReason,
    follow_up_reason      : followUpReason || null,
    registered_at         : new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from('event_attendees')
    .insert(row)
    .select('id, event_id, email, phone, status, follow_up_flagged, follow_up_reason')
    .maybeSingle();
  if (error) {
    // 23505 = unique_violation op (event_id, lower(email))
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
      // Race: tussen findExistingAttendee en insert is iemand anders erin
      // gekomen. Probeer 'm alsnog op te halen.
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // 1) Secret-check (geen DB-mutatie bij mismatch).
  const expected = process.env.EVENTS_INBOUND_WEBHOOK_SECRET || null;
  const received = req.headers?.['x-webhook-secret'] || null;
  if (!expected) {
    console.error('[events-signup-inbound] EVENTS_INBOUND_WEBHOOK_SECRET env-var ontbreekt');
    return res.status(503).json({ error: 'inbound webhook niet geconfigureerd' });
  }
  if (!received || String(received) !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2) Body parsen.
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body moet JSON zijn' });

  // 3) Honeypot (geen DB-mutatie als bot).
  if (body.hp_company != null && String(body.hp_company).trim() !== '') {
    return res.status(422).json({ error: 'Inzending kon niet worden verwerkt.' });
  }

  // 4) IP-rate-limit (geen DB-mutatie als hit).
  const ip = extractClientIp(req);
  const ipHash = hashIp(ip);
  if (await isIpRateLimited(ipHash)) {
    return res.status(429).json({ error: 'Te veel webhook-aanvragen vanaf dit IP.' });
  }

  // 5) Payload normaliseren.
  const firstName = pickString(body.first_name, 200);
  const lastName  = pickString(body.last_name, 200);
  const rawEmail  = pickString(body.email, 320);
  const email     = (rawEmail && EMAIL_RE.test(rawEmail.toLowerCase())) ? rawEmail.toLowerCase() : null;
  const phone     = pickString(body.phone, 50);
  const ghlContactId       = pickString(body.ghl_contact_id, 200);
  const ghlFormSubmissionId = pickString(body.ghl_form_submission_id, 200);
  const eventDateLabel     = pickString(body.event_date_label, 500);

  // 6) Inbox-rij is altijd onze single source-of-truth, ongeacht resolve-uitkomst.
  let initialMatchStatus = 'no_match';
  if (!eventDateLabel) initialMatchStatus = 'invalid_payload';
  if (!email && !phone) initialMatchStatus = 'invalid_payload';

  let inboxId;
  try {
    inboxId = await insertInboxRow({
      source                : 'ghl_inbound',
      raw_payload           : body,
      ghl_contact_id        : ghlContactId,
      ghl_form_submission_id: ghlFormSubmissionId,
      event_date_label      : eventDateLabel,
      first_name            : firstName,
      last_name             : lastName,
      email                 : email,
      phone                 : phone,
      match_status          : initialMatchStatus,
      submitter_ip_hash     : ipHash,
    });
  } catch (e) {
    console.error('[events-signup-inbound] inbox insert error:', e.message);
    // Webhook-vriendelijk: nog steeds 200 zodat GHL niet retried; admin
    // ziet de error in logs en kan handmatig nareconstrueren.
    return res.status(200).json({
      ok: false, error: 'inbox insert failed', message: e.message,
    });
  }

  if (initialMatchStatus === 'invalid_payload') {
    return res.status(200).json({
      ok: true, inbox_id: inboxId, match_status: 'invalid_payload',
      reason: !eventDateLabel ? 'missing event_date_label' : 'missing email and phone',
    });
  }

  // 7) Reverse-lookup label -> event. Tolerant: niveau-suffix optioneel,
  // canonical match op (date, startTime) met endTime + niveau als
  // tiebreakers (zie resolveEventByLabel in event-label-matcher.js).
  let lookup;
  try {
    lookup = await resolveEventByLabel(eventDateLabel);
  } catch (e) {
    console.error('[events-signup-inbound] label resolve:', e.message);
    return res.status(200).json({
      ok: false, inbox_id: inboxId, match_status: 'no_match',
      error: 'label-resolve failed', message: e.message,
    });
  }

  const matches = lookup.matches;

  // 8) Geen match (incl. onparsebaar label).
  if (matches.length === 0) {
    await patchInboxRow(inboxId, { notes: `resolve_reason=${lookup.reason}` });
    return res.status(200).json({
      ok: true, inbox_id: inboxId, match_status: 'no_match',
      candidate_count: lookup.candidateCount,
      resolve_reason: lookup.reason,
    });
  }

  // 9) 1+ match -> attendee aanmaken (bij ambiguous: pak de eerste + flag).
  // reason='unique-canonical-match' | 'endtime-tiebreaker' | 'niveau-tiebreaker'
  // -> 1 match (matched). Andere reasons met >=2 matches -> ambiguous.
  const isAmbiguous = matches.length > 1;
  const chosenEvent = matches[0];
  const followUpReason = isAmbiguous
    ? `AMBIGUOUS_LABEL: ${matches.length} candidates after ${lookup.reason}`
    : null;

  // Dedup-check vooraf zodat we niet onnodig insert+catch hoeven.
  const existing = await findExistingAttendee({
    eventId: chosenEvent.id, email, phone,
  });
  let attendeeId, dedupNote = null;
  if (existing) {
    attendeeId = existing.id;
    dedupNote  = 'deduplicated: existing attendee re-used';
  } else {
    try {
      const created = await createAttendee({
        event: chosenEvent,
        payload: { first_name: firstName, last_name: lastName, email, phone },
        followUpReason,
        ghlContactId,
        ghlFormSubmissionId,
      });
      attendeeId = created.row.id;
      if (created.deduplicated) dedupNote = 'deduplicated: race-condition dup detected';
    } catch (e) {
      console.error('[events-signup-inbound] attendee create:', e.message);
      await patchInboxRow(inboxId, {
        match_status        : isAmbiguous ? 'ambiguous' : 'matched',
        matched_event_id    : chosenEvent.id,
        match_candidate_ids : matches.map((m) => m.id),
        notes               : 'attendee create failed: ' + e.message,
      });
      return res.status(200).json({
        ok: false, inbox_id: inboxId,
        match_status: isAmbiguous ? 'ambiguous' : 'matched',
        matched_event_id: chosenEvent.id,
        error: 'attendee create failed', message: e.message,
      });
    }
  }

  // 10) Seat-fill helpers (best-effort; faal blokkeert webhook niet).
  let confirmedCount = 0;
  let gastenlijst = null;
  let autoClose = null;
  try {
    confirmedCount = await getConfirmedCount(chosenEvent.id);
    gastenlijst    = await syncGastenlijstWebflow(chosenEvent, confirmedCount);
    autoClose      = await autoCloseIfFull(chosenEvent, confirmedCount);
  } catch (e) {
    console.error('[events-signup-inbound] seat-fill cascade:', e.message);
  }

  // 11) Inbox-rij definitief bijwerken.
  const noteParts = [`resolve_reason=${lookup.reason}`];
  if (dedupNote) noteParts.push(dedupNote);
  await patchInboxRow(inboxId, {
    match_status        : isAmbiguous ? 'ambiguous' : 'matched',
    matched_event_id    : chosenEvent.id,
    matched_attendee_id : attendeeId,
    match_candidate_ids : matches.map((m) => m.id),
    notes               : noteParts.join('; '),
  });

  return res.status(200).json({
    ok               : true,
    inbox_id         : inboxId,
    match_status     : isAmbiguous ? 'ambiguous' : 'matched',
    matched_event_id : chosenEvent.id,
    attendee_id      : attendeeId,
    candidate_count  : matches.length,
    deduplicated     : !!dedupNote,
    confirmed_count  : confirmedCount,
    gastenlijst_label: gastenlijst?.label || null,
    auto_closed      : !!autoClose?.auto_closed,
    resolve_reason   : lookup.reason,
  });
}
