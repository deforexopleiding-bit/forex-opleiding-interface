// api/events-attendee-audit-log.js
// GET -> audit-trail van een deelnemer (event_attendee_audit_log).
//
// Permission: events.audit.view.
//
// Query-params:
//   attendee_id  uuid    (verplicht)
//   limit        int, default 50, clamp 1..200
//   before       ISO     (optioneel — paginatie cursor; alleen rijen met at < before)
//
// Response:
//   {
//     items: [
//       { id, action, before_state, after_state, at, by_user_id, by_user: { email, full_name } | null }
//     ],
//     limit, next_before
//   }
//
// Sortering: at DESC (nieuwste eerst).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'events.audit.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.audit.view)' });
  }

  const q = req.query || {};
  const attendeeId = q.attendee_id ? String(q.attendee_id) : null;
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }

  const limit  = clampInt(q.limit, 50, 1, 200);
  const before = q.before ? String(q.before) : null;
  if (before) {
    const d = new Date(before);
    if (!Number.isFinite(d.getTime())) {
      return res.status(400).json({ error: 'before moet ISO 8601 datetime zijn' });
    }
  }

  try {
    let query = supabaseAdmin
      .from('event_attendee_audit_log')
      .select('id, attendee_id, action, before_state, after_state, at, by_user_id')
      .eq('attendee_id', attendeeId)
      .order('at', { ascending: false })
      .limit(limit);
    if (before) query = query.lt('at', before);

    const { data: rows, error } = await query;
    if (error) throw new Error('audit-log: ' + error.message);

    // by_user joinen via profiles (auth.users is niet rechtstreeks select-baar).
    const userIds = Array.from(new Set((rows || []).map((r) => r.by_user_id).filter((x) => x)));
    const profileById = new Map();
    if (userIds.length > 0) {
      try {
        const { data: profiles, error: profErr } = await supabaseAdmin
          .from('profiles')
          .select('id, email, full_name')
          .in('id', userIds);
        if (profErr) console.error('[events-attendee-audit-log profiles]', profErr.message);
        else for (const p of profiles || []) profileById.set(p.id, p);
      } catch (e) {
        console.error('[events-attendee-audit-log profiles ex]', e.message);
      }
    }

    const items = (rows || []).map((r) => {
      const prof = r.by_user_id ? profileById.get(r.by_user_id) : null;
      return {
        id:           r.id,
        action:       r.action,
        before_state: r.before_state,
        after_state:  r.after_state,
        at:           r.at,
        by_user_id:   r.by_user_id,
        by_user:      prof ? { email: prof.email || null, full_name: prof.full_name || null } : null,
      };
    });

    const nextBefore = items.length === limit ? items[items.length - 1].at : null;

    return res.status(200).json({ items, limit, next_before: nextBefore });
  } catch (e) {
    console.error('[events-attendee-audit-log]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
