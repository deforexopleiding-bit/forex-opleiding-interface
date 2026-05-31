// api/sales-deal-create.js
// POST { customer_data, deal_data, subscriptions[], products[], matched_customer_id?, tl_imported_contact_id?, sync_to_tl }
// → { customer_id, deal_id, subscription_ids[], tl_push_status, tl_deal_id?, tl_contact_id?, tl_error? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getActiveToken } from './_lib/teamleader-token.js';
import { pushDealToTl } from './teamleader-push-deal.js';

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
  const { customer_data = {}, deal_data = {}, subscriptions = [], products = [],
          matched_customer_id, tl_imported_contact_id, sync_to_tl = false } = body;

  if (!deal_data.source_lead_id) return res.status(400).json({ error: 'source_lead_id vereist' });
  if (!Array.isArray(products) || products.length === 0) return res.status(400).json({ error: 'minimaal 1 product vereist' });

  try {
    // 1. Customer: reuse OF create.
    let customerId = matched_customer_id || null;
    if (!customerId) {
      const custPayload = {
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
      source_lead_id:     deal_data.source_lead_id,
      downpayment_amount: deal_data.downpayment_amount || null,
      first_call_at:      deal_data.first_call_at || null,
      quote_reference:    deal_data.quote_reference || null,
      tl_push_status:     'not_pushed',
    };
    const { data: deal, error: dErr } = await supabaseAdmin.from('deals').insert(dealPayload).select('id').single();
    if (dErr) throw dErr;
    const dealId = deal.id;

    // 4. Subscriptions aanmaken.
    const subscriptionIds = [];
    for (const s of subscriptions) {
      const { data: sub } = await supabaseAdmin.from('subscriptions').insert({
        deal_id:        dealId,
        amount:         s.amount,
        vat_percentage: s.vat_percentage ?? 21,
        term_count:     s.term_count || 1,
        start_date:     s.start_date,
        status:         'active',
      }).select('id').single();
      if (sub) subscriptionIds.push(sub.id);
    }

    // 5. Optionele TL-push — synchroon via directe module-call (geen interne
    //    HTTP-roundtrip; die forwardde een lege auth-header → 401).
    let tlResult = { success: false };
    const tokenExists = sync_to_tl ? !!(await getActiveToken()) : false;
    if (sync_to_tl && tokenExists) {
      try {
        tlResult = await pushDealToTl(dealId);
      } catch (err) {
        console.error('[sales-deal-create] TL push exception:', err.message);
        tlResult = { success: false, error: err.message };
        // pushDealToTl update DB zelf bij fout, maar extra safety bij unexpected throw.
        await supabaseAdmin.from('deals').update({
          tl_push_status: 'failed',
          tl_push_error:  err.message.slice(0, 500),
        }).eq('id', dealId);
      }
    }

    const tlPushStatus = tlResult.success
      ? 'synced'
      : (sync_to_tl && tokenExists ? 'failed' : 'not_pushed');

    return res.status(200).json({
      customer_id:      customerId,
      deal_id:          dealId,
      subscription_ids: subscriptionIds,
      tl_push_status:   tlPushStatus,
      tl_contact_id:    tlResult.tl_contact_id || null,
      tl_deal_id:       tlResult.tl_deal_id || null,
      tl_error:         tlResult.error || null,
    });
  } catch (err) {
    console.error('[sales-deal-create]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
