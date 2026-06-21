// api/mentor-payout-config-set.js
//
// POST → upsert mentor_payout_config voor één mentor (admin-only).
//
// Permission: mentor.payout.manage.
//
// Body:
//   { mentor_user_id, travel_enabled, travel_day_rate_incl (>=0) }
//
// Niet-definitieve concepten worden bewust NIET hier hercalculeerd — de admin
// past instellingen aan en draait daarna handmatig "Genereer rapporten" om
// nieuwe snapshots te maken (transparante flow). Voor adjustment-save/-delete
// is dat anders (zie die endpoints).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const mentorUserId = typeof body.mentor_user_id === 'string' ? body.mentor_user_id.trim() : '';
  if (!mentorUserId || !UUID_RE.test(mentorUserId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) vereist' });
  }
  const travelEnabled = !!body.travel_enabled;
  const rateRaw       = body.travel_day_rate_incl;
  const rate          = round2(rateRaw);
  if (!Number.isFinite(rate) || rate < 0) {
    return res.status(400).json({ error: 'travel_day_rate_incl moet >= 0 zijn' });
  }

  try {
    const upsertRow = {
      mentor_user_id        : mentorUserId,
      travel_enabled        : travelEnabled,
      travel_day_rate_incl  : rate,
      updated_by            : user.id,
    };
    const { data, error } = await supabaseAdmin
      .from('mentor_payout_config')
      .upsert(upsertRow, { onConflict: 'mentor_user_id' })
      .select('travel_enabled, travel_day_rate_incl')
      .single();
    if (error) throw new Error('config upsert: ' + error.message);

    return res.status(200).json({
      ok: true,
      config: {
        travel_enabled       : !!data.travel_enabled,
        travel_day_rate_incl : Number(data.travel_day_rate_incl) || 0,
      },
    });
  } catch (e) {
    console.error('[mentor-payout-config-set]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
