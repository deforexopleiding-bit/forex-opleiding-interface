// api/sales-deal-retry-push.js
// POST { deal_id } → (her)pusht de offerte naar TL. Permission: sales.deal.edit.
// Idempotent: pushQuotationToTl slaat over indien al een tl_quotation_id bestaat.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getActiveToken } from './_lib/teamleader-token.js';
import { pushQuotationToTl } from './_lib/teamleader-quotation.js';

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

  const tok = await getActiveToken();
  if (!tok) return res.status(503).json({ error: 'Geen TL-token actief' });

  try {
    const result = await pushQuotationToTl(deal_id);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (e) {
    console.error('[sales-deal-retry-push]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
