// api/sales-customer-subscriptions.js
// GET ?customer_id=X → subscriptions van een klant (via diens deals).
// Geeft ook terug of er een 'accepted' offerte zonder subs is (→ knop Wizard 2).
// Permission: sales.customer.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.customer.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.customer.view)' });
  }

  const customerId = req.query?.customer_id;
  if (!customerId) return res.status(400).json({ error: 'customer_id vereist' });

  try {
    const { data: deals } = await supabaseAdmin.from('deals')
      .select('id, tl_quotation_status').eq('customer_id', customerId).is('archived_at', null);
    const dealIds = (deals || []).map(d => d.id);
    let subscriptions = [];
    const dealsWithSubs = new Set();
    if (dealIds.length) {
      const { data: subs } = await supabaseAdmin.from('subscriptions')
        .select('id, deal_id, description, amount, vat_percentage, term_count, start_date, end_date, teamleader_subscription_id, status, line_items, postponed_months')
        .in('deal_id', dealIds).order('start_date', { ascending: true });
      subscriptions = subs || [];
      for (const s of subscriptions) dealsWithSubs.add(s.deal_id);
    }
    // Getekende offerte zonder subs → Wizard 2 mogelijk.
    const acceptedWithoutSubs = (deals || []).find(d => d.tl_quotation_status === 'accepted' && !dealsWithSubs.has(d.id));

    return res.status(200).json({
      subscriptions,
      pending_deal_id: acceptedWithoutSubs ? acceptedWithoutSubs.id : null,
    });
  } catch (e) {
    console.error('[sales-customer-subscriptions]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
