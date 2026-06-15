// api/team-member-link-user.js
// POST -> koppel een team_members-rij aan een auth.users-rij (team_members.user_id).
// Nodig voor F5.1 mentor-grootboek: ledger-entries hangen aan auth.user_id zodat
// de mentor met z'n eigen login z'n bonuspot kan inzien.
//
// Permission: events.team_member.link (admin-gevoelig — koppelt identity).
//
// Body (JSON):
//   { team_member_id: uuid, user_id: uuid | null }
//   user_id=null = wist de koppeling.
//
// Response 200: { ok, team_member_id, user_id }
// 400 validatie | 401/403 auth | 404 team_member of user niet gevonden |
// 409 user_id al gekoppeld aan een andere team_member | 500 DB-fout
//
// Voor de unique partial index `idx_team_members_user_id WHERE user_id IS NOT NULL`
// vangen we 23505 als duidelijke 409 (i.p.v. opaque 500).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'events.team_member.link'))) {
    return res.status(403).json({ error: 'Geen rechten (events.team_member.link)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const tmId = typeof body.team_member_id === 'string' ? body.team_member_id.trim() : '';
  if (!tmId || !UUID_RE.test(tmId)) {
    return res.status(400).json({ error: 'team_member_id (uuid) vereist' });
  }

  let newUserId = null;
  if (body.user_id != null && String(body.user_id).trim() !== '') {
    newUserId = String(body.user_id).trim();
    if (!UUID_RE.test(newUserId)) {
      return res.status(400).json({ error: 'user_id moet uuid of null zijn' });
    }
  }

  try {
    // 1) team_member bestaat
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('id, name, user_id')
      .eq('id', tmId)
      .maybeSingle();
    if (tmErr) throw new Error('team_member fetch: ' + tmErr.message);
    if (!tm) return res.status(404).json({ error: 'team_member niet gevonden' });

    // 2) Bij niet-null: user bestaat en is actief
    if (newUserId) {
      const { data: prof, error: profErr } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, is_active')
        .eq('id', newUserId)
        .maybeSingle();
      if (profErr) throw new Error('profile fetch: ' + profErr.message);
      if (!prof) return res.status(404).json({ error: 'user_id niet gevonden in profiles' });
      if (prof.is_active === false) {
        return res.status(400).json({ error: 'gebruiker is inactief' });
      }
    }

    // 3) Update
    const { data: upd, error: updErr } = await supabaseAdmin
      .from('team_members')
      .update({ user_id: newUserId })
      .eq('id', tmId)
      .select('id, user_id')
      .maybeSingle();
    if (updErr) {
      if (updErr.code === '23505' || /duplicate key/i.test(updErr.message || '')) {
        return res.status(409).json({
          error: 'user_id is al gekoppeld aan een andere team_member',
          code: 'USER_ALREADY_LINKED',
        });
      }
      console.error('[team-member-link-user] update', updErr.message);
      return res.status(500).json({ error: 'opslaan faalde', detail: updErr.message });
    }

    return res.status(200).json({
      ok            : true,
      team_member_id: upd.id,
      user_id       : upd.user_id,
    });
  } catch (e) {
    console.error('[team-member-link-user]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
