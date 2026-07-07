// api/activity-users-list.js
//
// PR2 activiteitenlogboek — per-gebruiker overzicht voor het viewer-scherm.
// Combineert user_last_activity (login/actief snapshot) met een actie-count
// per user uit activity_log. Sorteert op last_activity_at desc.
//
// Auth: 'audit.log.view'.
// Response: { users: [{ user_id, user_email, user_role, last_login_at,
//             last_activity_at, last_ip, action_count }] }
//
// Verrijking user_role: leest uit profiles (fail-soft) omdat user_last_activity
// zelf geen rol-snapshot heeft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const userSb = createUserClient(req);
  const { data: { user } } = await userSb.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'audit.log.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (audit.log.view)' });

  try {
    // 1) Snapshot per user.
    const { data: snap, error: snapErr } = await supabaseAdmin
      .from('user_last_activity')
      .select('user_id, user_email, last_login_at, last_activity_at, last_ip')
      .order('last_activity_at', { ascending: false });
    if (snapErr) {
      console.error('[activity-users-list] user_last_activity', snapErr.message);
      return res.status(500).json({ error: 'DB-fout bij ophalen snapshot' });
    }

    const rows = snap || [];
    if (rows.length === 0) return res.status(200).json({ users: [] });

    const userIds = rows.map((r) => r.user_id).filter(Boolean);

    // 2) Rol per user (fail-soft — email fallback als profiel weg is).
    const roleByUser = new Map();
    if (userIds.length > 0) {
      const { data: profs } = await supabaseAdmin
        .from('profiles')
        .select('id, role, email')
        .in('id', userIds);
      (profs || []).forEach((p) => {
        if (p?.id) roleByUser.set(p.id, { role: p.role || null, email: p.email || null });
      });
    }

    // 3) Actie-count per user. activity_log kan groot zijn — één query met
    //    count-per-user via head+count doet niet direct group-by; we lezen
    //    de user_id-kolom voor de bekende userIds en tellen zelf. Voor het
    //    verwachte volume (tientallen users × dagelijks logs) prima. Bij
    //    schaal-issue kan hier een DB-view of RPC voor komen.
    const countByUser = new Map();
    if (userIds.length > 0) {
      const { data: acts, error: actErr } = await supabaseAdmin
        .from('activity_log')
        .select('user_id')
        .in('user_id', userIds)
        .limit(50000); // veiligheids-cap; 90d retention houdt volume beperkt
      if (actErr) {
        console.warn('[activity-users-list] activity_log count', actErr.message);
      } else {
        (acts || []).forEach((a) => {
          if (!a?.user_id) return;
          countByUser.set(a.user_id, (countByUser.get(a.user_id) || 0) + 1);
        });
      }
    }

    const users = rows.map((r) => {
      const prof = roleByUser.get(r.user_id) || {};
      return {
        user_id          : r.user_id,
        user_email       : r.user_email || prof.email || null,
        user_role        : prof.role || null,
        last_login_at    : r.last_login_at,
        last_activity_at : r.last_activity_at,
        last_ip          : r.last_ip,
        action_count     : countByUser.get(r.user_id) || 0,
      };
    });

    return res.status(200).json({ users });
  } catch (e) {
    console.error('[activity-users-list] exception', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
