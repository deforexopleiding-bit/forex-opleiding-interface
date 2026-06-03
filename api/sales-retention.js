// api/sales-retention.js
// GET ?owned_by_me= → klanten waarvan het traject binnen 30 dagen afloopt.
// Einddatum: MAX(subscription.end_date) per deal, anders deal.created_at +
// variant.default_duration_months maanden. Permission: sales.customer.view.

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
      .select('id, customer_id, sales_user_id, traject_variant_id, tl_department_id, created_at')
      .is('archived_at', null).order('created_at', { ascending: false }).limit(500);
    if (req.query?.owned_by_me === 'true') q = q.eq('sales_user_id', user.id);
    const { data: deals } = await q;
    const dealIds = (deals || []).map(d => d.id);

    // Sub-einddatums per deal.
    const subEndByDeal = {};
    if (dealIds.length) {
      const { data: subs } = await supabaseAdmin.from('subscriptions').select('deal_id, end_date').in('deal_id', dealIds);
      for (const s of subs || []) {
        if (!s.end_date) continue;
        if (!subEndByDeal[s.deal_id] || s.end_date > subEndByDeal[s.deal_id]) subEndByDeal[s.deal_id] = s.end_date;
      }
    }
    // Variant-duur voor fallback.
    const variantIds = [...new Set((deals || []).map(d => d.traject_variant_id).filter(Boolean))];
    const variantById = {};
    if (variantIds.length) {
      const { data: vs } = await supabaseAdmin.from('traject_variants').select('id, name, traject_id, default_duration_months').in('id', variantIds);
      const tIds = [...new Set((vs || []).map(v => v.traject_id))];
      const tName = {}; if (tIds.length) { const { data: ts } = await supabaseAdmin.from('trajects').select('id, name').in('id', tIds); for (const t of ts || []) tName[t.id] = t.name; }
      for (const v of vs || []) variantById[v.id] = { ...v, label: [tName[v.traject_id], v.name].filter(Boolean).join(' > ') };
    }

    const now = Date.now();
    const horizon = now + 30 * 86400000;
    const rows = [];
    for (const d of deals || []) {
      let endDate = subEndByDeal[d.id] || null;
      const variant = d.traject_variant_id ? variantById[d.traject_variant_id] : null;
      if (!endDate && variant?.default_duration_months && d.created_at) {
        const dt = new Date(d.created_at); dt.setMonth(dt.getMonth() + Number(variant.default_duration_months));
        endDate = dt.toISOString().slice(0, 10);
      }
      if (!endDate) continue; // niet te bepalen
      const endMs = new Date(endDate).getTime();
      if (endMs > horizon) continue; // > 30 dagen weg
      rows.push({ deal_id: d.id, customer_id: d.customer_id, traject_variant_id: d.traject_variant_id,
        tl_department_id: d.tl_department_id || null,
        traject_label: variant?.label || null, end_date: endDate,
        days_left: Math.ceil((endMs - now) / 86400000) });
    }

    const custIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))];
    const custById = {};
    if (custIds.length) { const { data } = await supabaseAdmin.from('customers').select('id, first_name, last_name, email, mentor_user_id').in('id', custIds); for (const c of data || []) custById[c.id] = c; }
    // Entiteit-labels.
    const deptIds = [...new Set(rows.map(r => r.tl_department_id).filter(Boolean))];
    const entByTl = {};
    if (deptIds.length) { const { data } = await supabaseAdmin.from('company_entities').select('tl_department_id, label').in('tl_department_id', deptIds); for (const e of data || []) entByTl[e.tl_department_id] = e.label; }
    // Mentor-namen (customers.mentor_user_id → profiles.full_name).
    const mentorIds = [...new Set(Object.values(custById).map(c => c.mentor_user_id).filter(Boolean))];
    const mentorById = {};
    if (mentorIds.length) { const { data } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', mentorIds); for (const p of data || []) mentorById[p.id] = p.full_name; }
    for (const r of rows) {
      const c = custById[r.customer_id] || {};
      r.customer_name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
      r.customer_email = c.email || null;
      r.entity = r.tl_department_id ? (entByTl[r.tl_department_id] || null) : null;
      r.mentor_name = c.mentor_user_id ? (mentorById[c.mentor_user_id] || null) : null;
    }
    rows.sort((a, b) => a.days_left - b.days_left);

    return res.status(200).json({ items: rows });
  } catch (e) {
    console.error('[sales-retention]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
