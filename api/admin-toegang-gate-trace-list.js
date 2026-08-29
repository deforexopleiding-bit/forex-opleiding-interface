// api/admin-toegang-gate-trace-list.js
//
// Super_admin-gated read endpoint. Retourneert de laatste N rijen uit
// follow_up_events_log waar event_type='toegang-gate-trace' — d.w.z.
// de beslissings-trace van follow-up-ghl-conversation-webhook voor
// elke inbound WA (per bericht 1 rij met stages: handler-received,
// gate-enter, gate-lookup, gate-match, provisioning-call, gate-exception).
//
// Zodat je NIET afhankelijk bent van Vercel-logs voor debug van de
// toegang-gate: zelfde-info via CRM-console.
//
// GET  ?limit=20  (max 100)
//
// Auth: super_admin JWT Bearer.
// 0 incasso-writes.

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('id, role, is_active').eq('id', user.id).single();
  if (!profile)              return res.status(403).json({ error: 'Geen profiel gevonden' });
  if (!profile.is_active)    return res.status(403).json({ error: 'Account inactief' });
  if (profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const q = req.query || {};
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));

  try {
    // v=3 (2026-08-28): filter uitgebreid met 'toegang-cron-run' events
    // (cron-summary + per-lead wa/mail-resultaat inclusief wamid/meta-code).
    // Query-param ?type=trace|cron|beide (default 'beide') selecteert welke.
    const typeArg = String((req.query || {}).type || 'beide').toLowerCase();
    const eventTypes = typeArg === 'trace' ? ['toegang-gate-trace']
                     : typeArg === 'cron'  ? ['toegang-cron-run']
                     : ['toegang-gate-trace', 'toegang-cron-run'];
    const { data, error } = await supabaseAdmin
      .from('follow_up_events_log')
      .select('id, source, event_type, payload, received_at')
      .in('event_type', eventTypes)
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.status(200).json({
      ok: true,
      type_filter: typeArg,
      count: (data || []).length,
      items: (data || []).map((r) => ({
        id: r.id,
        received_at: r.received_at,
        event_type: r.event_type,
        // Trace events → r.payload.events[]
        // Cron-run    → r.payload = summary (met .items[] per lead)
        events : r.event_type === 'toegang-gate-trace' ? (r.payload?.events || []) : null,
        summary: r.event_type === 'toegang-cron-run'   ? r.payload : null,
      })),
    });
  } catch (e) {
    console.error('[admin-toegang-gate-trace-list]', e?.message || e);
    return res.status(500).json({ error: 'Trace laden mislukt', detail: e?.message || String(e) });
  }
}
