// api/teamleader-push-deal.js
// POST { deal_id } → push deal + contact + subscriptions naar TL.
// Update deal.tl_deal_id / tl_pushed_at / tl_push_status / tl_push_error.
//
// Kern-logica zit in pushDealToTl(dealId) — exporteerbaar zodat
// sales-deal-create.js die direct kan aanroepen (geen interne HTTP-roundtrip).

import { getActiveToken } from './_lib/teamleader-token.js';
import { supabaseAdmin } from './supabase.js';
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getOrCreateContact, createDeal } from './_lib/teamleader-contact.js';

// Pure push-logica, GEEN req/res, GEEN auth-check (caller is verantwoordelijk).
// Returnt { success, tl_contact_id?, tl_deal_id?, subscriptions_count?, error? }.
// Update de deals-rij zelf op 'synced' (success) of 'failed' (fout) — nooit stuck.
export async function pushDealToTl(dealId) {
  try {
    const tok = await getActiveToken();
    if (!tok) throw new Error('Geen TL-token actief');

    // 1. Load deal + customer + subscriptions.
    const { data: deal, error: dErr } = await supabaseAdmin.from('deals').select('*').eq('id', dealId).maybeSingle();
    if (dErr || !deal) throw new Error('Deal niet gevonden');
    const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', deal.customer_id).maybeSingle();

    // Idempotency: al-gesyncte deal niet opnieuw pushen (voorkomt duplicate
    // contact + deal in TL bij handmatige retry).
    if (deal.tl_push_status === 'synced' && deal.tl_deal_id) {
      return {
        success:       true,
        already_synced: true,
        tl_contact_id: customer?.tl_contact_id || null,
        tl_deal_id:    deal.tl_deal_id,
        message:       'Deal was already synced to Teamleader, skipped duplicate push',
      };
    }

    const { data: subs } = await supabaseAdmin.from('subscriptions').select('*').eq('deal_id', dealId);

    // 2. TL-contact (hergebruik bestaande of maak aan).
    const tlContactId = await getOrCreateContact(customer);

    // 3. TL-deal (opportunity).
    const tlDealId = await createDeal(deal, tlContactId);

    // 4. Subscriptions — minimal best-effort. TL subscriptions.add bestaat maar
    //    is in-stappenwerk; voor MVP loggen we wat we zouden pushen en zetten
    //    status op 'synced' wanneer deal+contact OK zijn. Echte subscription-push
    //    in vervolg-PR (Fase 3).
    console.log(`[tl-push] ${subs?.length || 0} subscriptions: deferred push (Fase 3)`);

    await supabaseAdmin.from('deals').update({
      tl_deal_id:     tlDealId,
      tl_pushed_at:   new Date().toISOString(),
      tl_push_status: 'synced',
      tl_push_error:  null,
    }).eq('id', dealId);

    return {
      success:             true,
      tl_contact_id:       tlContactId,
      tl_deal_id:          tlDealId,
      subscriptions_count: subs?.length || 0,
    };
  } catch (e) {
    await supabaseAdmin.from('deals').update({
      tl_push_status: 'failed',
      tl_push_error:  e.message.slice(0, 500),
    }).eq('id', dealId);
    return { success: false, error: e.message };
  }
}

// Default handler voor handmatige retry (admin / deal-detail).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.subscription.push'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.subscription.push)' });
  }

  const { deal_id } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id verplicht' });

  const result = await pushDealToTl(deal_id);
  return res.status(result.success ? 200 : 500).json(result);
}
