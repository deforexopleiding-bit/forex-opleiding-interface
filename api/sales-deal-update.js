// api/sales-deal-update.js
// PUT { deal_id, deal_data, products[] } → werk een bestaande deal + regels bij.
// Permission: sales.deal.edit.
//
// LET OP: TL quotation-update is complex en volgt later. Indien de deal al een
// tl_quotation_id heeft, blijven wijzigingen voorlopig LOKAAL (geen TL-sync).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'PUT') return res.status(405).json({ error: 'PUT only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  const { deal_id, deal_data = {}, products = [] } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id vereist' });

  try {
    const { data: existing } = await supabaseAdmin.from('deals').select('id, tl_quotation_id').eq('id', deal_id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Deal niet gevonden' });

    // Department-validatie (indien gewijzigd).
    if (deal_data.tl_department_id) {
      const { data: ent } = await supabaseAdmin.from('company_entities')
        .select('tl_department_id').eq('tl_department_id', deal_data.tl_department_id).eq('is_active', true).maybeSingle();
      if (!ent) return res.status(400).json({ error: 'Ongeldige bedrijfsentiteit' });
    }

    const totalAmount = products.reduce((s, p) => s + (Number(p.price_per_unit) * Number(p.quantity)), 0);
    const patch = { updated_at: new Date().toISOString() };
    // LET OP: 'duration_months' bestaat NIET als kolom op deals (create slaat
    // het ook niet op — het is alleen wizard-UI). Niet meeschrijven, anders 500.
    const map = ['start_date', 'source_lead_id', 'quote_reference', 'tl_department_id',
                 'traject_variant_id', 'discount_percentage', 'payment_start_date', 'payment_downpayment_amount', 'payment_downpayment_date',
                 'payment_term_count', 'payment_term_start_date', 'payment_term_amount'];
    for (const k of map) if (deal_data[k] !== undefined) patch[k] = deal_data[k] || null;
    // discount_percentage is NOT NULL → 0 i.p.v. null.
    if (deal_data.discount_percentage !== undefined) patch.discount_percentage = Number(deal_data.discount_percentage) || 0;
    if (products.length) patch.total_amount = totalAmount;

    const { error: dErr } = await supabaseAdmin.from('deals').update(patch).eq('id', deal_id);
    if (dErr) throw dErr;

    // Line items vervangen indien meegegeven.
    if (Array.isArray(products) && products.length) {
      await supabaseAdmin.from('deal_line_items').delete().eq('deal_id', deal_id);
      const rows = products.map((p, idx) => ({
        deal_id, product_id: p.product_id || null, product_name: p.product_name || 'Product',
        quantity: Number(p.quantity) || 1, unit_price: Number(p.price_per_unit) || 0,
        vat_percentage: p.vat_percentage ?? 21, price_includes_vat: !!p.price_includes_vat, position: idx,
      }));
      const { error: liErr } = await supabaseAdmin.from('deal_line_items').insert(rows);
      if (liErr) throw liErr;
    }

    return res.status(200).json({
      success: true, deal_id,
      tl_sync_skipped: !!existing.tl_quotation_id,
      note: existing.tl_quotation_id ? 'Wijzigingen lokaal opgeslagen; TL-offerte niet bijgewerkt (volgt later)' : undefined,
    });
  } catch (e) {
    console.error('[sales-deal-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
