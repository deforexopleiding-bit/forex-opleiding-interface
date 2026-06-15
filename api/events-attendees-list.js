// api/events-attendees-list.js
// GET -> paginated lijst van deelnemers per event, incl. tags-array per attendee.
//
// Permission: events.attendee.view.
//
// Query-params:
//   event_id  uuid (verplicht)
//   status    CSV optional (aangemeld|aanwezig|no_show|sale|switched_to_other_event)
//   q         text optional (ILIKE op first_name / last_name / email)
//   limit     int, default 100, clamp 1..500
//   offset    int, default 0
//
// Response:
//   {
//     items: [
//       {
//         id, event_id, first_name, last_name, email, phone, status,
//         customer_id, deal_id, subscription_id,
//         ghl_contact_id, ghl_form_submission_id, assessment_response_id,
//         switched_from_event_id, switched_at,
//         registered_at, attended_at, no_show_marked_at, sale_at,
//         follow_up_flagged, follow_up_reason,
//         created_at, updated_at,
//         tags: [ { slug, label, color, source } ]
//       }, ...
//     ],
//     total, limit, offset,
//     counts: { byStatus: { aangemeld, aanwezig, no_show, sale, switched_to_other_event } }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event'];

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function parseCsv(raw) {
  if (raw == null) return [];
  return String(raw).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
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
  if (!(await requirePermission(req, 'events.attendee.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.view)' });
  }

  const q = req.query || {};
  const eventId = q.event_id ? String(q.event_id) : null;
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }

  const statusList = parseCsv(q.status).map((s) => s.toLowerCase());
  const invalidStatus = statusList.filter((s) => !VALID_STATUS.includes(s));
  if (invalidStatus.length > 0) {
    return res.status(400).json({
      error: `Ongeldige status: ${invalidStatus.join(',')}; verwacht ${VALID_STATUS.join('|')}`,
    });
  }

  const search = q.q ? String(q.q).trim() : null;
  const limit  = clampInt(q.limit, 100, 1, 500);
  const offset = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  try {
    let query = supabaseAdmin
      .from('event_attendees')
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, subscription_id,
        ghl_contact_id, ghl_form_submission_id, assessment_response_id,
        switched_from_event_id, switched_at,
        registered_at, attended_at, no_show_marked_at, sale_at,
        follow_up_flagged, follow_up_reason, called_at,
        created_at, updated_at
      `, { count: 'exact' })
      .eq('event_id', eventId)
      .order('registered_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (statusList.length === 1) query = query.eq('status', statusList[0]);
    else if (statusList.length > 1) query = query.in('status', statusList);

    if (search) {
      const safe = search.replace(/[%,]/g, '');
      if (safe.length > 0) {
        const pattern = `*${safe}*`;
        query = query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
      }
    }

    const { data: rows, error, count } = await query;
    if (error) throw new Error('attendees-list: ' + error.message);

    // Tags per attendee (1 query met IN-clause + groepering in JS).
    const ids = (rows || []).map((r) => r.id);
    const tagsByAttendee = new Map();
    if (ids.length > 0) {
      const { data: tagRows, error: tagErr } = await supabaseAdmin
        .from('event_attendee_tags')
        .select('attendee_id, tag_slug, source, added_at, event_tags_catalog:tag_slug ( slug, label, color )')
        .in('attendee_id', ids);
      if (tagErr) {
        console.error('[events-attendees-list tags]', tagErr.message);
      } else {
        for (const t of tagRows || []) {
          const list = tagsByAttendee.get(t.attendee_id) || [];
          const cat = t.event_tags_catalog || {};
          list.push({
            slug:   t.tag_slug,
            label:  cat.label || t.tag_slug,
            color:  cat.color || null,
            source: t.source,
            added_at: t.added_at,
          });
          tagsByAttendee.set(t.attendee_id, list);
        }
      }
    }

    const items = (rows || []).map((r) => ({
      ...r,
      tags: tagsByAttendee.get(r.id) || [],
    }));

    // byStatus counts (zonder paginatie, zonder status-filter, met search).
    const byStatus = { aangemeld: 0, aanwezig: 0, no_show: 0, sale: 0, switched_to_other_event: 0 };
    try {
      await Promise.all(VALID_STATUS.map(async (s) => {
        let cq = supabaseAdmin
          .from('event_attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId)
          .eq('status', s);
        if (search) {
          const safe = search.replace(/[%,]/g, '');
          if (safe.length > 0) {
            const pattern = `*${safe}*`;
            cq = cq.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
          }
        }
        const { count: c, error: ce } = await cq;
        if (ce) { console.error('[events-attendees-list count', s, ']', ce.message); return; }
        byStatus[s] = typeof c === 'number' ? c : 0;
      }));
    } catch (e) {
      console.error('[events-attendees-list byStatus]', e.message);
    }

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({
      items, total, limit, offset,
      counts: { byStatus },
    });
  } catch (e) {
    console.error('[events-attendees-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
