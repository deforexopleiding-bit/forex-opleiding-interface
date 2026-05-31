// api/sales-customers.js
// GET ?owned_by_me=true&search=&status=&tags= → klanten-lijst voor sales-module.
// Hergebruikt customers + deals voor count + laatste-deal info.

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

  const { owned_by_me, search, status } = req.query || {};

  try {
    // Owner-filter via deals.sales_user_id; klanten zonder deal zien we niet
    // bij owned_by_me=true.
    let customerIds = null;
    if (owned_by_me === 'true') {
      const { data: ownedDeals } = await supabaseAdmin
        .from('deals').select('customer_id').eq('sales_user_id', user.id);
      customerIds = [...new Set((ownedDeals || []).map(d => d.customer_id).filter(Boolean))];
      if (customerIds.length === 0) return res.status(200).json({ customers: [] });
    }

    let q = supabaseAdmin.from('customers')
      .select('id, first_name, last_name, email, phone, created_at, archived_at, risk_tag_auto')
      .order('updated_at', { ascending: false }).limit(200);
    if (customerIds) q = q.in('id', customerIds);
    if (status === 'archived') q = q.not('archived_at', 'is', null);
    else q = q.is('archived_at', null);
    if (search) {
      const s = String(search).trim();
      q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
    }
    const { data: customers, error } = await q;
    if (error) throw error;

    const ids = (customers || []).map(c => c.id);
    let dealsByCustomer = {};
    if (ids.length) {
      const { data: deals } = await supabaseAdmin
        .from('deals').select('customer_id, status, total_amount, created_at, tl_quotation_status')
        .in('customer_id', ids)
        .order('created_at', { ascending: false });
      for (const d of deals || []) {
        (dealsByCustomer[d.customer_id] ||= []).push(d);
      }
    }

    const enriched = (customers || []).map(c => {
      const deals = dealsByCustomer[c.id] || [];
      return {
        ...c,
        name:              `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        deals_count:       deals.length,
        last_deal_at:      deals[0]?.created_at || null,
        last_deal_status:  deals[0]?.status || null,
        quotation_status:  deals[0]?.tl_quotation_status || null,
      };
    });

    return res.status(200).json({ customers: enriched });
  } catch (err) {
    console.error('[sales-customers]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
