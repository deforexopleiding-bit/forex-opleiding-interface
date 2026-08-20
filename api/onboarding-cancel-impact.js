// api/onboarding-cancel-impact.js
//
// GET — Read-only impact-preview voor de onboarding-cancel-cascade.
// Aparte endpoint zodat het OPENEN van de bevestigings-dialoog fysiek
// onmogelijk kan cascaden: geen POST, geen mutatie-pad, geen shared body-
// vlaggen met de destructieve /api/onboarding-cancel.
//
// Query: ?onboarding_id=<uuid>
// Response-shape: identiek aan de oude { preview:true, ... } respons van
// onboarding-cancel.js zodat de UI (modules/klanten-v2/views/modals/
// onboarding-detail.js) transparant kan overschakelen.
//
// Permission: getOnboardingScope.seesAll (zelfde als de execute-endpoint).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce(
      (a, li) => a + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100),
      0,
    );
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

function shouldCreditInvoice(inv) {
  const status = String(inv?.status || '').toLowerCase();
  if (!status) return false;
  if (status === 'concept' || status === 'paid') return false;
  const total    = Number(inv?.amount_total)    || 0;
  const credited = Number(inv?.credited_amount) || 0;
  if (total <= 0) return false;
  if (credited + 0.01 >= total) return false;
  return true;
}

// Read-only kopie van gatherContext uit onboarding-cancel.js. Bewuste
// duplicatie: de destructieve endpoint blijft ongewijzigd zodat we geen
// gedeelde mutatie-paden hoeven te introduceren.
async function gatherImpactContext(onboardingId) {
  const { data: ob, error: obErr } = await supabaseAdmin
    .from('onboardings')
    .select('id, customer_id, customer_name, mentor_user_id, bubble_user_id, status')
    .eq('id', onboardingId)
    .maybeSingle();
  if (obErr) throw new Error('onboarding fetch: ' + obErr.message);
  if (!ob) return { ob: null };
  const customerId = ob.customer_id || null;

  let invoices = [];
  if (customerId) {
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('id, tl_invoice_id, invoice_number, amount_total, credited_amount, status')
      .eq('customer_id', customerId)
      .limit(500);
    if (error) throw new Error('invoices fetch: ' + error.message);
    invoices = (data || []).filter(shouldCreditInvoice);
  }

  let subscriptions = [];
  if (customerId) {
    const { data: deals } = await supabaseAdmin
      .from('deals')
      .select('id')
      .eq('customer_id', customerId)
      .limit(200);
    const dealIds = (deals || []).map((d) => d.id);
    if (dealIds.length > 0) {
      const { data: subs, error: subErr } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, description, amount, vat_percentage, term_count, status, teamleader_subscription_id, line_items')
        .in('deal_id', dealIds)
        .neq('status', 'cancelled')
        .limit(200);
      if (subErr) throw new Error('subscriptions fetch: ' + subErr.message);
      subscriptions = subs || [];
    }
  }

  let deals = [];
  if (customerId) {
    const { data, error } = await supabaseAdmin
      .from('deals')
      .select('id, tl_deal_id, tl_quotation_id, quote_reference, archived_at')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .limit(200);
    if (error) throw new Error('deals fetch: ' + error.message);
    deals = data || [];
  }

  const subscription_value = r2(
    subscriptions.reduce((sum, s) => sum + inclPerTerm(s), 0),
  );

  return { ob, invoices, subscriptions, deals, subscription_value };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (manager/super_admin/admin vereist).' });
  }

  const onboardingId = typeof req.query?.onboarding_id === 'string'
    ? req.query.onboarding_id.trim()
    : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });
  }

  try {
    const ctx = await gatherImpactContext(onboardingId);
    if (!ctx.ob) return res.status(404).json({ error: 'Onboarding niet gevonden.' });

    const alreadyCancelled = String(ctx.ob.status || '').toLowerCase() === 'geannuleerd';

    return res.status(200).json({
      preview:             true,
      already_cancelled:   alreadyCancelled,
      customer_name:       ctx.ob.customer_name || null,
      bubble_user_id:      ctx.ob.bubble_user_id || null,
      invoices: ctx.invoices.map((i) => ({
        id:              i.id,
        tl_invoice_id:   i.tl_invoice_id,
        invoice_number:  i.invoice_number,
        amount_total:    r2(i.amount_total),
        credited_amount: r2(i.credited_amount || 0),
        status:          i.status,
        will_credit:     true,
      })),
      subscriptions: ctx.subscriptions.map((s) => ({
        id:                         s.id,
        teamleader_subscription_id: s.teamleader_subscription_id,
        description:                s.description,
        amount_incl:                r2(inclPerTerm(s)),
        status:                     s.status,
      })),
      subscription_value: ctx.subscription_value,
      offertes: ctx.deals.map((d) => ({
        id:                     d.id,
        tl_deal_id:             d.tl_deal_id,
        tl_quotation_id:        d.tl_quotation_id,
        tl_quotation_reference: d.quote_reference,
      })),
    });
  } catch (e) {
    console.error('[onboarding-cancel-impact]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout.' });
  }
}
