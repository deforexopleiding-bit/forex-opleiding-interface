// api/sales-deal-copy.js
// POST { deal_id } → duplicate a deal + line_items als NIEUWE concept-offerte.
// Permission: sales.deal.create (zelfde als sales-deal-create).
//
// Use-case: bestaande offerte (elke status) kopiëren om aan te passen +
// opnieuw te versturen zonder het origineel te muteren. Vooral nuttig bij
// getekende offertes (origineel blijft ongewijzigd) of correcties op een
// verkeerd getypt e-mailadres.
//
// Verse start voor de kopie:
//   - GEEN TL-koppeling: tl_quotation_id / tl_deal_id / tl_contact_id → null
//   - tl_quotation_status → 'draft', tl_push_status → 'not_pushed'
//   - Alle *_at TL-timestamps → null (accepted/declined/sent/email_sent)
//   - reservation_fee_invoice_id → null (bouwstap 2 fee is per deal)
//   - exception_* velden → default false/null (nieuwe deal doorloopt zelf
//     opnieuw de beveiliging indien nodig)
//   - archived_at → null (kopie is een levende concept-offerte)
//   - sales_user_id → huidige user (audit) — bewust NIET de originele
//     verkoper zodat wie kopieert eigenaar wordt van het concept.
//   - quote_reference → oude + ' (kopie)' voor herkenbaarheid.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
  }

  const { deal_id } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id vereist' });

  try {
    // 1. Bron-deal laden (select *; we plukken zelf de te-kopiëren velden).
    const { data: src, error: sErr } = await supabaseAdmin.from('deals')
      .select('*').eq('id', deal_id).maybeSingle();
    if (sErr) throw sErr;
    if (!src) return res.status(404).json({ error: 'Deal niet gevonden' });

    // 2. Nieuwe deal-payload. Zelfde shape als sales-deal-create's insert.
    //    Waarden waar sales-deal-create 'now/user' zet doen we hier ook.
    const nowIso = new Date().toISOString();
    const dealPayload = {
      customer_id:                src.customer_id,
      total_amount:               src.total_amount,
      start_date:                 src.start_date || nowIso.slice(0, 10),
      end_date:                   src.end_date || null,
      status:                     'active',
      sales_user_id:              user.id,
      source:                     src.source || null,
      source_lead_id:             src.source_lead_id || null,
      downpayment_amount:         src.downpayment_amount || null,
      first_call_at:              null, // verse start; mentor plant later
      quote_reference:            src.quote_reference ? `${src.quote_reference} (kopie)` : null,
      tl_department_id:           src.tl_department_id || null,
      traject_variant_id:         src.traject_variant_id || null,
      discount_percentage:        Number(src.discount_percentage) || 0,
      sale_type:                  src.sale_type || 'domestic',
      payment_start_date:         src.payment_start_date || null,
      payment_downpayment_amount: src.payment_downpayment_amount || null,
      payment_downpayment_date:   src.payment_downpayment_date || null,
      payment_term_count:         src.payment_term_count || null,
      payment_term_start_date:    src.payment_term_start_date || null,
      payment_term_amount:        src.payment_term_amount || null,
      // NB: duration_months bestaat NIET op deals — de duur wordt afgeleid
      // van traject_variants.default_duration_months (via traject_variant_id
      // dat we hierboven wél kopiëren). Zie sales-deal-update.js regel 65.
      // Verse TL-status: nog niet gepusht, nog geen offerte-koppeling.
      tl_push_status:             'not_pushed',
      tl_quotation_status:        'draft',
      // NIET meenemen (worden expliciet null gelaten of via default):
      //   tl_quotation_id, tl_deal_id, tl_contact_id, tl_pushed_at,
      //   tl_push_error, tl_quotation_sent_at, tl_quotation_email_sent_at,
      //   tl_quotation_accepted_at, tl_quotation_declined_at,
      //   reservation_fee_invoice_id, exception_* (defaults uit migratie),
      //   archived_at, created_at (auto).
    };

    const { data: newDeal, error: dErr } = await supabaseAdmin
      .from('deals').insert(dealPayload).select('id').single();
    if (dErr) throw dErr;
    const newDealId = newDeal.id;

    // 3. Line items 1-op-1 kopiëren met het nieuwe deal_id.
    const { data: srcLines, error: lsErr } = await supabaseAdmin
      .from('deal_line_items').select('*').eq('deal_id', deal_id)
      .order('position', { ascending: true });
    if (lsErr) throw lsErr;

    if (Array.isArray(srcLines) && srcLines.length) {
      const lineRows = srcLines.map((l, idx) => ({
        deal_id:            newDealId,
        product_id:         l.product_id || null,
        product_name:       l.product_name || 'Product',
        quantity:           Number(l.quantity) || 1,
        unit_price:         Number(l.unit_price) || 0,
        vat_percentage:     l.vat_percentage ?? 21,
        price_includes_vat: !!l.price_includes_vat,
        position:           l.position ?? idx,
      }));
      const { error: liErr } = await supabaseAdmin.from('deal_line_items').insert(lineRows);
      if (liErr) throw liErr;
    }

    return res.status(200).json({ ok: true, success: true, new_deal_id: newDealId, source_deal_id: deal_id });
  } catch (e) {
    console.error('[sales-deal-copy]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
