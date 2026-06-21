// api/mentor-payout-settings-get.js
//
// GET ?mentor_user_id=uuid → payout-instellingen + vaste maandposten van
// één mentor. Admin-only (finance/strateeg).
//
// Permission: mentor.payout.manage.
//
// Response 200:
//   { ok, mentor_user_id,
//     config:    { travel_enabled, travel_day_rate_incl },
//     recurring: [ { id, label, amount_incl, active }, ... ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const mentorUserId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim()
    : '';
  if (!mentorUserId || !UUID_RE.test(mentorUserId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) vereist' });
  }

  try {
    const [{ data: cfg, error: cfgErr }, { data: recRows, error: recErr }] = await Promise.all([
      supabaseAdmin
        .from('mentor_payout_config')
        .select('travel_enabled, travel_day_rate_incl')
        .eq('mentor_user_id', mentorUserId)
        .maybeSingle(),
      supabaseAdmin
        .from('mentor_recurring_items')
        .select('id, label, amount_incl, active')
        .eq('mentor_user_id', mentorUserId)
        .order('label', { ascending: true }),
    ]);
    if (cfgErr) throw new Error('config fetch: ' + cfgErr.message);
    if (recErr) throw new Error('recurring fetch: ' + recErr.message);

    return res.status(200).json({
      ok            : true,
      mentor_user_id: mentorUserId,
      config: {
        travel_enabled       : !!cfg?.travel_enabled,
        travel_day_rate_incl : Number(cfg?.travel_day_rate_incl) || 0,
      },
      recurring: (recRows || []).map((r) => ({
        id          : r.id,
        label       : String(r.label || ''),
        amount_incl : Number(r.amount_incl) || 0,
        active      : !!r.active,
      })),
    });
  } catch (e) {
    console.error('[mentor-payout-settings-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
