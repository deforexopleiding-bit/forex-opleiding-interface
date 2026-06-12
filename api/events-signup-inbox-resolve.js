// api/events-signup-inbox-resolve.js
// POST -> admin koppelt een no_match/ambiguous-inbox-rij handmatig aan een
// gekozen event_id. Maakt alsnog de attendee aan + zet resolved_at/by op
// de inbox-rij.
//
// Sessie-JWT + RBAC events.attendee.create.
//
// Body:
//   {
//     inbox_id: uuid,
//     event_id: uuid,
//     notes?:   string
//   }
//
// Gedrag:
//   - inbox-rij moet bestaan en match_status IN ('no_match','ambiguous','invalid_payload').
//     Al 'matched' + resolved -> 409 ALREADY_RESOLVED.
//   - event moet bestaan + status='published' + signups_closed=false.
//     Anders -> 409 EVENT_NOT_OPEN.
//   - Dedup: zelfde event_id + lower(email) -> gebruik bestaande attendee.
//     Zelfde event_id + phone zonder email -> idem (code-level dedup).
//   - Insert event_attendees met status='aangemeld' + created_via='ghl_inbound'
//     + follow_up_flagged + follow_up_reason='RESOLVED_FROM_INBOX'.
//   - Run getConfirmedCount + syncGastenlijstWebflow + autoCloseIfFull
//     (zelfde cascade als de webhook + assessment-register).
//   - Update inbox-rij: match_status='matched', matched_event_id,
//     matched_attendee_id, resolved_at=now(), resolved_by_user_id=user.id,
//     notes=optional admin-notitie.
//
// Response 200: { ok, inbox_id, event_id, attendee_id, deduplicated,
//                  confirmed_count, gastenlijst_label, auto_closed }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './_lib/event-registration.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findExistingAttendee({ eventId, email, phone }) {
  if (email) {
    const { data } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone')
      .eq('event_id', eventId)
      .ilike('email', email)
      .maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await supabaseAdmin
      .from('event_attendees')
      .select('id, email, phone')
      .eq('event_id', eventId)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.create)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const inboxId = typeof body.inbox_id === 'string' ? body.inbox_id.trim() : null;
  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : null;
  const notes   = typeof body.notes === 'string'    ? body.notes.trim().slice(0, 1000) : null;

  if (!inboxId || !UUID_RE.test(inboxId)) {
    return res.status(400).json({ error: 'inbox_id (uuid) vereist' });
  }
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }

  try {
    // 1) Inbox-rij ophalen + status-gate.
    const { data: inbox, error: inboxErr } = await supabaseAdmin
      .from('event_signup_inbox')
      .select('*')
      .eq('id', inboxId)
      .maybeSingle();
    if (inboxErr) throw new Error('inbox fetch: ' + inboxErr.message);
    if (!inbox)   return res.status(404).json({ error: 'Inbox-rij niet gevonden' });
    if (inbox.match_status === 'matched' && inbox.resolved_at) {
      return res.status(409).json({
        error: 'Deze inbox-rij is al gekoppeld.',
        code : 'ALREADY_RESOLVED',
        attendee_id: inbox.matched_attendee_id,
      });
    }

    // 2) Event ophalen + gate.
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, status, signups_closed, niveau, capacity, webflow_item_id, starts_at')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event)  return res.status(404).json({ error: 'Event niet gevonden' });
    if (event.status !== 'published') {
      return res.status(409).json({ error: 'Event is niet gepubliceerd.', code: 'EVENT_NOT_OPEN' });
    }
    if (event.signups_closed === true) {
      return res.status(409).json({ error: 'Inschrijvingen zijn gesloten.', code: 'EVENT_CLOSED' });
    }

    // 3) Dedup-check op (event_id, email/phone).
    const existing = await findExistingAttendee({
      eventId: event.id,
      email  : inbox.email,
      phone  : inbox.phone,
    });

    let attendeeId, deduplicated = false;
    if (existing) {
      attendeeId   = existing.id;
      deduplicated = true;
    } else {
      const insertRow = {
        event_id              : event.id,
        first_name            : inbox.first_name,
        last_name             : inbox.last_name,
        email                 : inbox.email,
        phone                 : inbox.phone,
        status                : 'aangemeld',
        created_via           : 'ghl_inbound',
        ghl_contact_id        : inbox.ghl_contact_id,
        ghl_form_submission_id: inbox.ghl_form_submission_id,
        assessment_response_id: null,
        follow_up_flagged     : true,
        follow_up_reason      : 'RESOLVED_FROM_INBOX',
        registered_at         : new Date().toISOString(),
        created_by_user_id    : user.id,
      };
      const { data: row, error: insErr } = await supabaseAdmin
        .from('event_attendees')
        .insert(insertRow)
        .select('id')
        .maybeSingle();
      if (insErr) {
        if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
          // Race: probeer existing alsnog op te halen.
          const dup = await findExistingAttendee({ eventId: event.id, email: inbox.email, phone: inbox.phone });
          if (dup) { attendeeId = dup.id; deduplicated = true; }
          else throw new Error('attendee insert dup zonder existing-match');
        } else {
          throw new Error('attendee insert: ' + insErr.message);
        }
      } else if (!row) {
        throw new Error('attendee insert returnde geen rij');
      } else {
        attendeeId = row.id;
      }
    }

    // 4) Seat-fill cascade (best-effort).
    let confirmedCount = 0;
    let gastenlijst = null;
    let autoClose = null;
    try {
      confirmedCount = await getConfirmedCount(event.id);
      gastenlijst    = await syncGastenlijstWebflow(event, confirmedCount);
      autoClose      = await autoCloseIfFull(event, confirmedCount);
    } catch (e) {
      console.error('[events-signup-inbox-resolve] seat-fill:', e.message);
    }

    // 5) Inbox-rij definitief markeren.
    const { error: upErr } = await supabaseAdmin
      .from('event_signup_inbox')
      .update({
        match_status        : 'matched',
        matched_event_id    : event.id,
        matched_attendee_id : attendeeId,
        resolved_at         : new Date().toISOString(),
        resolved_by_user_id : user.id,
        notes               : notes || inbox.notes || null,
      })
      .eq('id', inboxId);
    if (upErr) console.error('[events-signup-inbox-resolve] inbox patch:', upErr.message);

    return res.status(200).json({
      ok               : true,
      inbox_id         : inboxId,
      event_id         : event.id,
      attendee_id      : attendeeId,
      deduplicated,
      confirmed_count  : confirmedCount,
      gastenlijst_label: gastenlijst?.label || null,
      auto_closed      : !!autoClose?.auto_closed,
    });
  } catch (e) {
    console.error('[events-signup-inbox-resolve]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
