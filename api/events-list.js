// api/events-list.js
// GET -> paginated lijst van events (workshops / live trainingen).
//
// Permission: events.event.view (zie FEATURE_REGISTRY in modules/admin.html).
//
// Query-params:
//   status   (CSV optional)  -> draft|published|cancelled|archived (case-insensitive)
//                               Default: 'draft,published' (alles wat NIET archived/cancelled is).
//   niveau   (text optional) -> slug uit event_niveau_options (basis|gevorderd)
//   q        (text optional) -> ILIKE op title / location
//   limit    (int, default 50, clamp 1..200)
//   offset   (int, default 0)
//
// Response:
//   {
//     items: [
//       {
//         id, title, starts_at, ends_at, location, capacity, status, niveau,
//         description_md,
//         webflow_sync_status, webflow_last_synced_at,
//         ghl_sync_status,     ghl_last_synced_at,
//         created_at, updated_at,
//         attendee_count_active   (= getConfirmedCount: status IN
//                                  ('aangemeld','aanwezig') AND
//                                  assessment_response_id IS NOT NULL —
//                                  Fase 1 capaciteits-regel),
//         attendee_count_total    (alle statussen),
//         seats_remaining
//       }, ...
//     ],
//     total, limit, offset
//   }
//
// Sortering: starts_at ASC (chronologisch — komende events bovenaan).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getConfirmedCount } from './_lib/event-registration.js';

const VALID_STATUS = ['draft', 'published', 'cancelled', 'archived'];

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
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  const q = req.query || {};

  // status CSV (default = draft + published — actieve werkitems)
  let statusList = parseCsv(q.status).map((s) => s.toLowerCase());
  if (statusList.length === 0) statusList = ['draft', 'published'];
  const invalidStatus = statusList.filter((s) => !VALID_STATUS.includes(s));
  if (invalidStatus.length > 0) {
    return res.status(400).json({
      error: `Ongeldige status: ${invalidStatus.join(',')}; verwacht ${VALID_STATUS.join('|')}`,
    });
  }

  const niveau = q.niveau ? String(q.niveau).trim().toLowerCase() : null;
  const search = q.q ? String(q.q).trim() : null;
  const limit  = clampInt(q.limit, 50, 1, 200);
  const offset = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  try {
    let query = supabaseAdmin
      .from('events')
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md,
        webflow_sync_status, webflow_last_synced_at,
        ghl_sync_status,     ghl_last_synced_at,
        signups_closed, signups_closed_at, signups_closed_reason,
        completed_at, completed_by,
        created_at, updated_at
      `, { count: 'exact' })
      .order('starts_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (statusList.length === 1) query = query.eq('status', statusList[0]);
    else query = query.in('status', statusList);

    if (niveau) query = query.eq('niveau', niveau);

    if (search) {
      const safe = search.replace(/[%,]/g, '');
      if (safe.length > 0) {
        const pattern = `*${safe}*`;
        query = query.or(`title.ilike.${pattern},location.ilike.${pattern}`);
      }
    }

    const { data: rows, error, count } = await query;
    if (error) throw new Error('events-list: ' + error.message);

    // Per event: tel actieve attendees + totaal. Twee parallelle counts.
    // active = getConfirmedCount = status IN ('aangemeld','aanwezig') AND
    // assessment_response_id IS NOT NULL (Fase 1 single source of truth voor
    // capaciteit). Eerder: ACTIVE_ATTENDEE_STATUSES ['aangemeld','aanwezig','sale']
    // zonder assessment-filter — dat is na deze fix de verkeerde regel; we
    // volgen voortaan getConfirmedCount.
    const items = await Promise.all((rows || []).map(async (row) => {
      let activeCount = 0;
      let totalCount = 0;
      try {
        activeCount = await getConfirmedCount(row.id);
      } catch (e) {
        console.error('[events-list active-count]', row.id, e.message);
      }
      try {
        const { count: t } = await supabaseAdmin
          .from('event_attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', row.id);
        totalCount = typeof t === 'number' ? t : 0;
      } catch (e) {
        console.error('[events-list total-count]', row.id, e.message);
      }
      return {
        id:                     row.id,
        title:                  row.title,
        starts_at:              row.starts_at,
        ends_at:                row.ends_at,
        location:               row.location,
        capacity:               row.capacity,
        status:                 row.status,
        niveau:                 row.niveau,
        description_md:         row.description_md,
        webflow_sync_status:    row.webflow_sync_status,
        webflow_last_synced_at: row.webflow_last_synced_at,
        ghl_sync_status:        row.ghl_sync_status,
        ghl_last_synced_at:     row.ghl_last_synced_at,
        signups_closed:         row.signups_closed === true,
        signups_closed_at:      row.signups_closed_at,
        signups_closed_reason:  row.signups_closed_reason,
        completed_at:           row.completed_at || null,
        completed_by:           row.completed_by || null,
        created_at:             row.created_at,
        updated_at:             row.updated_at,
        attendee_count_active:  activeCount,
        attendee_count_total:   totalCount,
        seats_remaining:        Math.max(0, (row.capacity || 0) - activeCount),
      };
    }));

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({ items, total, limit, offset });
  } catch (e) {
    console.error('[events-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
