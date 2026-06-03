// api/sales-dashboard-metrics.js
// GET → aggregaat-tellers voor het sales-dashboard. Permission: sales.deal.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.view'))) return res.status(403).json({ error: 'Geen rechten' });

  try {
    // Mijn open offertes (draft/sent).
    const { data: myQuotes } = await supabaseAdmin.from('deals')
      .select('id, tl_quotation_status').eq('sales_user_id', user.id).is('archived_at', null)
      .in('tl_quotation_status', ['draft', 'sent']);
    const myOpenQuotations = (myQuotes || []).length;

    // Mijn bonus deze maand (pending + paid).
    const monthStart = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); })();
    const { data: myBonuses } = await supabaseAdmin.from('bonuses')
      .select('amount, status, created_at').eq('sales_user_id', user.id).gte('created_at', monthStart)
      .in('status', ['pending', 'earned', 'invoiced', 'paid']);
    const myBonusMonth = (myBonuses || []).reduce((s, b) => s + Number(b.amount || 0), 0);

    // Klanten in onboarding (verzonden).
    const { count: onboardingCount } = await supabaseAdmin.from('customers')
      .select('id', { count: 'exact', head: true }).eq('onboarding_status', 'sent');

    // Retentie deze maand: ALLEEN ACTIEVE subscriptions die binnen 30 dagen aflopen
    // (eerder telde dit ook cancelled/paused/completed mee → te hoog, bv. '6' i.p.v. '0').
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const { data: endingSubs } = await supabaseAdmin.from('subscriptions')
      .select('deal_id, end_date').eq('status', 'active').gte('end_date', today).lte('end_date', in30);
    const retentionCount = new Set((endingSubs || []).map(s => s.deal_id)).size;

    return res.status(200).json({
      my_open_quotations: myOpenQuotations,
      my_bonus_month: Math.round(myBonusMonth * 100) / 100,
      onboarding_count: onboardingCount || 0,
      retention_count: retentionCount,
    });
  } catch (e) {
    console.error('[sales-dashboard-metrics]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
