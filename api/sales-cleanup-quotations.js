// api/sales-cleanup-quotations.js
// GET → alle accepted offertes ZONDER gekoppeld abo én ZONDER handmatige
// afgehandeld-markering (subscription_marked_done=false). Voor het
// Offerte-opschoning overzicht (bulk-afhandeling van de historische ~90).
//
// Extends het patroon van sales-pending-subscriptions door PER KLANT
// de bestaande subscriptions mee te sturen: aantal + optellingen. Zo
// zie je in één blik dat de klant al abo's heeft — en kun je de offerte
// veilig als afgehandeld markeren.
//
// Permission: sales.tab.subscriptions met OR-fallback naar
// sales.deal.view (parity met sales-pending-subscriptions).
//
// Response:
//   {
//     count: N,
//     items: [{
//       deal_id, customer_id, customer_name,
//       total_amount, accepted_at,
//       customer_subscriptions: {
//         count: <int>,
//         total_amount: <sum of subscription-lines amount>,
//         list: [{ id, description, start_date, end_date, total_amount }]
//       }
//     }, ...]
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const LIMIT = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.subscriptions');
  if (!allowed) allowed = await requirePermission(req, 'sales.deal.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (sales.tab.subscriptions / sales.deal.view)' });

  try {
    // 1) Alle accepted deals zonder handmatige afhandeling, niet gearchiveerd.
    //    LIMIT bewust ruim voor de ~90-batch; scale later door pagination toe te voegen.
    const { data: deals, error: dErr } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id, total_amount, tl_quotation_accepted_at, quote_reference')
      .eq('tl_quotation_status', 'accepted')
      .eq('subscription_marked_done', false)
      .is('archived_at', null)
      .order('tl_quotation_accepted_at', { ascending: false })
      .limit(LIMIT);
    if (dErr) throw new Error('deals lookup: ' + dErr.message);

    const dealIds = (deals || []).map((d) => d.id);
    if (!dealIds.length) return res.status(200).json({ count: 0, items: [] });

    // 2) Deals mét gekoppelde subs — die zijn "echt afgehandeld" en horen
    //    NIET in het opschoon-overzicht. Zelfde per-deal-precisie als
    //    sales-pending-subscriptions.
    const withSubs = new Set();
    {
      const { data: subs } = await supabaseAdmin
        .from('subscriptions')
        .select('deal_id')
        .in('deal_id', dealIds);
      for (const s of subs || []) if (s?.deal_id) withSubs.add(s.deal_id);
    }
    const openDeals = (deals || []).filter((d) => !withSubs.has(d.id));
    if (!openDeals.length) return res.status(200).json({ count: 0, items: [] });

    // 3) Klant-info voor display.
    const custIds = [...new Set(openDeals.map((d) => d.customer_id).filter(Boolean))];
    const custById = {};
    if (custIds.length) {
      const { data: customers } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name, email')
        .in('id', custIds);
      for (const c of customers || []) custById[c.id] = c;
    }

    // 4) Per klant: ALLE bestaande subscriptions (context om te zien of
    //    hij al abo's heeft — het signaal dat sales z'n offerte kan
    //    afvinken). We tellen aantal + totaal en tonen een korte lijst.
    const subsByCustomer = new Map();
    if (custIds.length) {
      const { data: subs } = await supabaseAdmin
        .from('subscriptions')
        .select('id, customer_id, description, start_date, end_date, total_amount, status')
        .in('customer_id', custIds)
        .neq('status', 'cancelled')
        .order('start_date', { ascending: false });
      for (const s of subs || []) {
        if (!s?.customer_id) continue;
        const bucket = subsByCustomer.get(s.customer_id) || { count: 0, total_amount: 0, list: [] };
        bucket.count += 1;
        bucket.total_amount += Number(s.total_amount) || 0;
        // Top 5 in de list — genoeg om context te tonen zonder de payload op te blazen.
        if (bucket.list.length < 5) {
          bucket.list.push({
            id: s.id,
            description: s.description || 'Abonnement',
            start_date: s.start_date || null,
            end_date: s.end_date || null,
            total_amount: Number(s.total_amount) || 0,
          });
        }
        subsByCustomer.set(s.customer_id, bucket);
      }
    }

    const items = openDeals.map((d) => {
      const c = custById[d.customer_id] || {};
      const bucket = subsByCustomer.get(d.customer_id) || { count: 0, total_amount: 0, list: [] };
      return {
        deal_id       : d.id,
        customer_id   : d.customer_id,
        customer_name : customerDisplayName(c, '—'),
        customer_email: c.email || null,
        total_amount  : Number(d.total_amount) || 0,
        accepted_at   : d.tl_quotation_accepted_at,
        quote_reference: d.quote_reference || null,
        customer_subscriptions: {
          count       : bucket.count,
          total_amount: Math.round(bucket.total_amount * 100) / 100,
          list        : bucket.list,
        },
      };
    });

    return res.status(200).json({ count: items.length, items });
  } catch (e) {
    console.error('[sales-cleanup-quotations]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
