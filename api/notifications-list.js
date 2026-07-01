// api/notifications-list.js
//
// GET — eigen meldingen-lijst voor de ingelogde user. Hard self-scoped op
// .eq('user_id', user.id) — niemand ziet andermans meldingen, ongeacht rol.
//
// Auth: createUserClient + getUser → 401 als geen user.
// GEEN requirePermission-gate: meldingen zijn er voor iedereen die ingelogd is.
//
// Querystring:
//   ?filter=unread   → alleen rijen waar read_at IS NULL.
//   ?filter=all      → default (alle eigen meldingen).
//   ?type=<slug>     → optioneel: filter op notification.type (bv.
//                      'onboarding.admin_note'). Precieze match, geen wildcard.
//                      Gebruikt door mentor-pagina's om per-student admin-note
//                      dots te vullen zonder alle types op te halen.
//
// Sortering: ongelezen eerst (read_at IS NULL), dan created_at desc.
// Cap: 50.
//
// Response 200: {
//   notifications: [{
//     id, type, title, body, link_url, entity_type, entity_id,
//     priority, created_at, read_at,
//     onboarding_bubble_user_id  // aanvullend voor entity_type='onboarding'
//                                 // (best-effort enrichment; null bij lookup-fail).
//   }],
//   unread_count
// }

import { createUserClient, supabaseAdmin } from './supabase.js';

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

  const q = (req.query && typeof req.query === 'object') ? req.query : {};
  const filter = (typeof q.filter === 'string' && q.filter.trim()) ? q.filter.trim().toLowerCase() : 'all';
  const typeFilter = (typeof q.type === 'string' && q.type.trim()) ? q.type.trim() : null;

  try {
    // SELF-only — supabaseAdmin maar met expliciete eq('user_id', user.id).
    // Een user mag NOOIT andermans rij zien; server-side gefilterd.
    let listQuery = supabaseAdmin
      .from('notifications')
      .select('id, type, title, body, link_url, entity_type, entity_id, priority, created_at, read_at')
      .eq('user_id', user.id)
      // Ongelezen eerst (NULLS FIRST), daarbinnen newest-first op created_at.
      .order('read_at',    { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(50);
    if (filter === 'unread') {
      listQuery = listQuery.is('read_at', null);
    }
    if (typeFilter) {
      listQuery = listQuery.eq('type', typeFilter);
    }
    const { data: rows, error: listErr } = await listQuery;
    if (listErr) throw new Error('notifications fetch: ' + listErr.message);

    // Best-effort enrichment: voor entity_type='onboarding' rijen erbij
    // opzoeken van onboardings.bubble_user_id, zodat clients (mentor-students)
    // een bubble_user_id → count map kunnen bouwen zonder extra endpoint.
    // Fail-soft: bij lookup-fout worden de velden simpelweg null.
    const enriched = Array.isArray(rows) ? rows.slice() : [];
    const onboardingIds = Array.from(new Set(
      enriched
        .filter((n) => n && n.entity_type === 'onboarding' && n.entity_id)
        .map((n) => n.entity_id)
    ));
    if (onboardingIds.length > 0) {
      try {
        const { data: obRows, error: obErr } = await supabaseAdmin
          .from('onboardings')
          .select('id, bubble_user_id')
          .in('id', onboardingIds);
        if (obErr) {
          console.warn('[notifications-list] onboarding enrich fail:', obErr.message);
        } else {
          const bubbleByOnb = new Map();
          for (const row of (obRows || [])) {
            if (row && row.id) bubbleByOnb.set(row.id, row.bubble_user_id || null);
          }
          for (const n of enriched) {
            if (n && n.entity_type === 'onboarding' && n.entity_id) {
              n.onboarding_bubble_user_id = bubbleByOnb.get(n.entity_id) || null;
            }
          }
        }
      } catch (e) {
        console.warn('[notifications-list] onboarding enrich exception:', e?.message || e);
      }
    }

    // Aparte head-count voor ongelezen-teller — onafhankelijk van filter.
    const { count, error: cntErr } = await supabaseAdmin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null);
    if (cntErr) throw new Error('unread count: ' + cntErr.message);

    return res.status(200).json({
      notifications: enriched,
      unread_count:  count || 0,
    });
  } catch (e) {
    console.error('[notifications-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
