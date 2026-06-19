// api/mentor-bubble-link.js
// POST -> koppel/ontkoppel team_members.bubble_user_id (mirror van
// team-member-link-user.js, alleen tegen de Bubble-id i.p.v. auth.users-uuid).
//
// Permission: events.team_member.link (zelfde admin-gevoelige key).
//
// Body (JSON):
//   { team_member_id: uuid, bubble_user_id: string | null }
//   bubble_user_id=null = wist de koppeling.
//
// Response 200: { ok, team_member_id, bubble_user_id }
// 400 validatie | 401/403 auth |
// 404 team_member of bubble-User niet gevonden |
// 409 bubble_user_id al gekoppeld aan andere team_member |
// 502 bubble-API fout | 503 bubble-config ontbreekt | 500 anders.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleGet } from './_lib/bubble.js';

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

  let newBubbleId = null;
  if (body.bubble_user_id != null && String(body.bubble_user_id).trim() !== '') {
    newBubbleId = String(body.bubble_user_id).trim();
    if (newBubbleId.length > 256) {
      return res.status(400).json({ error: 'bubble_user_id te lang' });
    }
  }

  try {
    // 1) team_member bestaat
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('id, name, bubble_user_id')
      .eq('id', tmId)
      .maybeSingle();
    if (tmErr) throw new Error('team_member fetch: ' + tmErr.message);
    if (!tm) return res.status(404).json({ error: 'team_member niet gevonden' });

    // 2) Bij niet-null: bubble-User bestaat (validatie tegen typo's)
    if (newBubbleId) {
      try {
        const bubbleUser = await bubbleGet('user', newBubbleId);
        if (!bubbleUser) {
          return res.status(404).json({ error: 'bubble_user_id niet gevonden bij Bubble' });
        }
      } catch (e) {
        if (e?.code === 'BUBBLE_CONFIG_MISSING') {
          return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
        }
        if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
          return res.status(502).json({ error: 'Bubble-validatie faalde: ' + e.message });
        }
        throw e;
      }
    }

    // 3) Update — vang 23505 voor de unique partial index als duidelijke 409.
    const { data: upd, error: updErr } = await supabaseAdmin
      .from('team_members')
      .update({ bubble_user_id: newBubbleId })
      .eq('id', tmId)
      .select('id, bubble_user_id')
      .maybeSingle();
    if (updErr) {
      if (updErr.code === '23505' || /duplicate key/i.test(updErr.message || '')) {
        return res.status(409).json({
          error: 'bubble_user_id is al gekoppeld aan een andere team_member',
          code: 'BUBBLE_USER_ALREADY_LINKED',
        });
      }
      console.error('[mentor-bubble-link] update', updErr.message);
      return res.status(500).json({ error: 'opslaan faalde', detail: updErr.message });
    }

    return res.status(200).json({
      ok            : true,
      team_member_id: upd.id,
      bubble_user_id: upd.bubble_user_id,
    });
  } catch (e) {
    console.error('[mentor-bubble-link]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
