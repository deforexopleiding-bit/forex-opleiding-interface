// api/deals-search.js
//
// GET ?q=<text>&limit=25
//
// Lichtgewicht zoek-endpoint voor de "Sale koppelen"-modal in
// events-detail.html. Zoekt ALLE deals (dus ook van andere klanten dan
// de attendee's eigen customer_id) op:
//   - klantnaam (customers.first_name / last_name / company_name)
//   - klant-email (customers.email)
//   - deal-referentie/offertenummer (deals.reference / deals.tl_quotation_id)
//
// Response:
//   { items: [{ id, reference, tl_quotation_id, tl_quotation_status,
//               tl_quotation_accepted_at, created_at, total_incl,
//               customer_id, customer_name, customer_email }] }
//
// Permission: events.attendee.edit (dezelfde als 'Sale koppelen'-flow).
// Fail-soft: onbekende kolommen → skip die selectie, retourneer wat er is.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeDealTotals } from './_lib/deal-total.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'events.attendee.edit');
  if (!allowed) allowed = await requirePermission(req, 'events.event.edit');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const q = String(req.query?.q || '').trim();
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
  if (q.length < 2) return res.status(200).json({ items: [] });

  const safe = q.replace(/[%,]/g, '');
  const pattern = `*${safe}*`;

  try {
    // 1) Deals matchen op reference / tl_quotation_id direct.
    const dealMatchIds = new Set();
    try {
      const { data: byRef } = await supabaseAdmin
        .from('deals')
        .select('id')
        .or(`reference.ilike.${pattern},tl_quotation_id.ilike.${pattern}`)
        .limit(limit);
      for (const d of byRef || []) dealMatchIds.add(d.id);
    } catch (e) { console.warn('[deals-search ref]', e?.message); }

    // 2) Klanten matchen; hun deals meenemen.
    let customerIds = [];
    try {
      const { data: custs } = await supabaseAdmin
        .from('customers')
        .select('id')
        .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},company_name.ilike.${pattern},email.ilike.${pattern}`)
        .limit(limit);
      customerIds = (custs || []).map((c) => c.id);
    } catch (e) { console.warn('[deals-search cust]', e?.message); }

    if (customerIds.length > 0) {
      const { data: dealsForCust } = await supabaseAdmin
        .from('deals')
        .select('id')
        .in('customer_id', customerIds)
        .limit(limit * 2);
      for (const d of dealsForCust || []) dealMatchIds.add(d.id);
    }

    if (dealMatchIds.size === 0) return res.status(200).json({ items: [] });

    // 3) Ophalen van de deals + line items + customer-info.
    const ids = Array.from(dealMatchIds).slice(0, limit);
    const { data: deals, error: dealsErr } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id, reference, tl_quotation_id, tl_quotation_status, tl_quotation_accepted_at, discount_percentage, sale_type, created_at')
      .in('id', ids)
      .order('created_at', { ascending: false });
    if (dealsErr) throw new Error('deals: ' + dealsErr.message);

    const custIds = Array.from(new Set((deals || []).map((d) => d.customer_id).filter(Boolean)));
    const custById = new Map();
    if (custIds.length > 0) {
      const { data: custs } = await supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, company_name, email')
        .in('id', custIds);
      for (const c of custs || []) custById.set(c.id, c);
    }

    // Line items batch.
    const linesByDeal = new Map();
    {
      const { data: lines } = await supabaseAdmin
        .from('deal_line_items')
        .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
        .in('deal_id', ids);
      for (const li of lines || []) {
        const arr = linesByDeal.get(li.deal_id) || [];
        arr.push(li);
        linesByDeal.set(li.deal_id, arr);
      }
    }

    const items = (deals || []).map((d) => {
      const c = custById.get(d.customer_id) || null;
      const custName = c
        ? ((c.company_name || '').trim()
            || `${(c.first_name || '').trim()} ${(c.last_name || '').trim()}`.trim()
            || (c.email || ''))
        : '(onbekende klant)';
      let total_incl = null;
      try {
        const totals = computeDealTotals(d, linesByDeal.get(d.id) || []);
        total_incl = Number.isFinite(totals?.incl) ? Number(totals.incl) : null;
      } catch (_) {}
      return {
        id                    : d.id,
        reference             : d.reference || null,
        tl_quotation_id       : d.tl_quotation_id || null,
        tl_quotation_status   : d.tl_quotation_status || null,
        tl_quotation_accepted_at: d.tl_quotation_accepted_at || null,
        created_at            : d.created_at || null,
        total_incl,
        customer_id           : d.customer_id || null,
        customer_name         : custName,
        customer_email        : c?.email || null,
      };
    });

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[deals-search]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
