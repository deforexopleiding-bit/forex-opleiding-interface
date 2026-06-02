// api/sales-subscriptions-list.js
// GET ?owned_by_me=true&status=active|cancelled|all → alle abonnementen met
// joins naar customers + deals + entiteit + line_items aggregate.
// Permission: sales.deal.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// Bedrag incl. BTW per termijn. Prefereer line_items (mix-safe per regel);
// val terug op amount + vat_percentage voor oude subs zonder line_items.
function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce((sum, li) => sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

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

  const ownedByMe = req.query?.owned_by_me === 'true';
  const status = req.query?.status || 'all';

  try {
    // 1. Relevante deals bepalen (voor owner-filter + sale_type/customer-join).
    let dealQ = supabaseAdmin.from('deals')
      .select('id, customer_id, sales_user_id, tl_department_id, sale_type')
      .is('archived_at', null);
    if (ownedByMe) dealQ = dealQ.eq('sales_user_id', user.id);
    const { data: deals } = await dealQ;
    const dealById = {};
    for (const d of deals || []) dealById[d.id] = d;
    const dealIds = Object.keys(dealById);
    if (!dealIds.length) return res.status(200).json({ items: [] });

    // 2. Subscriptions voor die deals.
    let subQ = supabaseAdmin.from('subscriptions')
      .select('id, deal_id, description, amount, vat_percentage, term_count, start_date, end_date, teamleader_subscription_id, status, line_items')
      .in('deal_id', dealIds).order('start_date', { ascending: false }).limit(500);
    if (status && status !== 'all') subQ = subQ.eq('status', status);
    const { data: subs } = await subQ;
    if (!subs || !subs.length) return res.status(200).json({ items: [] });

    // 3. Joins: customers + entiteit-labels.
    const custIds = [...new Set((deals || []).filter(d => d.customer_id).map(d => d.customer_id))];
    const deptIds = [...new Set((deals || []).filter(d => d.tl_department_id).map(d => d.tl_department_id))];
    const custById = {}, deptByTl = {};
    if (custIds.length) { const { data } = await supabaseAdmin.from('customers').select('id, first_name, last_name').in('id', custIds); for (const c of data || []) custById[c.id] = c; }
    if (deptIds.length) { const { data } = await supabaseAdmin.from('company_entities').select('tl_department_id, label').in('tl_department_id', deptIds); for (const e of data || []) deptByTl[e.tl_department_id] = e.label; }

    const items = subs.map(s => {
      const deal = dealById[s.deal_id] || {};
      const c = custById[deal.customer_id] || {};
      return {
        id: s.id,
        deal_id: s.deal_id,
        customer_id: deal.customer_id || null,
        customer_name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—',
        entity: deal.tl_department_id ? (deptByTl[deal.tl_department_id] || null) : null,
        description: s.description || null,
        line_items: Array.isArray(s.line_items) ? s.line_items : [],
        amount_incl: Math.round(inclPerTerm(s) * 100) / 100,
        term_count: s.term_count || 1,
        start_date: s.start_date || null,
        end_date: s.end_date || null,
        status: s.status || null,
        teamleader_subscription_id: s.teamleader_subscription_id || null,
      };
    });

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[sales-subscriptions-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
