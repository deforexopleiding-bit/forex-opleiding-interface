// api/sales-subscriptions-list.js
// GET ?owned_by_me=true&status=active|cancelled|all → alle abonnementen met
// joins naar customers + deals + entiteit + line_items aggregate.
// Permission: sales.deal.view.
//
// FIX (subs-first query volgorde): eerder haalde dit endpoint ~1600 deals op
// en deed subscriptions.in('deal_id', [1600 ids]) — die IN-lijst laat
// PostgREST stil falen op de URL-lengte, resulterend in subs=null en een
// stil-lege response (200 met items:[]). Nu draaien we om: subs eerst
// (status-filter, limit 500) → dealIds ≤ 500 → veilig IN de deals-query.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

// Bedrag incl. BTW per termijn. Prefereer line_items (mix-safe per regel);
// val terug op amount + vat_percentage voor oude subs zonder line_items.
function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce((sum, li) => sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

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

  const ownedByMe = req.query?.owned_by_me === 'true';
  const status    = req.query?.status || 'all';
  const page     = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const rawSize  = parseInt(req.query?.page_size, 10) || 50;
  const pageSize = Math.min(500, Math.max(1, rawSize));
  const from     = (page - 1) * pageSize;
  const to       = from + pageSize - 1;

  try {
    // owned_by_me: prefetch de eigen deal_ids (klein), zodat we de subs-query
    // server-side kunnen filteren op deal_id IN (…). Zonder dit zou de count
    // niet kloppen (owned filtering gebeurde eerder client-side na de fetch).
    let ownedDealIds = null;
    if (ownedByMe) {
      const { data: ownedDeals } = await supabaseAdmin
        .from('deals').select('id').eq('sales_user_id', user.id).is('archived_at', null);
      ownedDealIds = [...new Set((ownedDeals || []).map(d => d.id))];
      if (ownedDealIds.length === 0) {
        return res.status(200).json({
          items: [], total: 0, page, page_size: pageSize, total_pages: 0,
        });
      }
    }

    // 1) Subscriptions eerst — status-filter, owned_by_me-filter, page/range.
    let subQ = supabaseAdmin.from('subscriptions')
      .select('id, deal_id, description, amount, vat_percentage, term_count, start_date, end_date, teamleader_subscription_id, status, line_items, created_at', { count: 'exact' })
      // Server-side ordering op created_at desc (nieuwste aangemaakt eerst),
      // consistent met de frontend-sortering sinds #726. Voorheen op
      // start_date desc: subs met verre-toekomst-startdatums vulden pagina 1
      // en recent aangemaakte subs met nabije startdatums leken te
      // "verdwijnen" achter latere pagina's.
      .order('created_at', { ascending: false })
      .range(from, to);
    if (status && status !== 'all') subQ = subQ.eq('status', status);
    if (ownedDealIds) subQ = subQ.in('deal_id', ownedDealIds);
    const { data: subs, count: subCount, error: subErr } = await subQ;
    if (subErr) {
      console.error('[sales-subscriptions-list] subs fetch:', subErr.message);
      return res.status(500).json({ error: 'subs fetch: ' + subErr.message });
    }
    if (!subs || !subs.length) {
      return res.status(200).json({
        items: [], total: subCount || 0, page, page_size: pageSize,
        total_pages: Math.ceil((subCount || 0) / pageSize),
      });
    }

    // 2) Deals via de kleine dealIds-set (≤500) — géén IN-overflow meer.
    const dealIds = [...new Set(subs.map((s) => s.deal_id).filter(Boolean))];
    let dealById = {};
    if (dealIds.length) {
      const { data: deals, error: dealErr } = await supabaseAdmin.from('deals')
        .select('id, customer_id, sales_user_id, tl_department_id, sale_type, archived_at')
        .in('id', dealIds)
        .is('archived_at', null);
      if (dealErr) {
        console.error('[sales-subscriptions-list] deals fetch:', dealErr.message);
        return res.status(500).json({ error: 'deals fetch: ' + dealErr.message });
      }
      for (const d of (deals || [])) dealById[d.id] = d;
    }

    // 3) owned_by_me wordt server-side afgehandeld via ownedDealIds. Filter
    //    hier alleen subs zonder deal-record uit (archived deal → sub blijft
    //    lokaal maar zonder joinbare deal-data).
    const filteredSubs = subs.filter((s) => dealById[s.deal_id]);

    // 4) Klanten + entiteit-labels (kleine IN-lijsten, veilig).
    const custIds = [...new Set(Object.values(dealById).map((d) => d.customer_id).filter(Boolean))];
    const deptIds = [...new Set(Object.values(dealById).map((d) => d.tl_department_id).filter(Boolean))];
    const custById = {};
    const deptByTl = {};
    if (custIds.length) {
      const { data, error } = await supabaseAdmin.from('customers')
        .select('id, is_company, company_name, first_name, last_name, email')
        .in('id', custIds);
      if (error) {
        console.error('[sales-subscriptions-list] customers fetch:', error.message);
        return res.status(500).json({ error: 'customers fetch: ' + error.message });
      }
      for (const c of (data || [])) custById[c.id] = c;
    }
    if (deptIds.length) {
      const { data, error } = await supabaseAdmin.from('company_entities')
        .select('tl_department_id, label')
        .in('tl_department_id', deptIds);
      if (error) {
        console.error('[sales-subscriptions-list] entities fetch:', error.message);
        return res.status(500).json({ error: 'entities fetch: ' + error.message });
      }
      for (const e of (data || [])) deptByTl[e.tl_department_id] = e.label;
    }

    const items = filteredSubs.map((s) => {
      const deal = dealById[s.deal_id] || {};
      const c    = custById[deal.customer_id] || {};
      return {
        id: s.id,
        deal_id: s.deal_id,
        customer_id: deal.customer_id || null,
        customer_name: customerDisplayName(c, '—'),
        customer_email: c.email || null,
        entity: deal.tl_department_id ? (deptByTl[deal.tl_department_id] || null) : null,
        description: s.description || null,
        line_items: Array.isArray(s.line_items) ? s.line_items : [],
        amount_incl: Math.round(inclPerTerm(s) * 100) / 100,
        term_count: s.term_count || 1,
        start_date: s.start_date || null,
        end_date: s.end_date || null,
        status: s.status || null,
        teamleader_subscription_id: s.teamleader_subscription_id || null,
        created_at: s.created_at || null,
      };
    });

    const totalCount = subCount || 0;
    return res.status(200).json({
      items,
      total       : totalCount,
      page,
      page_size   : pageSize,
      total_pages : Math.ceil(totalCount / pageSize),
    });
  } catch (e) {
    console.error('[sales-subscriptions-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
