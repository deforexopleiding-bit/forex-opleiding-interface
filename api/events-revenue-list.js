// api/events-revenue-list.js
//
// GET → gerealiseerde omzet per event, in €. Read-only, geen schema-wijziging.
//
// Bron/koppeling:
//   event_attendees.deal_id  →  deals.id (deals.total_amount)
//   filter: deals.tl_quotation_status IN ('accepted','signed')
//   aggregate: SUM(total_amount) per event_id + count(distinct deal_id)
//
// Waarom deze definitie:
//   'accepted' + 'signed' zijn de gerealiseerde-verkoop-statussen uit de
//   TeamLeader-quotation-flow (bron: docs/sql-migrations/2026-05-31-
//   quotation-send-webhook.sql regel 26). 'draft'/'sent' zijn nog niet
//   gerealiseerd; 'declined'/'expired' zijn verloren. Zelfde ACCEPTED-set
//   die events-completed-list gebruikt voor de sales-COUNT — nu voor de
//   €-SOM. Dubbele deals per event worden per unieke deal_id één keer
//   opgeteld (via Set-dedup) zodat 2 attendees op dezelfde offerte de
//   omzet niet dubbeltellen.
//
// Response:
//   { ok:true, generated_at, events: [
//       { event_id, revenue_eur, deal_count }, ...
//     ] }
//
// Permission: events.event.view (mirror van events-list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ACCEPTED_STATUSES = ['accepted', 'signed'];
const ATTENDEE_CHUNK    = 500;   // PostgREST .in()-limit ~1000
const DEAL_CHUNK        = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  try {
    // 1) Alle event_attendees met deal_id — chunked ophalen.
    // We halen (event_id, deal_id)-paren op zonder status-filter: alle attendees
    // die aan een deal zijn gekoppeld tellen mee zolang de deal accepted/signed is.
    const pairs = []; // [{event_id, deal_id}]
    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('event_attendees')
        .select('event_id, deal_id')
        .not('deal_id', 'is', null)
        .range(from, from + ATTENDEE_CHUNK - 1);
      if (error) throw new Error('attendees: ' + error.message);
      if (!data || data.length === 0) break;
      for (const r of data) pairs.push(r);
      if (data.length < ATTENDEE_CHUNK) break;
      from += ATTENDEE_CHUNK;
      if (from > 50000) break;   // veiligheidscap
    }

    if (pairs.length === 0) {
      return res.status(200).json({ ok: true, generated_at: new Date().toISOString(), events: [] });
    }

    // 2) Fetch deals met total_amount + tl_quotation_status, chunked in `deal_id`.
    const uniqueDealIds = Array.from(new Set(pairs.map((p) => p.deal_id).filter(Boolean)));
    const dealById = new Map(); // deal_id → { total_amount, status }
    for (let i = 0; i < uniqueDealIds.length; i += DEAL_CHUNK) {
      const slice = uniqueDealIds.slice(i, i + DEAL_CHUNK);
      const { data, error } = await supabaseAdmin
        .from('deals')
        .select('id, total_amount, tl_quotation_status')
        .in('id', slice);
      if (error) { console.warn('[events-revenue-list] deals chunk fail:', error.message); continue; }
      for (const d of (data || [])) dealById.set(d.id, d);
    }

    // 3) Aggregate per event_id — dedup deals binnen event zodat dezelfde
    //    offerte niet dubbel wordt geteld als er 2 attendees op zijn gekoppeld.
    const eventMap = new Map(); // event_id → { revenue_eur, deal_ids:Set }
    for (const { event_id, deal_id } of pairs) {
      const deal = dealById.get(deal_id);
      if (!deal) continue;
      const status = String(deal.tl_quotation_status || '').toLowerCase();
      if (!ACCEPTED_STATUSES.includes(status)) continue;
      const amt = Number(deal.total_amount || 0);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      let cell = eventMap.get(event_id);
      if (!cell) { cell = { revenue_eur: 0, deal_ids: new Set() }; eventMap.set(event_id, cell); }
      if (cell.deal_ids.has(deal_id)) continue;   // dubbeltelling-guard
      cell.deal_ids.add(deal_id);
      cell.revenue_eur += amt;
    }

    const events = [];
    for (const [event_id, cell] of eventMap.entries()) {
      events.push({
        event_id,
        revenue_eur: Math.round(cell.revenue_eur * 100) / 100,
        deal_count:  cell.deal_ids.size,
      });
    }
    events.sort((a, b) => b.revenue_eur - a.revenue_eur);

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      events,
      _debug: { attendee_pair_count: pairs.length, unique_deal_count: uniqueDealIds.length, accepted_statuses: ACCEPTED_STATUSES },
    });
  } catch (e) {
    console.error('[events-revenue-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
