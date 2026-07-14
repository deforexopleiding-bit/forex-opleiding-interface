// api/dunning-call-log-list.js
// GET ?customer_id=<uuid> → alle belpogingen voor deze klant (chronologisch,
// nieuwste eerst). Ook de cadence-instellingen uit app_settings zodat de UI
// de 3-stap-tracker en de incasso-nudge kan renderen zonder aparte call.
//
// Permissie: finance.dunning.view (lees-bredere gate; write via -create.js).
//
// Response:
//   {
//     items: [{ id, customer_id, invoice_id, attempted_at, sip_line,
//               outcome, note, created_by, created_by_name, created_at }],
//     cadence: { max_attempts, interval_days },
//     resolved: boolean,          // true als er >=1 poging met resolutie-outcome is
//     attempts_count: N,          // totaal aantal pogingen (voor tracker)
//     next_reminder_at: iso|null  // laatste_poging_at + interval_days, als niet resolved
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLVED_OUTCOMES = new Set(['payment_promise','payment_plan','paid_during_call']);

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
  // Lees-permissie: gewone dunning-viewers mogen belpogingen zien; schrijven
  // vereist finance.dunning.execute (in -create.js).
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const customerId = typeof req.query?.customer_id === 'string' && UUID_RE.test(req.query.customer_id)
    ? req.query.customer_id
    : null;
  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('dunning_call_log')
      .select('id, customer_id, invoice_id, attempted_at, sip_line, outcome, note, created_by, created_at')
      .eq('customer_id', customerId)
      .order('attempted_at', { ascending: false });
    if (error) throw new Error('log: ' + error.message);

    // Naam-verrijking voor created_by (fail-soft).
    const userIds = Array.from(new Set((rows || []).map((r) => r.created_by).filter(Boolean)));
    const nameByUser = new Map();
    if (userIds.length) {
      try {
        const { data: profiles } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, email')
          .in('id', userIds);
        for (const p of profiles || []) nameByUser.set(p.id, p.full_name || p.email || null);
      } catch (e) { /* fail-soft */ }
    }

    const items = (rows || []).map((r) => ({
      ...r,
      created_by_name: r.created_by ? (nameByUser.get(r.created_by) || null) : null,
    }));

    // Cadence-settings (fail-soft: fallback naar 3/3).
    let cadence = { max_attempts: 3, interval_days: 3 };
    try {
      const { data: cs } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', 'dunning_call_cadence')
        .maybeSingle();
      const raw = cs?.value;
      if (raw && typeof raw === 'object') {
        const ma = Number(raw.max_attempts);
        const id = Number(raw.interval_days);
        if (Number.isFinite(ma) && ma >= 1 && ma <= 20) cadence.max_attempts = Math.trunc(ma);
        if (Number.isFinite(id) && id >= 1 && id <= 60) cadence.interval_days = Math.trunc(id);
      }
    } catch (e) { /* fallback */ }

    const resolved = items.some((r) => RESOLVED_OUTCOMES.has(r.outcome));
    const attemptsCount = items.length;
    let nextReminderAt = null;
    if (!resolved && items.length > 0) {
      const last = items[0]; // nieuwste eerst → items[0] = laatste poging
      const t = new Date(last.attempted_at).getTime();
      if (Number.isFinite(t)) nextReminderAt = new Date(t + cadence.interval_days * 86400000).toISOString();
    }

    return res.status(200).json({
      items,
      cadence,
      resolved,
      attempts_count: attemptsCount,
      next_reminder_at: nextReminderAt,
    });
  } catch (e) {
    console.error('[dunning-call-log-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
