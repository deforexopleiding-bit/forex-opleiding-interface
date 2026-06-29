// api/mentor-notifications-list.js
//
// GET — self-only meldingen-lijst voor de ingelogde mentor. Geen scope-param;
// hard gefilterd op mentor_user_id = user.id zodat een mentor NOOIT andermans
// meldingen kan zien.
//
// Permission: mentor.module.access.
//
// Sortering: ongelezen eerst (read_at IS NULL), dan created_at desc.
// Cap: 50.
//
// Response 200: {
//   notifications: [{
//     id, onboarding_id, kind, title, body,
//     created_by, created_at, read_at
//   }],
//   unread_count
// }

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    // SELF-only — supabaseAdmin maar met expliciete eq('mentor_user_id', user.id).
    // Een mentor mag NOOIT andermans rij zien; server-side gefilterd.
    const { data: rows, error: listErr } = await supabaseAdmin
      .from('mentor_notifications')
      .select('id, onboarding_id, kind, title, body, created_by, created_at, read_at')
      .eq('mentor_user_id', user.id)
      // Ongelezen eerst — Postgres NULLS FIRST is precies wat we willen voor
      // read_at, en daarbinnen newest-first op created_at.
      .order('read_at',    { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(50);
    if (listErr) throw new Error('notifications fetch: ' + listErr.message);

    const list = rows || [];

    // Verrijk met onboarding.bubble_user_id + customer_name zodat de frontend
    // ongelezen-badges op "Mijn studenten" (bubble-keyed) + "Toekomstige
    // studenten" (onboarding-keyed) rijen kan plaatsen zonder een tweede call.
    const obIds = Array.from(new Set(list.map((r) => r.onboarding_id).filter(Boolean)));
    const obMap = new Map();
    if (obIds.length > 0) {
      const { data: obs, error: obErr } = await supabaseAdmin
        .from('onboardings')
        .select('id, bubble_user_id, customer_name')
        .in('id', obIds);
      if (obErr) {
        console.warn('[mentor-notifications-list] onboarding lookup (soft):', obErr.message);
      } else {
        for (const o of (obs || [])) obMap.set(o.id, o);
      }
    }
    const enriched = list.map((r) => {
      const ob = r.onboarding_id ? obMap.get(r.onboarding_id) : null;
      return {
        ...r,
        onboarding_bubble_user_id: ob?.bubble_user_id || null,
        onboarding_customer_name:  ob?.customer_name  || null,
      };
    });

    const unread_count = enriched.reduce((n, r) => n + (r.read_at == null ? 1 : 0), 0);
    return res.status(200).json({ notifications: enriched, unread_count });
  } catch (e) {
    console.error('[mentor-notifications-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
