// api/mentor-coaching-earnings.js
//
// GET → coaching-verdiensten v1: telt 1-op-1 sessies + team-trainingen +
// no-shows binnen een periode en rekent ze om naar bedragen (incl. btw).
// Read-only proxy op bubble.io.
//
// Dual-gate (consistent met andere mentor-endpoints):
//   - ?mentor_user_id=… → admin (mentor.admin.view, die id).
//   - afwezig            → self  (mentor.module.access, auth.uid()).
//
// Query:
//   from=YYYY-MM-DD, to=YYYY-MM-DD (inclusief). Default: huidige maand
//   (1e t/m laatste dag).
//
// Tarieven + telling: zie api/_lib/coaching-earnings.js — die helper is shared
// met mentor-payout-generate zodat rapport-cijfers exact matchen met wat de
// mentor op deze tab ziet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeCoachingEarnings, emptyBreakdown } from './_lib/coaching-earnings.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function firstOfMonthUtc(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = String(ref.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function lastOfMonthUtc(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0));
  const mm = String(last.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(last.getUTCDate()).padStart(2, '0');
  return `${last.getUTCFullYear()}-${mm}-${dd}`;
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

  // Dual-gate.
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  let scope;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
    scope = 'admin';
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
    scope = 'self';
  }

  // Datum-range.
  let from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
  let to   = typeof req.query?.to   === 'string' ? req.query.to.trim()   : '';
  if (!from || !DATE_RE.test(from)) from = firstOfMonthUtc();
  if (!to   || !DATE_RE.test(to))   to   = lastOfMonthUtc();
  if (from > to) return res.status(400).json({ error: 'from mag niet na to liggen' });

  const debugOn = req.query?.debug === '1';

  try {
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', effectiveUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(200).json({
        ok: true, scope, linked: false, from, to,
        breakdown: emptyBreakdown(),
        grand_total: 0,
      });
    }

    const result = await computeCoachingEarnings({
      bubbleUserId: tm.bubble_user_id,
      mentorUserId: effectiveUserId,
      from,
      to,
    });

    const payload = {
      ok: true,
      scope,
      linked: true,
      from,
      to,
      breakdown : result.breakdown,
      grand_total: result.grand_total,
    };

    if (debugOn) {
      payload.debug = {
        students_count   : result.students_count,
        sessions_fetched : result.sessions_fetched,
        teamCountRaw     : result.team_count_raw,
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[mentor-coaching-earnings]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
