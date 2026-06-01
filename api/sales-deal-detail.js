// api/sales-deal-detail.js
// GET ?id=<deal_id> → deal + customer + line_items + traject-info.
// Permission: sales.deal.view.

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

  const id = req.query?.id;
  if (!id) return res.status(400).json({ error: 'id vereist' });

  try {
    const { data: deal } = await supabaseAdmin.from('deals').select('*').eq('id', id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });

    const { data: customer } = await supabaseAdmin.from('customers')
      .select('id, first_name, last_name, email, phone, address_street, address_number, address_postal, address_city')
      .eq('id', deal.customer_id).maybeSingle();
    const { data: lineItems } = await supabaseAdmin.from('deal_line_items')
      .select('*').eq('deal_id', id).order('position', { ascending: true });

    let traject = null;
    if (deal.traject_variant_id) {
      const { data: variant } = await supabaseAdmin.from('traject_variants')
        .select('id, name, traject_id, default_duration_months').eq('id', deal.traject_variant_id).maybeSingle();
      if (variant) {
        const { data: t } = await supabaseAdmin.from('trajects').select('name').eq('id', variant.traject_id).maybeSingle();
        traject = { variant_id: variant.id, variant_name: variant.name, traject_name: t?.name || null,
                    label: [t?.name, variant.name].filter(Boolean).join(' > ') };
      }
    }

    let entity = null;
    if (deal.tl_department_id) {
      const { data: ent } = await supabaseAdmin.from('company_entities')
        .select('label').eq('tl_department_id', deal.tl_department_id).maybeSingle();
      entity = ent?.label || null;
    }

    // Totalen (mix-safe per regel) + deal-niveau korting + type verkoop.
    const factor = 1 - (Number(deal.discount_percentage) || 0) / 100;
    const zeroVat = deal.sale_type && deal.sale_type !== 'domestic';
    let excl = 0, incl = 0;
    for (const l of lineItems || []) {
      const rate = zeroVat ? 0 : Number(l.vat_percentage) / 100;
      const base = Number(l.quantity) * Number(l.unit_price);
      const lineExcl = (l.price_includes_vat ? base / (1 + rate) : base) * factor;
      const lineIncl = lineExcl * (1 + rate);
      excl += lineExcl; incl += lineIncl;
    }

    return res.status(200).json({
      deal, customer, line_items: lineItems || [], traject, entity,
      discount_percentage: Number(deal.discount_percentage) || 0,
      totals: { excl: Math.round(excl * 100) / 100, incl: Math.round(incl * 100) / 100 },
    });
  } catch (e) {
    console.error('[sales-deal-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
