// api/sales-quotation-mark-accepted.js
// POST { deal_id } → markeert offerte handmatig als 'accepted'.
// Tijdelijk: voor gebruik vóór de TL deal.won-webhook live is.
// Permission: sales.deal.edit.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  const { deal_id } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id vereist' });

  try {
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('deals').update({
      tl_quotation_status:      'accepted',
      tl_quotation_accepted_at: now,
      tl_quotation_signed_at:   now,
    }).eq('id', deal_id);
    if (error) throw error;
    return res.status(200).json({ success: true, tl_quotation_status: 'accepted' });
  } catch (e) {
    console.error('[mark-accepted]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
