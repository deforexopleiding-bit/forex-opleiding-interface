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

    // Mijn omzet deze maand + aantal deze maand + hoogste all-time (accepted/signed).
    // Fail-soft → 0/null bij fout of ontbrekende timestamps.
    let myRevenueMonth   = 0;
    let mySalesCountMonth = 0;
    let myHighestDeal    = null;   // { amount, customer_name, quote_reference }
    try {
      const { data: signedDeals } = await supabaseAdmin.from('deals')
        .select('id, total_amount, quote_reference, customer_id, tl_quotation_status, tl_quotation_signed_at, tl_quotation_accepted_at')
        .eq('sales_user_id', user.id)
        .in('tl_quotation_status', ['accepted', 'signed']);
      let highest = null;
      for (const d of signedDeals || []) {
        const ts = d.tl_quotation_signed_at || d.tl_quotation_accepted_at;
        if (ts && ts >= monthStart) {
          myRevenueMonth   += Number(d.total_amount || 0);
          mySalesCountMonth += 1;
        }
        const amt = Number(d.total_amount || 0);
        if (amt > 0 && (!highest || amt > Number(highest.total_amount || 0))) highest = d;
      }
      if (highest) {
        // Join customers voor de naam.
        let cname = '';
        if (highest.customer_id) {
          const { data: c } = await supabaseAdmin.from('customers')
            .select('is_company, company_name, first_name, last_name')
            .eq('id', highest.customer_id).maybeSingle();
          if (c) cname = c.is_company ? (c.company_name || '') : ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
        }
        myHighestDeal = {
          amount:          Math.round(Number(highest.total_amount || 0) * 100) / 100,
          customer_name:   cname || '—',
          quote_reference: highest.quote_reference || null,
        };
      }
    } catch (e) {
      console.warn('[sales-dashboard-metrics] revenue/count/highest fail-soft:', e?.message || e);
    }

    // Laatste 5 EIGEN offertes (nieuwste eerst).
    let myRecentQuotations = [];
    try {
      const { data: recent } = await supabaseAdmin.from('deals')
        .select('id, customer_id, total_amount, tl_quotation_status, created_at')
        .eq('sales_user_id', user.id).is('archived_at', null)
        .order('created_at', { ascending: false }).limit(5);
      const custIds = [...new Set((recent || []).map(r => r.customer_id).filter(Boolean))];
      const custMap = {};
      if (custIds.length) {
        const { data: cs } = await supabaseAdmin.from('customers')
          .select('id, is_company, company_name, first_name, last_name').in('id', custIds);
        for (const c of cs || []) {
          custMap[c.id] = c.is_company ? (c.company_name || '') : ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
        }
      }
      myRecentQuotations = (recent || []).map(r => ({
        id:            r.id,
        customer_name: custMap[r.customer_id] || '—',
        total_amount:  Math.round(Number(r.total_amount || 0) * 100) / 100,
        status:        r.tl_quotation_status || null,
        created_at:    r.created_at,
      }));
    } catch (e) {
      console.warn('[sales-dashboard-metrics] my_recent_quotations fail-soft:', e?.message || e);
    }

    // Klanten in onboarding (verzonden).
    const { count: onboardingCount } = await supabaseAdmin.from('customers')
      .select('id', { count: 'exact', head: true }).eq('onboarding_status', 'sent');

    // Retentie deze maand: aantal UNIEKE KLANTEN waarvan de LAATSTE actieve sub
    // (MAX(end_date)) binnen 30 dagen afloopt. Per-klant aggregatie → een klant met
    // een opvolgende sub (latere end_date) telt NIET mee.
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const { data: actSubs } = await supabaseAdmin.from('subscriptions').select('deal_id, end_date').eq('status', 'active').not('end_date', 'is', null);
    const relDealIds = [...new Set((actSubs || []).map(s => s.deal_id).filter(Boolean))];
    const custByDeal = {};
    if (relDealIds.length) { const { data: ds } = await supabaseAdmin.from('deals').select('id, customer_id').in('id', relDealIds); for (const d of ds || []) custByDeal[d.id] = d.customer_id; }
    const maxEndByCust = {};
    for (const s of actSubs || []) { const cid = custByDeal[s.deal_id]; if (!cid) continue; if (!maxEndByCust[cid] || s.end_date > maxEndByCust[cid]) maxEndByCust[cid] = s.end_date; }
    const retentionCount = Object.values(maxEndByCust).filter(e => e >= today && e <= in30).length;

    return res.status(200).json({
      my_open_quotations: myOpenQuotations,
      my_bonus_month: Math.round(myBonusMonth * 100) / 100,
      my_revenue_month: Math.round(myRevenueMonth * 100) / 100,
      my_sales_count_month: mySalesCountMonth,
      my_highest_deal: myHighestDeal,
      my_recent_quotations: myRecentQuotations,
      onboarding_count: onboardingCount || 0,
      retention_count: retentionCount,
    });
  } catch (e) {
    console.error('[sales-dashboard-metrics]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
