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

// Genormaliseerde e-mail: trim + lowercase. Return null als leeg.
function _normEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return s || null;
}
// Genormaliseerd telefoonnummer: strip non-digits + last-9-fallback
// (Lesson-18-patroon). Return null als <9 digits (te weinig entropy).
function _normPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

// 2026-08-24 dedup-fix v2: pre-insert dedup-check op de JUISTE sleutel
// nadat meting toonde dat ghl_form_submission_id 100% NULL is in prod
// (GHL-webhook stuurt die key niet). Nieuwe sleutel:
//   person_key = ghl_contact_id OR normEmail OR normPhone-last-9
//   dedup-scope = (person_key, event_date_label)
// Zelfde persoon + zelfde event = één inbox-rij. Zelfde persoon + ander
// event = 2 rijen (bewust — verschillende deelnames).
async function findExistingInboxRow({ ghlContactId, email, phone, eventDateLabel }) {
  if (!eventDateLabel) return null;   // zonder event-scope geen dedup
  // 1) ghl_contact_id-eerst (meest betrouwbare + snelste dankzij nieuwe index).
  if (ghlContactId) {
    const { data, error } = await supabaseAdmin
      .from('event_signup_inbox')
      .select('id')
      .eq('ghl_contact_id', ghlContactId)
      .eq('event_date_label', eventDateLabel)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[events-signup-inbound] dedup lookup (contact):', error.message);
      return null;   // soft-fail → nieuwe INSERT proberen
    }
    if (data?.id) return data.id;
  }
  // 2) Email-fallback (normalized).
  const nEmail = _normEmail(email);
  if (nEmail) {
    const { data, error } = await supabaseAdmin
      .from('event_signup_inbox')
      .select('id')
      .ilike('email', nEmail)              // ilike voor case-tolerantie
      .eq('event_date_label', eventDateLabel)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[events-signup-inbound] dedup lookup (email):', error.message);
      return null;
    }
    if (data?.id) return data.id;
  }
  // 3) Phone-fallback (last-9-digits). SUBSTRING op regexp_replace niet
  // native via supabase-js; halen we recente rijen op voor deze event_date_label
  // met non-null phone en filteren client-side. Kleine set want beperkt op label.
  const nPhone = _normPhone(phone);
  if (nPhone) {
    const { data, error } = await supabaseAdmin
      .from('event_signup_inbox')
      .select('id, phone')
      .eq('event_date_label', eventDateLabel)
      .not('phone', 'is', null)
      .order('received_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('[events-signup-inbound] dedup lookup (phone):', error.message);
      return null;
    }
    for (const row of (data || [])) {
      if (_normPhone(row.phone) === nPhone) return row.id;
    }
  }
  return null;
}

async function insertInboxRow(rowFields) {
  // Pre-insert dedup: als een matching rij bestaat op (person_key +
  // event_date_label), return die id — geen nieuwe rij. Idempotent voor
  // GHL webhook-retries + voor iemand die 2× het formulier invult.
  // Fail-soft: als de lookup faalt (netwerk/DB-error) valt de code
  // terug op plain INSERT — dubbelen zijn cosmetisch (client-groepering
  // v=47 pakt ze op), maar data-verlies is uitgesloten.
  const existingId = await findExistingInboxRow({
    ghlContactId:    rowFields.ghl_contact_id,
    email:           rowFields.email,
    phone:           rowFields.phone,
    eventDateLabel:  rowFields.event_date_label,
  });
  if (existingId) return existingId;

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

async function createAttendee({ event, payload, status = 'aangemeld', followUpReason = null, ghlContactId, ghlFormSubmissionId }) {
  const row = {
    event_id              : event.id,
    first_name            : payload.first_name,
    last_name             : payload.last_name,
    email                 : payload.email,
    phone                 : payload.phone,
    status                : status,
    created_via           : 'ghl_inbound',
    source                : 'ghl',
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

  // GHL nest onze Custom Data onder `customData`; top-level staat GHL's
  // standaard-contactdata. Voor alle eigen velden lezen we daarom eerst
  // uit customData en pas dan top-level (backwards-compat met directe
  // POST's vanuit andere bronnen). raw_payload (= volledige body) wordt
  // hieronder ongewijzigd opgeslagen voor audit.
  const cd = (body && typeof body.customData === 'object' && body.customData) || {};

  // 3) Honeypot (geen DB-mutatie als bot).
  const hpCompany = cd.hp_company ?? body.hp_company;
  if (hpCompany != null && String(hpCompany).trim() !== '') {
    return res.status(422).json({ error: 'Inzending kon niet worden verwerkt.' });
  }

  // 4) IP-rate-limit (geen DB-mutatie als hit).
  const ip = extractClientIp(req);
  const ipHash = hashIp(ip);
  if (await isIpRateLimited(ipHash)) {
    return res.status(429).json({ error: 'Te veel webhook-aanvragen vanaf dit IP.' });
  }

  // 5) Payload normaliseren — customData-first, top-level fallback.
  const firstName = pickString(cd.first_name ?? body.first_name, 200);
  const lastName  = pickString(cd.last_name  ?? body.last_name,  200);
  const rawEmail  = pickString(cd.email      ?? body.email,      320);
  const email     = (rawEmail && EMAIL_RE.test(rawEmail.toLowerCase())) ? rawEmail.toLowerCase() : null;
  const phone     = pickString(cd.phone      ?? body.phone,      50);
  const ghlContactId       = pickString(cd.ghl_contact_id        ?? body.ghl_contact_id,        200);
  const ghlFormSubmissionId = pickString(cd.ghl_form_submission_id ?? body.ghl_form_submission_id, 200);
  const eventDateLabel     = pickString(cd.event_date_label      ?? body.event_date_label,      500);

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
    // Punt 2 — capaciteitscheck vóór de insert: is het event (strikte telling)
    // al vol, dan als 'wachtlijst' toevoegen i.p.v. 'aangemeld' (niet weggooien).
    // Deze persoon heeft nog geen assessment, dus telt zelf nog niet mee.
    let inschrijfStatus = 'aangemeld';
    try {
      const cap = Number(chosenEvent.capacity);
      if (Number.isInteger(cap) && cap > 0 && (await getConfirmedCount(chosenEvent.id)) >= cap) {
        inschrijfStatus = 'wachtlijst';
      }
    } catch (e) {
      console.error('[events-signup-inbound] capaciteitscheck (soft):', e.message);
    }
    try {
      const created = await createAttendee({
        event: chosenEvent,
        payload: { first_name: firstName, last_name: lastName, email, phone },
        status: inschrijfStatus,
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
