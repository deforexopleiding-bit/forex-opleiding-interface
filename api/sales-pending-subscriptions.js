// api/sales-pending-subscriptions.js
// GET → deals met getekende (accepted) offerte die nog GEEN subscriptions hebben.
// Voor het dashboard-widget 'Wachten op subscription'. Permission: sales.deal.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
  }

  try {
    const { data: deals } = await supabaseAdmin.from('deals')
      .select('id, customer_id, total_amount, tl_quotation_accepted_at')
      .eq('tl_quotation_status', 'accepted').is('archived_at', null)
      .order('tl_quotation_accepted_at', { ascending: false }).limit(50);

    const dealIds = (deals || []).map(d => d.id);
    const withSubs = new Set();
    if (dealIds.length) {
      const { data: subs } = await supabaseAdmin.from('subscriptions').select('deal_id').in('deal_id', dealIds);
      for (const s of subs || []) withSubs.add(s.deal_id);
    }
    const pending = (deals || []).filter(d => !withSubs.has(d.id));

    const custIds = [...new Set(pending.map(d => d.customer_id).filter(Boolean))];
    const custById = {};
    if (custIds.length) {
      const { data: customers } = await supabaseAdmin.from('customers').select('id, first_name, last_name').in('id', custIds);
      for (const c of customers || []) custById[c.id] = c;
    }

    const items = pending.map(d => {
      const c = custById[d.customer_id] || {};
      return {
        deal_id:      d.id,
        customer_id:  d.customer_id,
        customer_name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—',
        total_amount: d.total_amount,
        accepted_at:  d.tl_quotation_accepted_at,
      };
    });

    return res.status(200).json({ count: items.length, items });
  } catch (e) {
    console.error('[pending-subscriptions]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
