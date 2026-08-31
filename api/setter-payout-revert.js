// api/setter-payout-revert.js
//
// POST { payout_id: <uuid> } → draait een setter_payouts-rij terug.
// Alle bijhorende ledger-entries → status='vrijgegeven' + payout_id=NULL + paid_at=NULL.
// De payout-rij zelf wordt VERWIJDERD (niet soft-deleted).
//
// Gate: setter.payout.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'setter.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (setter.payout.manage)' });
  }

  const payoutId = String(req.body?.payout_id || '').trim();
  if (!UUID_RE.test(payoutId)) return res.status(400).json({ error: 'payout_id (uuid) vereist' });

  try {
    const { data: payout } = await supabaseAdmin
      .from('setter_payouts').select('id, entry_count').eq('id', payoutId).maybeSingle();
    if (!payout) return res.status(404).json({ error: 'Payout niet gevonden' });

    const { error: uErr } = await supabaseAdmin
      .from('setter_ledger_entries')
      .update({ status: 'vrijgegeven', payout_id: null, paid_at: null })
      .eq('payout_id', payoutId);
    if (uErr) throw uErr;

    const { error: dErr } = await supabaseAdmin
      .from('setter_payouts').delete().eq('id', payoutId);
    if (dErr) throw dErr;

    return res.status(200).json({ ok: true, reverted_id: payoutId, entries_reverted: payout.entry_count });
  } catch (e) {
    console.error('[setter-payout-revert]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
