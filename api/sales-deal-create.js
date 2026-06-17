// api/sales-deal-create.js
// POST { customer_data, deal_data, products[], matched_customer_id?, tl_imported_contact_id?, sync_to_tl }
// → { customer_id, deal_id, tl_quotation_status, tl_quotation_id?, tl_deal_id?, tl_contact_id?, tl_error? }
//
// Wizard 1 (offerte-flow): maakt klant + deal + offerte-regels, en pusht een
// OFFERTE (quotation) naar TL. Subscriptions worden hier NIET meer aangemaakt;
// die volgen in Wizard 2 nadat de offerte is getekend.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getActiveToken } from './_lib/teamleader-token.js';
import { pushQuotationToTl } from './_lib/teamleader-quotation.js';

// Lege string / undefined → null (voorkomt 'invalid input syntax for type uuid').
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

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

  const body = req.body || {};
  const { customer_data = {}, deal_data = {}, products = [],
          matched_customer_id, tl_imported_contact_id, sync_to_tl = false,
          // Optioneel: wizard gestart vanuit Events-aanwezige. Zo ja, koppelen
          // we event_attendees.customer_id server-side (best-effort, fail-soft)
          // zodat de aanwezigen-tabel meteen tl_quotation_status mee krijgt via
          // de bestaande join. Voorheen deed de wizard een client-side PATCH op
          // /api/events-attendee-update, wat events.attendee.edit-rechten
          // vereiste. Server-side draait dit binnen de al verleende
          // sales.deal.create-scope (geen extra RBAC nodig).
          event_attendee_id } = body;

  // Lead-bron is optioneel geworden (P2): geen verplichting meer.
  if (!Array.isArray(products) || products.length === 0) return res.status(400).json({ error: 'minimaal 1 product vereist' });

  try {
    // 0. Bedrijfsentiteit valideren (indien meegegeven) tegen company_entities.
    let departmentId = deal_data.tl_department_id || null;
    if (departmentId) {
      const { data: ent } = await supabaseAdmin.from('company_entities')
        .select('tl_department_id').eq('tl_department_id', departmentId).eq('is_active', true).maybeSingle();
      if (!ent) return res.status(400).json({ error: 'Ongeldige bedrijfsentiteit (tl_department_id)' });
    }

    // 1. Customer: reuse OF create.
    let customerId = matched_customer_id || null;
    if (!customerId) {
      const custPayload = {
        is_company:      customer_data.is_company === true || customer_data.is_company === 'true',
        company_name:    customer_data.company_name || null,
        kvk_number:      customer_data.kvk_number || null,
        vat_number:      customer_data.vat_number || null,
        first_name:      customer_data.first_name || null,
        last_name:       customer_data.last_name || null,
        email:           customer_data.email || null,
        phone:           customer_data.phone || null,
        date_of_birth:   customer_data.date_of_birth || null,
        address_street:  customer_data.address_street || null,
        address_number:  customer_data.address_number || null,
        address_postal:  customer_data.address_postal || null,
        address_city:    customer_data.address_city || null,
        tl_contact_id:   tl_imported_contact_id || null,
        created_by_user_id: user.id,
      };
      // Email-uniciteit check (race-safe via DB error 23505 als constraint bestaat).
      const { data: cust, error: cErr } = await supabaseAdmin.from('customers').insert(custPayload).select('id').single();
      if (cErr) {
        if (cErr.code === '23505') return res.status(409).json({ error: 'Email reeds in gebruik (race-conditie)' });
        throw cErr;
      }
      customerId = cust.id;
    }

    // 1b. Best-effort: koppel de aanwezige aan deze klant zodat de
    //     Events-aanwezigentabel meteen offerte-status toont. Failures
    //     loggen we alleen — mogen de deal-creatie nooit breken.
    if (event_attendee_id && customerId) {
      try {
        const { error: eaErr } = await supabaseAdmin
          .from('event_attendees')
          .update({ customer_id: customerId })
          .eq('id', event_attendee_id);
        if (eaErr) {
          console.warn('[sales-deal-create] event_attendees back-link failed:', eaErr.message);
        }
      } catch (e) {
        console.warn('[sales-deal-create] event_attendees back-link exception:', e?.message || e);
      }
    }

    // 2. Bereken total_amount uit producten.
    const totalAmount = products.reduce((sum, p) => sum + (Number(p.price_per_unit) * Number(p.quantity)), 0);

    // 3. Deal aanmaken.
    const dealPayload = {
      customer_id:        customerId,
      total_amount:       totalAmount,
      start_date:         deal_data.start_date || new Date().toISOString().slice(0, 10),
      end_date:           deal_data.end_date || null,
      status:             'active',
      sales_user_id:      user.id,
      source:             deal_data.source || null,
      source_lead_id:     emptyToNull(deal_data.source_lead_id),
      downpayment_amount: deal_data.downpayment_amount || null,
      first_call_at:      deal_data.first_call_at || null,
      quote_reference:    deal_data.quote_reference || null,
      tl_department_id:   departmentId,
      traject_variant_id: emptyToNull(deal_data.traject_variant_id),
      discount_percentage: Number(deal_data.discount_percentage) || 0,
      sale_type:          deal_data.sale_type || 'domestic',
      payment_start_date:         deal_data.payment_start_date || null,
      payment_downpayment_amount: deal_data.payment_downpayment_amount || null,
      payment_downpayment_date:   deal_data.payment_downpayment_date || null,
      payment_term_count:         deal_data.payment_term_count || null,
      payment_term_start_date:    deal_data.payment_term_start_date || null,
      payment_term_amount:        deal_data.payment_term_amount || null,
      tl_push_status:     'not_pushed',
      tl_quotation_status: 'draft',
    };
    const { data: deal, error: dErr } = await supabaseAdmin.from('deals').insert(dealPayload).select('id').single();
    if (dErr) throw dErr;
    const dealId = deal.id;

    // 4. Offerte-regels (producten) persisteren voor de quotation-push.
    const lineRows = products.map((p, idx) => ({
      deal_id:            dealId,
      product_id:         p.product_id || null,
      product_name:       p.product_name || 'Product',
      quantity:           Number(p.quantity) || 1,
      unit_price:         Number(p.price_per_unit) || 0,
      vat_percentage:     p.vat_percentage ?? 21,
      price_includes_vat: !!p.price_includes_vat,
      position:           idx,
    }));
    if (lineRows.length) {
      const { error: liErr } = await supabaseAdmin.from('deal_line_items').insert(lineRows);
      if (liErr) throw liErr;
    }

    // 5. Optionele TL-offerte-push — synchroon via directe module-call.
    let tlResult = { success: false };
    const tokenExists = sync_to_tl ? !!(await getActiveToken()) : false;
    if (sync_to_tl && tokenExists) {
      try {
        tlResult = await pushQuotationToTl(dealId);
      } catch (err) {
        console.error('[sales-deal-create] TL quotation push exception:', err.message);
        tlResult = { success: false, error: err.message };
        // pushQuotationToTl update DB zelf bij fout, maar extra safety bij unexpected throw.
        await supabaseAdmin.from('deals').update({
          tl_quotation_status: 'draft',
          tl_push_error:       err.message.slice(0, 500),
        }).eq('id', dealId);
      }
    }

    const quotationStatus = tlResult.success
      ? (tlResult.tl_quotation_status || 'sent')
      : (sync_to_tl && tokenExists ? 'failed' : 'not_pushed');

    return res.status(200).json({
      customer_id:         customerId,
      deal_id:             dealId,
      tl_quotation_status: quotationStatus,
      tl_quotation_id:     tlResult.tl_quotation_id || null,
      tl_contact_id:       tlResult.tl_contact_id || null,
      tl_deal_id:          tlResult.tl_deal_id || null,
      tl_error:            tlResult.error || null,
    });
  } catch (err) {
    console.error('[sales-deal-create]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
