// api/finance-payment-match-reject.js
// POST → markeer een match-candidate als verworpen. Geen TL-call.
// Permission: finance.bank.transactions_view.
//
// Body: { match_id, reason? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.bank.transactions_view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.transactions_view)' });
  }

  const { match_id, reason } = req.body || {};
  if (!match_id) return res.status(400).json({ error: 'match_id vereist' });

  try {
    const { data: m, error: mErr } = await supabaseAdmin
      .from('payment_match_candidates')
      .select('id, status')
      .eq('id', match_id)
      .maybeSingle();
    if (mErr) throw new Error(mErr.message);
    if (!m) return res.status(404).json({ error: 'Match niet gevonden' });
    if (m.status !== 'suggested' && m.status !== 'auto_confirmed') {
      return res.status(409).json({ error: `Match heeft status '${m.status}', alleen 'suggested' of 'auto_confirmed' kan verworpen worden` });
    }

    const { error: upErr } = await supabaseAdmin
      .from('payment_match_candidates')
      .update({
        status:          'rejected',
        rejected_reason: (reason && String(reason).trim()) || null,
        confirmed_by_user_id: user.id,
        confirmed_at:    new Date().toISOString(),
      })
      .eq('id', match_id);
    if (upErr) throw new Error(upErr.message);

    return res.status(200).json({ success: true, match_id });
  } catch (e) {
    console.error('[finance-payment-match-reject]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
