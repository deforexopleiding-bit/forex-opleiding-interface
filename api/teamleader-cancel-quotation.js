// api/teamleader-cancel-quotation.js
// POST { deal_id } → annuleert de offerte. Permission: sales.deal.edit.
// Zet onze status op 'declined'; markeert (best-effort) de TL-deal als lost.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';

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
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, tl_deal_id, tl_quotation_status').eq('id', deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });
    if (deal.tl_quotation_status === 'accepted') {
      return res.status(409).json({ error: 'Een geaccepteerde offerte kan niet geannuleerd worden' });
    }

    // Best-effort TL-deal op 'lost' zetten (non-blocking).
    if (deal.tl_deal_id) {
      try {
        const tok = await getActiveToken();
        if (tok) {
          const r = await tlFetch('/deals.lose', { method: 'POST', body: JSON.stringify({ id: deal.tl_deal_id }) });
          if (!r.ok) console.warn('[tl-cancel] deals.lose HTTP', r.status, (await r.text()).slice(0, 150));
        }
      } catch (e) { console.warn('[tl-cancel] deals.lose exception:', e.message); }
    }

    await supabaseAdmin.from('deals').update({
      tl_quotation_status:      'declined',
      tl_quotation_declined_at: new Date().toISOString(),
    }).eq('id', deal_id);

    return res.status(200).json({ success: true, tl_quotation_status: 'declined' });
  } catch (e) {
    console.error('[tl-cancel-quotation]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
