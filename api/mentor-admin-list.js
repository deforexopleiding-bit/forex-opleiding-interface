// api/mentor-admin-list.js
//
// GET → lijst van mentor-accounts (auth-user-id + team_member info) voor de
// admin-picker op mentor-detail.html. Gate: mentor.admin.view.
//
// Bron-van-waarheid voor 'is mentor': user_roles.role='mentor'. Per user_id
// proberen we 1 actieve team_members-rij erbij te joinen (voor naam/avatar);
// users zonder team_members-koppeling worden NIET weggefilterd zodat de
// picker ze toch toont (met email als fallback-label).
//
// Response 200:
//   { ok: true, mentors: [
//       { user_id, team_member_id?, name?, email?, avatar_emoji?, avatar_color?, role? }, ...
//   ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  if (!(await requirePermission(req, 'mentor.admin.view'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
  }

  try {
    // 1) Alle user_ids met rol 'mentor'.
    const { data: roleRows, error: rolesErr } = await supabaseAdmin
      .from('user_roles')
      .select('user_id')
      .eq('role', 'mentor');
    if (rolesErr) throw new Error('mentor-roles fetch: ' + rolesErr.message);
    const userIds = [...new Set((roleRows || []).map((r) => r.user_id).filter(Boolean))];
    if (userIds.length === 0) return res.status(200).json({ ok: true, mentors: [] });

    // 2) Team_members per user_id (actieve rij wint).
    const { data: tms, error: tmsErr } = await supabaseAdmin
      .from('team_members')
      .select('id, name, role, type, email, avatar_emoji, avatar_color, is_active, user_id')
      .in('user_id', userIds);
    if (tmsErr) throw new Error('team_members fetch: ' + tmsErr.message);

    const byUserId = new Map();
    for (const tm of tms || []) {
      const prev = byUserId.get(tm.user_id);
      if (!prev || (tm.is_active !== false && prev.is_active === false)) {
        byUserId.set(tm.user_id, tm);
      }
    }

    // 3) Profiles voor de overige fallback (email/full_name).
    const { data: profs, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name')
      .in('id', userIds);
    if (profErr) console.error('[mentor-admin-list] profiles fetch:', profErr.message);
    const profById = new Map();
    for (const p of profs || []) profById.set(p.id, p);

    const mentors = userIds.map((uid) => {
      const tm   = byUserId.get(uid) || null;
      const prof = profById.get(uid) || null;
      return {
        user_id        : uid,
        team_member_id : tm?.id || null,
        name           : tm?.name || prof?.full_name || prof?.email || null,
        email          : tm?.email || prof?.email || null,
        role           : tm?.role || null,
        avatar_emoji   : tm?.avatar_emoji || null,
        avatar_color   : tm?.avatar_color || null,
      };
    }).sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));

    return res.status(200).json({ ok: true, mentors });
  } catch (e) {
    console.error('[mentor-admin-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
