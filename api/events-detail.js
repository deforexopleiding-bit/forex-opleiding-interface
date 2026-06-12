// api/events-detail.js
// GET -> volledige event-detail incl. mentor-count + attendee-counts per status.
//
// Permission: events.event.view.
//
// Query: ?id=<uuid>  (verplicht)
//
// Response:
//   {
//     event: { ...event-row, niveau_label },
//     counts: {
//       mentors:        <int>,
//       attendees_total: <int>,
//       byStatus: { aangemeld, aanwezig, no_show, sale, switched_to_other_event },
//       active:          <int>  (aangemeld + aanwezig + sale),
//       seats_remaining: <int>  (capacity - active)
//     }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_KEYS = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event'];
const ACTIVE_KEYS = ['aangemeld', 'aanwezig', 'sale'];

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

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events')
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
        ghl_sync_status, ghl_last_synced_at,
        signups_closed, signups_closed_at, signups_closed_reason, signups_closed_by_user_id,
        created_by_user_id, created_at, updated_at,
        event_niveau_options:niveau ( slug, label )
      `)
      .eq('id', id)
      .maybeSingle();
    if (evErr) throw new Error('event: ' + evErr.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    const niveauLabel = ev.event_niveau_options?.label || null;

    // Mentor-count
    let mentorCount = 0;
    try {
      const { count } = await supabaseAdmin
        .from('event_mentors')
        .select('event_id', { count: 'exact', head: true })
        .eq('event_id', id);
      mentorCount = typeof count === 'number' ? count : 0;
    } catch (e) {
      console.error('[events-detail mentor-count]', e.message);
    }

    // Attendee-count per status (5 parallelle counts)
    const byStatus = { aangemeld: 0, aanwezig: 0, no_show: 0, sale: 0, switched_to_other_event: 0 };
    try {
      await Promise.all(STATUS_KEYS.map(async (s) => {
        const { count, error } = await supabaseAdmin
          .from('event_attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', id)
          .eq('status', s);
        if (error) { console.error('[events-detail status-count]', s, error.message); return; }
        byStatus[s] = typeof count === 'number' ? count : 0;
      }));
    } catch (e) {
      console.error('[events-detail byStatus]', e.message);
    }

    let totalAttendees = 0;
    try {
      const { count } = await supabaseAdmin
        .from('event_attendees')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', id);
      totalAttendees = typeof count === 'number' ? count : 0;
    } catch (e) {
      console.error('[events-detail total-attendees]', e.message);
    }

    const active = ACTIVE_KEYS.reduce((sum, k) => sum + (byStatus[k] || 0), 0);
    const seatsRemaining = Math.max(0, (ev.capacity || 0) - active);

    return res.status(200).json({
      event: {
        id:                        ev.id,
        title:                     ev.title,
        starts_at:                 ev.starts_at,
        ends_at:                   ev.ends_at,
        location:                  ev.location,
        capacity:                  ev.capacity,
        status:                    ev.status,
        niveau:                    ev.niveau,
        niveau_label:              niveauLabel,
        description_md:            ev.description_md,
        webflow_item_id:           ev.webflow_item_id,
        webflow_sync_status:       ev.webflow_sync_status,
        webflow_last_synced_at:    ev.webflow_last_synced_at,
        ghl_sync_status:           ev.ghl_sync_status,
        ghl_last_synced_at:        ev.ghl_last_synced_at,
        signups_closed:            ev.signups_closed === true,
        signups_closed_at:         ev.signups_closed_at,
        signups_closed_reason:     ev.signups_closed_reason,
        signups_closed_by_user_id: ev.signups_closed_by_user_id,
        created_by_user_id:        ev.created_by_user_id,
        created_at:                ev.created_at,
        updated_at:                ev.updated_at,
      },
      counts: {
        mentors:         mentorCount,
        attendees_total: totalAttendees,
        byStatus,
        active,
        seats_remaining: seatsRemaining,
      },
    });
  } catch (e) {
    console.error('[events-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
