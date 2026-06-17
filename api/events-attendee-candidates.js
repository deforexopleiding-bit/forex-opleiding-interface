// api/events-attendee-candidates.js
// POST -> resolve event_attendees-kandidaten voor een inbox-conversation.
//
// Server-side resolver omdat event_attendees RLS aan heeft zonder SELECT-
// policy voor de 'authenticated' rol (zie docs/sql-migrations/
// 2026-06-11-events-f1-foundation.sql:233-256). De browser-Supabase
// (window.supabase) krijgt daardoor structureel een leeg array terug.
// Dit endpoint gebruikt supabaseAdmin (service_role, bypassed RLS) en
// laat RBAC los op de API-laag.
//
// Permission (additief OR): events.attendee.view OF events.simone.use OF
// events.inbox.view. De inbox-template-picker hangt onder events.simone.use,
// de event-context-strip valt onder events.inbox.view; events.attendee.view
// is de "officiële" leesrechten voor aanwezigen. Eén van de drie volstaat.
//
// Body:
//   customer_id  uuid    optional
//   phone        string  optional
//   Minimaal één van de twee moet aanwezig zijn.
//
// Response 200: { candidates: [{
//   attendee_id, attendee_name, attendee_email, attendee_phone,
//   has_choice_token, event_id, event_title, event_starts_at, event_status
// }] }
//
// SHAPE-SPIEGEL: identiek aan de oude client-resolver in modules/events.html
// (regel ~3418, _evResolveAttendeeCandidatesForConv). attendee_name valt
// terug op email/phone/'—' als beide namen leeg zijn. choice_token wordt
// NIET rauw terug-gegeven; alleen has_choice_token (zelfde privacy-shape
// als de client).
//
// SORT-SPIEGEL:
//   1. Toekomstige events oplopend (eerstvolgende boven).
//   2. Verleden events aflopend (meest recente boven).
//   3. Zonder gekoppeld event onderaan.
//
// Fail-soft: als de customer_id-deelquery faalt maar de phone-query lukt
// (of andersom), retourneren we wat we hebben. Hard 500 alleen bij een
// echte exception buiten de twee deelqueries.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = 'id, event_id, first_name, last_name, email, phone, choice_token, customer_id, events(id, title, starts_at, status)';

function mapRowToCandidate(r, nowMs) {
  const ev = r.events || null;
  const startsMs = ev && ev.starts_at ? new Date(ev.starts_at).getTime() : 0;
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  return {
    attendee_id      : r.id,
    attendee_name    : fullName || (r.email || r.phone || '—'),
    attendee_email   : r.email || '',
    attendee_phone   : r.phone || '',
    has_choice_token : !!r.choice_token,
    event_id         : ev ? ev.id : null,
    event_title      : ev ? (ev.title || '') : '',
    event_starts_at  : ev ? ev.starts_at : null,
    event_status     : ev ? (ev.status || '') : '',
    _futureRank      : (Number.isFinite(startsMs) && startsMs >= nowMs) ? 0 : (startsMs > 0 ? 1 : 2),
    _startsMs        : startsMs,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth + additieve RBAC.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const hasAttendeeView = await requirePermission(req, 'events.attendee.view');
  const hasSimoneUse    = hasAttendeeView ? true : await requirePermission(req, 'events.simone.use');
  const hasInboxView    = (hasAttendeeView || hasSimoneUse)
    ? true
    : await requirePermission(req, 'events.inbox.view');
  if (!hasAttendeeView && !hasSimoneUse && !hasInboxView) {
    return res.status(403).json({
      error: 'Geen rechten (events.attendee.view / events.simone.use / events.inbox.view)',
    });
  }

  const body = req.body || {};
  const customerId = body.customer_id != null
    ? String(body.customer_id).trim() || null
    : null;
  const phone = body.phone != null
    ? String(body.phone).trim() || null
    : null;

  if (!customerId && !phone) {
    return res.status(400).json({ error: 'customer_id of phone vereist' });
  }
  if (customerId && !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id moet geldige uuid zijn' });
  }

  try {
    const seenIds = new Set();
    const rows = [];

    if (customerId) {
      const { data, error } = await supabaseAdmin
        .from('event_attendees')
        .select(SELECT_COLUMNS)
        .eq('customer_id', customerId)
        .limit(25);
      if (error) {
        console.warn('[events-attendee-candidates customer]', error.message);
      } else {
        for (const r of (data || [])) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          rows.push(r);
        }
      }
    }

    if (phone) {
      const { data, error } = await supabaseAdmin
        .from('event_attendees')
        .select(SELECT_COLUMNS)
        .eq('phone', phone)
        .limit(25);
      if (error) {
        console.warn('[events-attendee-candidates phone]', error.message);
      } else {
        for (const r of (data || [])) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          rows.push(r);
        }
      }
    }

    const nowMs = Date.now();
    const norm = rows.map((r) => mapRowToCandidate(r, nowMs));
    norm.sort((a, b) => {
      if (a._futureRank !== b._futureRank) return a._futureRank - b._futureRank;
      if (a._futureRank === 0) return a._startsMs - b._startsMs;
      return b._startsMs - a._startsMs;
    });

    // Strip helper-velden zodat de response strikt het publieke contract heeft.
    const candidates = norm.map(({ _futureRank, _startsMs, ...rest }) => rest);
    return res.status(200).json({ candidates });
  } catch (e) {
    console.error('[events-attendee-candidates]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
