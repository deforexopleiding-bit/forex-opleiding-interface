// api/sales-onboardings.js
// GET ?owned_by_me= → klanten met getekende offerte (onboarding-overzicht).
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
  if (!(await requirePermission(req, 'sales.customer.view'))) return res.status(403).json({ error: 'Geen rechten' });

  try {
    let q = supabaseAdmin.from('deals')
      .select('id, customer_id, sales_user_id, traject_variant_id, tl_department_id, first_call_at, tl_quotation_status, created_at')
      .in('tl_quotation_status', ['accepted', 'signed']).is('archived_at', null)
      .order('created_at', { ascending: false }).limit(300);
    if (req.query?.owned_by_me === 'true') q = q.eq('sales_user_id', user.id);
    const { data: deals } = await q;

    const custIds = [...new Set((deals || []).map(d => d.customer_id).filter(Boolean))];
    const variantIds = [...new Set((deals || []).map(d => d.traject_variant_id).filter(Boolean))];
    const deptIds = [...new Set((deals || []).map(d => d.tl_department_id).filter(Boolean))];
    const userIds = [...new Set((deals || []).map(d => d.sales_user_id).filter(Boolean))];

    const custById = {}, trajectByVariant = {}, deptByTl = {}, userById = {};
    if (custIds.length) { const { data } = await supabaseAdmin.from('customers').select('id, first_name, last_name, onboarding_status').in('id', custIds); for (const c of data || []) custById[c.id] = c; }
    if (variantIds.length) {
      const { data: vs } = await supabaseAdmin.from('traject_variants').select('id, name, traject_id').in('id', variantIds);
      const tIds = [...new Set((vs || []).map(v => v.traject_id))];
      const tName = {}; if (tIds.length) { const { data: ts } = await supabaseAdmin.from('trajects').select('id, name').in('id', tIds); for (const t of ts || []) tName[t.id] = t.name; }
      for (const v of vs || []) trajectByVariant[v.id] = [tName[v.traject_id], v.name].filter(Boolean).join(' > ');
    }
    if (deptIds.length) { const { data } = await supabaseAdmin.from('company_entities').select('tl_department_id, label').in('tl_department_id', deptIds); for (const e of data || []) deptByTl[e.tl_department_id] = e.label; }
    if (userIds.length) { const { data } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', userIds); for (const u of data || []) userById[u.id] = u.full_name; }

    const items = (deals || []).map(d => {
      const c = custById[d.customer_id] || {};
      return {
        deal_id: d.id, customer_id: d.customer_id,
        customer_name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—',
        traject_label: d.traject_variant_id ? (trajectByVariant[d.traject_variant_id] || null) : null,
        entity: d.tl_department_id ? (deptByTl[d.tl_department_id] || null) : null,
        onboarding_status: c.onboarding_status || 'not_sent',
        first_call_at: d.first_call_at || null,
        sales_user: d.sales_user_id ? (userById[d.sales_user_id] || null) : null,
      };
    });

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[sales-onboardings]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
