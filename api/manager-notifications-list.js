// api/manager-notifications-list.js
//
// GET — manager-meldingen die door mentoren zijn ingeschoten bij probleem-
// statussen op een toegewezen onboarding. Spiegel van
// /api/mentor-notifications-list, maar dan voor de manager-kant.
//
// Permission-gate: seesAll (onboarding.admin / super_admin). Mentor → 403.
// Het is een gedeeld postvak voor de manager-rol; niet self-scoped per user.
//
// Sortering: ongelezen eerst (read_at IS NULL), dan created_at desc.
// Cap: 100.
//
// Response 200: {
//   notifications: [{
//     id, onboarding_id, kind, status, title, body,
//     customer_name, mentor_user_id, mentor_name,
//     created_by, created_at, read_at, read_by
//   }],
//   unread_count
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

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

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  try {
    const { data: rows, error: listErr } = await supabaseAdmin
      .from('manager_notifications')
      .select('id, onboarding_id, kind, status, title, body, customer_name, mentor_user_id, created_by, created_at, read_at, read_by')
      .order('read_at',    { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(100);
    if (listErr) throw new Error('manager_notifications fetch: ' + listErr.message);

    const list = rows || [];

    // Mentor-naam batched uit team_members per uniek mentor_user_id.
    const mentorIds = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const nameByUid = new Map();
    if (mentorIds.length > 0) {
      try {
        const { data: tms, error: tmErr } = await supabaseAdmin
          .from('team_members')
          .select('user_id, name')
          .in('user_id', mentorIds);
        if (tmErr) {
          console.warn('[manager-notifications-list] team_members lookup (soft):', tmErr.message);
        } else {
          for (const r of (tms || [])) if (r.user_id && r.name) nameByUid.set(r.user_id, r.name);
        }
      } catch (e) {
        console.warn('[manager-notifications-list] team_members exception (soft):', e?.message || e);
      }
    }

    const enriched = list.map((r) => ({
      ...r,
      mentor_name: r.mentor_user_id ? (nameByUid.get(r.mentor_user_id) || null) : null,
    }));

    const unread_count = enriched.reduce((n, r) => n + (r.read_at == null ? 1 : 0), 0);
    return res.status(200).json({ notifications: enriched, unread_count });
  } catch (e) {
    console.error('[manager-notifications-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
