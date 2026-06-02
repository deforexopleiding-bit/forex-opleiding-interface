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

  const { status, search, owned_by_me, customer_id } = req.query || {};

  try {
    let q = supabaseAdmin.from('deals')
      .select('id, customer_id, total_amount, created_at, sales_user_id, traject_variant_id, tl_quotation_id, tl_quotation_status, tl_quotation_sent_at, tl_quotation_email_sent_at, tl_quotation_accepted_at, tl_quotation_declined_at')
      .is('archived_at', null)  // verwijderde offertes (soft-delete) niet tonen
      .neq('tl_quotation_status', 'no_quotation')  // ghost-deals (abo zonder offerte) niet als offerte tonen
      .order('created_at', { ascending: false })
      .limit(300);
    if (owned_by_me === 'true') q = q.eq('sales_user_id', user.id);
    if (customer_id) q = q.eq('customer_id', customer_id);
    if (status) q = q.eq('tl_quotation_status', status);
    const { data: deals, error } = await q;
    if (error) throw error;

    // Traject-label per deal (traject > variant).
    const variantIds = [...new Set((deals || []).map(d => d.traject_variant_id).filter(Boolean))];
    const trajectByVariant = {};
    if (variantIds.length) {
      const { data: variants } = await supabaseAdmin.from('traject_variants').select('id, name, traject_id').in('id', variantIds);
      const trajectIds = [...new Set((variants || []).map(v => v.traject_id))];
      const trajectName = {};
      if (trajectIds.length) {
        const { data: trajects } = await supabaseAdmin.from('trajects').select('id, name').in('id', trajectIds);
        for (const t of trajects || []) trajectName[t.id] = t.name;
      }
      for (const v of variants || []) trajectByVariant[v.id] = [trajectName[v.traject_id], v.name].filter(Boolean).join(' > ');
    }

    // Incl-BTW totaal per deal uit deal_line_items (per regel, mix-safe).
    const dealIds = (deals || []).map(d => d.id);
    const inclByDeal = {};
    if (dealIds.length) {
      const { data: lines } = await supabaseAdmin.from('deal_line_items')
        .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat').in('deal_id', dealIds);
      for (const l of lines || []) {
        const lineBase = Number(l.quantity) * Number(l.unit_price);
        const incl = l.price_includes_vat ? lineBase : lineBase * (1 + Number(l.vat_percentage) / 100);
        inclByDeal[l.deal_id] = (inclByDeal[l.deal_id] || 0) + incl;
      }
    }

    const custIds = [...new Set((deals || []).map(d => d.customer_id).filter(Boolean))];
    let custById = {};
    if (custIds.length) {
      const { data: customers } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, email').in('id', custIds);
      for (const c of customers || []) custById[c.id] = c;
    }

    // Verkoper-namen (E).
    const userIds = [...new Set((deals || []).map(d => d.sales_user_id).filter(Boolean))];
    const userById = {};
    if (userIds.length) {
      const { data: profs } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', userIds);
      for (const u of profs || []) userById[u.id] = u.full_name;
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
        total_amount_incl:   inclByDeal[d.id] != null ? Math.round(inclByDeal[d.id] * 100) / 100 : null,
        traject_label:       d.traject_variant_id ? (trajectByVariant[d.traject_variant_id] || null) : null,
        sales_user:          d.sales_user_id ? (userById[d.sales_user_id] || null) : null,
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
