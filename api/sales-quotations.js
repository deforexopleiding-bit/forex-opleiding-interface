// api/sales-quotations.js
// GET ?status=&search=&owned_by_me= → offertes-lijst (deals + customer-join).
// Elke deal = een offerte. Permission: sales.deal.view.

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

  const { status, search, owned_by_me } = req.query || {};

  try {
    let q = supabaseAdmin.from('deals')
      .select('id, customer_id, total_amount, created_at, sales_user_id, tl_quotation_id, tl_quotation_status, tl_quotation_sent_at, tl_quotation_email_sent_at, tl_quotation_accepted_at, tl_quotation_declined_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (owned_by_me === 'true') q = q.eq('sales_user_id', user.id);
    if (status) q = q.eq('tl_quotation_status', status);
    const { data: deals, error } = await q;
    if (error) throw error;

    const custIds = [...new Set((deals || []).map(d => d.customer_id).filter(Boolean))];
    let custById = {};
    if (custIds.length) {
      const { data: customers } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, email').in('id', custIds);
      for (const c of customers || []) custById[c.id] = c;
    }

    const s = (search || '').trim().toLowerCase();
    const quotations = (deals || []).map(d => {
      const c = custById[d.customer_id] || {};
      return {
        deal_id:             d.id,
        customer_id:         d.customer_id,
        customer_name:       `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—',
        customer_email:      c.email || null,
        total_amount:        d.total_amount,
        created_at:          d.created_at,
        tl_quotation_id:     d.tl_quotation_id,
        tl_quotation_status: d.tl_quotation_status || 'draft',
        sent_at:             d.tl_quotation_email_sent_at || d.tl_quotation_sent_at || null,
        accepted_at:         d.tl_quotation_accepted_at || null,
        declined_at:         d.tl_quotation_declined_at || null,
      };
    }).filter(qn => !s || qn.customer_name.toLowerCase().includes(s) || (qn.customer_email || '').toLowerCase().includes(s));

    return res.status(200).json({ quotations });
  } catch (err) {
    console.error('[sales-quotations]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
