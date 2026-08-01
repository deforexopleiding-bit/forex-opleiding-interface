// api/super-admin-events-status.js
//
// GET → eerstkomende 5 events + per-event status voor het super_admin-dashboard.
//
// Query: ?limit=5 (default 5, max 10)
//
// Response 200:
//   {
//     events: [
//       {
//         id, title, starts_at, ends_at, location, capacity,
//         counts: {
//           vragenlijst_ingevuld: N,  // Fase 1: getConfirmedCount pattern
//           ingeschreven:         N,  // alle actieve statussen (aangemeld/aanwezig)
//           gebeld:               N,  // event_attendees.call_status IS NOT NULL
//         },
//         seats_remaining: N,  // capacity - vragenlijst_ingevuld
//         deep_link: '/modules/events-detail.html?id=<id>'
//       }, ...
//     ]
//   }
//
// Tellingen — bron: event_attendees, is_test=false altijd:
//   * vragenlijst_ingevuld = status IN (aangemeld,aanwezig) AND assessment_response_id NOT NULL
//     (== getConfirmedCount uit api/_lib/event-registration.js, Fase 1 capaciteits-regel)
//   * ingeschreven         = status IN (aangemeld,aanwezig)  (Fase 1 actieve)
//   * gebeld               = call_status IS NOT NULL  (canoniek — beide UI's lezen dit)
//
// Belstatus-bron: event_attendees.call_status (bevestigd in recon 2026-08-01).
// Zowel /modules/events-detail.html als api/follow-up-event-bellijst.js lezen
// dezelfde kolom; alleen api/follow-up-lead-outcome.js schrijft. Dus 1 kolom
// telt beide "bel-plekken" (Follow-up cockpit + events-module aanwezigen).
//
// Permission: dashboard.module.access.

import { supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

async function countAttendeeMetric(eventId, kind) {
  let q = supabaseAdmin
    .from('event_attendees')
    .select('id', { head: true, count: 'exact' })
    .eq('event_id', eventId)
    .eq('is_test', false);

  if (kind === 'vragenlijst_ingevuld') {
    q = q.in('status', ['aangemeld', 'aanwezig']).not('assessment_response_id', 'is', null);
  } else if (kind === 'ingeschreven') {
    q = q.in('status', ['aangemeld', 'aanwezig']);
  } else if (kind === 'gebeld') {
    q = q.not('call_status', 'is', null);
  } else {
    throw new Error('unknown metric: ' + kind);
  }
  const { count, error } = await q;
  if (error) throw new Error(`event_attendees[${kind}]: ${error.message}`);
  return count || 0;
}

async function loadEventCounts(eventId) {
  const [vragenlijst, ingeschreven, gebeld] = await Promise.all([
    countAttendeeMetric(eventId, 'vragenlijst_ingevuld'),
    countAttendeeMetric(eventId, 'ingeschreven'),
    countAttendeeMetric(eventId, 'gebeld'),
  ]);
  return { vragenlijst_ingevuld: vragenlijst, ingeschreven, gebeld };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requirePermission(req, 'dashboard.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (dashboard.module.access)' });
  }

  const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 5));
  const nowIso = new Date().toISOString();

  try {
    // Eerstkomende N events — published, starts_at >= nu.
    const { data: events, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, capacity, status')
      .eq('status', 'published')
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true })
      .limit(limit);
    if (evErr) throw new Error('events: ' + evErr.message);

    if (!events || events.length === 0) {
      return res.status(200).json({ events: [] });
    }

    // Per event N=3 count-queries parallel. Bij N events = 3N queries; blijft
    // ruim onder 60s Vercel-timeout bij limit=5 (15 queries totaal).
    const withCounts = await Promise.all(events.map(async (ev) => {
      try {
        const counts = await loadEventCounts(ev.id);
        return {
          id: ev.id,
          title: ev.title,
          starts_at: ev.starts_at,
          ends_at: ev.ends_at,
          location: ev.location,
          capacity: ev.capacity,
          counts,
          seats_remaining: Math.max(0, (ev.capacity || 0) - counts.vragenlijst_ingevuld),
          deep_link: `/modules/events-detail.html?id=${ev.id}`,
        };
      } catch (e) {
        // Één event dat crasht mag niet de hele lijst breken. Log + skip.
        console.warn(`[super-admin-events-status] event ${ev.id}: ${e?.message}`);
        return {
          id: ev.id,
          title: ev.title,
          starts_at: ev.starts_at,
          ends_at: ev.ends_at,
          location: ev.location,
          capacity: ev.capacity,
          counts: { vragenlijst_ingevuld: null, ingeschreven: null, gebeld: null },
          seats_remaining: null,
          deep_link: `/modules/events-detail.html?id=${ev.id}`,
          error: e?.message || 'unknown',
        };
      }
    }));

    return res.status(200).json({ events: withCounts });
  } catch (e) {
    console.error('[super-admin-events-status]', e?.message || e);
    return res.status(500).json({ error: 'Events-status-fetch mislukt', detail: e?.message });
  }
}
