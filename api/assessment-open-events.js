// api/assessment-open-events.js
// PUBLIEKE GET-endpoint: returnt upcoming open events voor een gegeven
// niveau. Wordt door modules/assessment.html aangeroepen na het routing-
// resultaat om de date-picker te vullen.
//
// Filter:
//   - status = 'published'
//   - signups_closed = false
//   - starts_at > now()
//   - niveau = ?niveau=basis|gevorderd  (verplicht)
//
// Hergebruikt de Blok 1 / F2 open-event-query: zelfde filter als
// computeUpcomingLabels in event-sync-orchestrator.js zodat de Webflow/GHL-
// kant en dit publieke endpoint nooit uit sync lopen.
//
// Per event: id, title, starts_at, capacity, confirmed_count, has_space.
//
// Response 200: { niveau, events: [...] }
// Response 400: niveau ontbreekt of ongeldig
// Response 405: GET only
// Response 500: database-fout

import { supabaseAdmin } from './supabase.js';
import {
  CONFIRMED_STATUSES,
  NIVEAU_FROM_ROUTING,
} from './_lib/event-registration.js';

const ALLOWED_NIVEAUS = Object.values(NIVEAU_FROM_ROUTING); // ['gevorderd','basis']

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const niveau = req.query?.niveau ? String(req.query.niveau).toLowerCase() : null;
  if (!niveau || !ALLOWED_NIVEAUS.includes(niveau)) {
    return res.status(400).json({
      error: `niveau vereist (${ALLOWED_NIVEAUS.join('|')})`,
    });
  }

  try {
    const nowIso = new Date().toISOString();

    // 1) Open events voor dit niveau.
    const { data: events, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, capacity, location')
      .eq('status', 'published')
      .eq('signups_closed', false)
      .eq('niveau', niveau)
      .gt('starts_at', nowIso)
      .order('starts_at', { ascending: true })
      .limit(50);
    if (evErr) throw new Error('events select: ' + evErr.message);
    if (!events || events.length === 0) {
      return res.status(200).json({ niveau, events: [] });
    }

    // 2) Confirmed counts per event in 1 round-trip.
    const eventIds = events.map((e) => e.id);
    const { data: countRows, error: cntErr } = await supabaseAdmin
      .from('event_attendees')
      .select('event_id')
      .in('event_id', eventIds)
      .in('status', CONFIRMED_STATUSES);
    if (cntErr) {
      // Soft-fail: log + return events met confirmed_count=0 zodat de UI
      // wel bruikbaar blijft (auto-vol mist wel signaal, maar dat heeft de
      // registratie-endpoint server-side z'n eigen guard).
      console.error('[assessment-open-events] count error:', cntErr.message);
    }
    const countsByEvent = {};
    for (const r of (countRows || [])) {
      countsByEvent[r.event_id] = (countsByEvent[r.event_id] || 0) + 1;
    }

    const out = events.map((e) => {
      const cnt = countsByEvent[e.id] || 0;
      const cap = Number.isInteger(Number(e.capacity)) ? Number(e.capacity) : null;
      return {
        id              : e.id,
        title           : e.title,
        starts_at       : e.starts_at,
        ends_at         : e.ends_at,
        capacity        : cap,
        confirmed_count : cnt,
        has_space       : cap == null ? true : cnt < cap,
        location        : e.location,
      };
    });

    return res.status(200).json({ niveau, events: out });
  } catch (e) {
    console.error('[assessment-open-events]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
