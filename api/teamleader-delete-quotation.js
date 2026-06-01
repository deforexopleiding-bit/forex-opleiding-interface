// api/teamleader-delete-quotation.js
// POST { deal_id } → verwijdert de offerte. Permission: sales.deal.edit.
//
// Lokaal: SOFT-DELETE via deals.archived_at (audit-veilig; sales-quotations
// filtert archived_at IS NOT NULL eruit). TL: best-effort quotations.delete
// (bestaan niet 100% geverifieerd) + deals.lose als fallback-signaal. TL-fouten
// blokkeren de lokale verwijdering niet.

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
      .select('id, tl_deal_id, tl_quotation_id').eq('id', deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });

    // Best-effort TL-opschoning (non-blocking).
    const tok = await getActiveToken();
    if (tok) {
      if (deal.tl_quotation_id) {
        try {
          const r = await tlFetch('/quotations.delete', { method: 'POST', body: JSON.stringify({ id: deal.tl_quotation_id }) });
          if (!r.ok) console.warn('[tl-delete] quotations.delete HTTP', r.status, (await r.text()).slice(0, 150));
        } catch (e) { console.warn('[tl-delete] quotations.delete exception:', e.message); }
      }
      if (deal.tl_deal_id) {
        try {
          const r = await tlFetch('/deals.lose', { method: 'POST', body: JSON.stringify({ id: deal.tl_deal_id }) });
          if (!r.ok) console.warn('[tl-delete] deals.lose HTTP', r.status);
        } catch (e) { console.warn('[tl-delete] deals.lose exception:', e.message); }
      }
    }

    // Lokale soft-delete.
    await supabaseAdmin.from('deals').update({
      archived_at:              new Date().toISOString(),
      tl_quotation_declined_at: new Date().toISOString(),
    }).eq('id', deal_id);

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[tl-delete-quotation]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
