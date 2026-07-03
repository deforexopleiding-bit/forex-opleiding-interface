// api/sales-retention.js
// GET ?owned_by_me= → klanten waarvan het LAATSTE actieve abonnement binnen 30 dagen
// afloopt. Aggregatie PER KLANT op MAX(end_date) van alle actieve subs: een klant met
// een opvolgende sub (latere end_date) valt dus weg uit de lijst. Permission: sales.customer.view.
//
// FIX (subs-first query volgorde): eerder haalde dit endpoint ~1600 deals op
// en deed subscriptions.in('deal_id', [1600 ids]) — die IN-lijst laat
// PostgREST stil falen op de URL-lengte → subs=null → items:[] (200). Nu
// draaien we om: actieve subs eerst → dealIds ≤ 500 → veilig IN de deals-
// query.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.customer.view'))) return res.status(403).json({ error: 'Geen rechten' });

  const ownedByMe = req.query?.owned_by_me === 'true';

  try {
    // 1) Actieve subs eerst (klein) — status='active' + end_date-scope.
    //    We willen álle actieve subs met end_date binnen 30 dagen OF reeds
    //    verlopen, zodat het per-klant MAX(end_date) bepalen correct is
    //    (een klant met een latere-eindigende sub moet uitvallen). Daarom
    //    filteren we hier NIET op end_date; dat gebeurt na de per-klant
    //    aggregatie. Limit 500 blijft ruim boven de reële actieve-set.
    const { data: subs, error: subErr } = await supabaseAdmin.from('subscriptions')
      .select('id, deal_id, end_date, start_date, description, status')
      .eq('status', 'active')
      .order('end_date', { ascending: true, nullsFirst: false })
      .limit(500);
    if (subErr) {
      console.error('[sales-retention] subs fetch:', subErr.message);
      return res.status(500).json({ error: 'subs fetch: ' + subErr.message });
    }
    if (!subs || !subs.length) return res.status(200).json({ items: [] });

    // 2) Deals via de kleine dealIds-set (≤500) — géén IN-overflow.
    const dealIds = [...new Set(subs.map((s) => s.deal_id).filter(Boolean))];
    let dealById = {};
    if (dealIds.length) {
      let dq = supabaseAdmin.from('deals')
        .select('id, customer_id, sales_user_id, traject_variant_id, tl_department_id, archived_at')
        .in('id', dealIds)
        .is('archived_at', null);
      if (ownedByMe) dq = dq.eq('sales_user_id', user.id);
      const { data: deals, error: dealErr } = await dq;
      if (dealErr) {
        console.error('[sales-retention] deals fetch:', dealErr.message);
        return res.status(500).json({ error: 'deals fetch: ' + dealErr.message });
      }
      for (const d of (deals || [])) dealById[d.id] = d;
    }
    if (!Object.keys(dealById).length) return res.status(200).json({ items: [] });

    // 3) Groepeer per klant; bepaal MAX(end_date) + verzamel subs.
    const byCust = {};
    for (const s of subs) {
      if (!s.end_date) continue;
      const deal = dealById[s.deal_id];
      if (!deal?.customer_id) continue; // deal weggefilterd door owned_by_me of archived
      const cid = deal.customer_id;
      const g = (byCust[cid] ||= { customer_id: cid, subs: [], maxEnd: null, maxDeal: null });
      g.subs.push({ description: s.description || '—', start_date: s.start_date, end_date: s.end_date });
      if (!g.maxEnd || s.end_date > g.maxEnd) { g.maxEnd = s.end_date; g.maxDeal = deal; }
    }

    const now = Date.now();
    const horizon = now + 30 * 86400000;
    // Alleen klanten waarvan de LAATSTE actieve sub <= 30 dagen weg is (incl. reeds
    // verlopen, voor de 'Verlopen'-pill). Klant met latere sub valt hier vanzelf weg.
    const groups = Object.values(byCust).filter((g) => g.maxEnd && new Date(g.maxEnd).getTime() <= horizon);
    if (!groups.length) return res.status(200).json({ items: [] });

    // 4) Joins: klant + entiteit + mentor + traject.
    const custIds = [...new Set(groups.map((g) => g.customer_id))];
    const custById = {};
    if (custIds.length) {
      const { data, error } = await supabaseAdmin.from('customers')
        .select('id, is_company, company_name, first_name, last_name, email, mentor_user_id')
        .in('id', custIds);
      if (error) {
        console.error('[sales-retention] customers fetch:', error.message);
        return res.status(500).json({ error: 'customers fetch: ' + error.message });
      }
      for (const c of (data || [])) custById[c.id] = c;
    }
    const deptIds = [...new Set(groups.map((g) => g.maxDeal?.tl_department_id).filter(Boolean))];
    const entByTl = {};
    if (deptIds.length) {
      const { data, error } = await supabaseAdmin.from('company_entities')
        .select('tl_department_id, label')
        .in('tl_department_id', deptIds);
      if (error) {
        console.error('[sales-retention] entities fetch:', error.message);
        return res.status(500).json({ error: 'entities fetch: ' + error.message });
      }
      for (const e of (data || [])) entByTl[e.tl_department_id] = e.label;
    }
    const variantIds = [...new Set(groups.map((g) => g.maxDeal?.traject_variant_id).filter(Boolean))];
    const variantLabel = {};
    if (variantIds.length) {
      const { data: vs, error: vErr } = await supabaseAdmin.from('traject_variants')
        .select('id, name, traject_id')
        .in('id', variantIds);
      if (vErr) {
        console.error('[sales-retention] variants fetch:', vErr.message);
        return res.status(500).json({ error: 'variants fetch: ' + vErr.message });
      }
      const tIds  = [...new Set((vs || []).map((v) => v.traject_id).filter(Boolean))];
      const tName = {};
      if (tIds.length) {
        const { data: ts, error: tErr } = await supabaseAdmin.from('trajects').select('id, name').in('id', tIds);
        if (tErr) {
          console.error('[sales-retention] trajects fetch:', tErr.message);
          return res.status(500).json({ error: 'trajects fetch: ' + tErr.message });
        }
        for (const t of (ts || [])) tName[t.id] = t.name;
      }
      for (const v of (vs || [])) variantLabel[v.id] = [tName[v.traject_id], v.name].filter(Boolean).join(' > ');
    }
    const mentorIds = [...new Set(Object.values(custById).map((c) => c.mentor_user_id).filter(Boolean))];
    const mentorById = {};
    if (mentorIds.length) {
      const { data, error } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', mentorIds);
      if (error) {
        console.error('[sales-retention] mentors fetch:', error.message);
        return res.status(500).json({ error: 'mentors fetch: ' + error.message });
      }
      for (const p of (data || [])) mentorById[p.id] = p.full_name;
    }

    const items = groups.map((g) => {
      const c    = custById[g.customer_id] || {};
      const dept = g.maxDeal?.tl_department_id || null;
      const vId  = g.maxDeal?.traject_variant_id || null;
      return {
        customer_id: g.customer_id,
        customer_name: customerDisplayName(c, '—'),
        customer_email: c.email || null,
        entity: dept ? (entByTl[dept] || null) : null,
        mentor_name: c.mentor_user_id ? (mentorById[c.mentor_user_id] || null) : null,
        traject_label: vId ? (variantLabel[vId] || null) : null,
        end_date: g.maxEnd,
        days_left: Math.ceil((new Date(g.maxEnd).getTime() - now) / 86400000),
        active_subs_count: g.subs.length,
        subs: g.subs.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date))),
      };
    }).sort((a, b) => a.days_left - b.days_left);

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[sales-retention]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
