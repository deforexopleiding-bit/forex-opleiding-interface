// api/events-followups-list.js
// GET -> open + recente event-follow-ups voor Dave's scherm (follow-up.html).
//
// Permission: events.event.view.
//
// Query-params:
//   status   text optional ('open' | 'afgehandeld'), default 'open'
//   owner_id uuid optional — filter op eigenaar; 'me' = auth.uid()
//   limit    int default 200, clamp 1..500
//   offset   int default 0
//   include_recent_handled  bool optional (alleen relevant bij status='open');
//                           als 'true', voeg ook recent afgehandelde (laatste 30 dagen)
//                           toe in een aparte array
//
// Response:
//   {
//     items: [{
//       id, attendee_id, event_id,
//       reason, follow_up_date, status, note,
//       created_at, handled_at,
//       owner: { id, full_name, email } | null,
//       attendee: { id, first_name, last_name, email, phone, status, has_signed_deal } | null,
//       event: { id, title, starts_at } | null,
//     }, ...],
//     total, limit, offset,
//     counts: { open, afgehandeld }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['open', 'afgehandeld'];

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  const q = req.query || {};
  const status = q.status ? String(q.status).toLowerCase() : 'open';
  if (!VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: `status moet ${VALID_STATUS.join('|')} zijn` });
  }
  let ownerFilter = null;
  if (q.owner_id) {
    if (q.owner_id === 'me') {
      ownerFilter = user.id;
    } else if (UUID_RE.test(String(q.owner_id))) {
      ownerFilter = String(q.owner_id);
    } else {
      return res.status(400).json({ error: 'owner_id moet uuid zijn (of "me")' });
    }
  }
  const limit  = clampInt(q.limit, 200, 1, 500);
  const offset = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  try {
    let qb = supabaseAdmin
      .from('event_followups')
      .select(`
        id, attendee_id, event_id, reason, follow_up_date,
        owner_id, status, note, created_at, handled_at
      `, { count: 'exact' })
      .eq('status', status)
      .order('follow_up_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (ownerFilter) qb = qb.eq('owner_id', ownerFilter);

    const { data: rows, error, count } = await qb;
    if (error) throw new Error('event_followups-list: ' + error.message);

    // Joins in JS (RLS-aware admin client; we doen 3 batch-queries voor
    // owners + attendees + events).
    const ownerIds    = Array.from(new Set((rows || []).map((r) => r.owner_id).filter(Boolean)));
    const attendeeIds = Array.from(new Set((rows || []).map((r) => r.attendee_id).filter(Boolean)));
    const eventIds    = Array.from(new Set((rows || []).map((r) => r.event_id).filter(Boolean)));

    const ownersMap = new Map();
    if (ownerIds.length > 0) {
      try {
        const { data: profs } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, email')
          .in('id', ownerIds);
        for (const p of profs || []) ownersMap.set(p.id, p);
      } catch (e) {
        console.error('[events-followups-list owners]', e?.message || e);
      }
    }

    const attendeesMap = new Map();
    const dealIdsToCheck = [];
    if (attendeeIds.length > 0) {
      try {
        const { data: atts } = await supabaseAdmin
          .from('event_attendees')
          .select('id, first_name, last_name, email, phone, status, deal_id')
          .in('id', attendeeIds);
        for (const a of atts || []) {
          attendeesMap.set(a.id, a);
          if (a.deal_id) dealIdsToCheck.push(a.deal_id);
        }
      } catch (e) {
        console.error('[events-followups-list attendees]', e?.message || e);
      }
    }

    const signedDealIds = new Set();
    if (dealIdsToCheck.length > 0) {
      try {
        const { data: deals } = await supabaseAdmin
          .from('deals')
          .select('id, tl_quotation_status, tl_quotation_accepted_at')
          .in('id', Array.from(new Set(dealIdsToCheck)));
        for (const d of deals || []) {
          const st = String(d.tl_quotation_status || '').toLowerCase();
          if (st === 'accepted' || st === 'signed' || d.tl_quotation_accepted_at) {
            signedDealIds.add(d.id);
          }
        }
      } catch (e) {
        console.error('[events-followups-list deals]', e?.message || e);
      }
    }

    const eventsMap = new Map();
    if (eventIds.length > 0) {
      try {
        const { data: evs } = await supabaseAdmin
          .from('events')
          .select('id, title, starts_at')
          .in('id', eventIds);
        for (const e of evs || []) eventsMap.set(e.id, e);
      } catch (e) {
        console.error('[events-followups-list events]', e?.message || e);
      }
    }

    const items = (rows || []).map((r) => {
      const owner = r.owner_id ? ownersMap.get(r.owner_id) || null : null;
      const att   = r.attendee_id ? attendeesMap.get(r.attendee_id) || null : null;
      const ev    = r.event_id ? eventsMap.get(r.event_id) || null : null;
      return {
        id            : r.id,
        attendee_id   : r.attendee_id,
        event_id      : r.event_id,
        reason        : r.reason,
        follow_up_date: r.follow_up_date,
        status        : r.status,
        note          : r.note,
        created_at    : r.created_at,
        handled_at    : r.handled_at,
        owner         : owner ? { id: owner.id, full_name: owner.full_name, email: owner.email } : null,
        attendee      : att ? {
          id: att.id, first_name: att.first_name, last_name: att.last_name,
          email: att.email, phone: att.phone, status: att.status,
          has_signed_deal: !!(att.deal_id && signedDealIds.has(att.deal_id)),
        } : null,
        event         : ev ? { id: ev.id, title: ev.title, starts_at: ev.starts_at } : null,
      };
    });

    // Counts (per status, ignoring offset/limit/owner filter zodat de tab-badges
    // accuraat zijn voor de bewerker).
    const counts = { open: 0, afgehandeld: 0 };
    try {
      const baseFilter = (qb2) => ownerFilter ? qb2.eq('owner_id', ownerFilter) : qb2;
      const [oRes, aRes] = await Promise.all([
        baseFilter(supabaseAdmin.from('event_followups').select('id', { count: 'exact', head: true }).eq('status', 'open')),
        baseFilter(supabaseAdmin.from('event_followups').select('id', { count: 'exact', head: true }).eq('status', 'afgehandeld')),
      ]);
      counts.open = typeof oRes.count === 'number' ? oRes.count : 0;
      counts.afgehandeld = typeof aRes.count === 'number' ? aRes.count : 0;
    } catch (e) {
      console.error('[events-followups-list counts]', e?.message || e);
    }

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({
      items, total, limit, offset, counts,
    });
  } catch (e) {
    console.error('[events-followups-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
