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

// PostgREST slikt lange IN-lijsten stil af op de URL-lengte-limiet.
// chunkedIn splitst een grote ids-set in batches van 200 en concat't de
// resultaten. `extra` is een optionele decorator voor de query (bv. andere
// filters); die wordt per batch opnieuw toegepast.
async function chunkedIn(table, column, ids, selectCols, extra) {
  const out = [];
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return out;
  const B = 200;
  for (let i = 0; i < uniq.length; i += B) {
    let q = supabaseAdmin.from(table).select(selectCols).in(column, uniq.slice(i, i + B));
    if (typeof extra === 'function') q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    if (data) out.push(...data);
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.customer.view'))) return res.status(403).json({ error: 'Geen rechten' });

  const ownedByMe    = req.query?.owned_by_me === 'true';
  // include_marked=0 verbergt reeds als 'Niet-verlengen' gemarkeerde klanten.
  // Default (afwezig of !=0): tonen mét badge.
  const includeMarked = String(req.query?.include_marked || '') !== '0';

  try {
    // 1) Subs eerst — status IN ('active','cancelled') zodat we ook de
    //    afgelopen abonnementen (churn) meenemen. Per klant bepalen we
    //    hierna MAX(end_date) over ALLE subs: een klant met een verlenging
    //    (nieuwere active sub in de toekomst) valt automatisch buiten het
    //    window; een klant met alleen een cancelled sub in het window
    //    verschijnt (churn-signaal). Limit 1000 dekt de gecombineerde set.
    const { data: subs, error: subErr } = await supabaseAdmin.from('subscriptions')
      .select('id, deal_id, end_date, start_date, description, status')
      .in('status', ['active', 'cancelled'])
      .order('end_date', { ascending: true, nullsFirst: false })
      .limit(1000);
    if (subErr) {
      console.error('[sales-retention] subs fetch:', subErr.message);
      return res.status(500).json({ error: 'subs fetch: ' + subErr.message });
    }
    if (!subs || !subs.length) return res.status(200).json({ items: [] });

    // 2) Deals via chunked IN — dealIds kan tot ~1000 zijn sinds we ook
    //    cancelled subs meenemen; PostgREST-URL-limiet halveren via batches
    //    van 200 voorkomt de stille 500.
    const dealIds = [...new Set(subs.map((s) => s.deal_id).filter(Boolean))];
    let dealById = {};
    if (dealIds.length) {
      const deals = await chunkedIn(
        'deals', 'id', dealIds,
        'id, customer_id, sales_user_id, traject_variant_id, tl_department_id, archived_at',
        (q) => (ownedByMe ? q.is('archived_at', null).eq('sales_user_id', user.id) : q.is('archived_at', null)),
      );
      for (const d of deals) dealById[d.id] = d;
    }
    if (!Object.keys(dealById).length) return res.status(200).json({ items: [] });

    // 3) Groepeer per klant; bepaal MAX(end_date) + verzamel subs. Bewaar
    //    de status van de laatst-eindigende sub (last_sub_status) zodat de
    //    UI onderscheid kan maken tussen 'afgelopen' (cancelled) en
    //    'loopt af binnen 30d' (active).
    const byCust = {};
    for (const s of subs) {
      if (!s.end_date) continue;
      const deal = dealById[s.deal_id];
      if (!deal?.customer_id) continue; // deal weggefilterd door owned_by_me of archived
      const cid = deal.customer_id;
      const g = (byCust[cid] ||= { customer_id: cid, subs: [], maxEnd: null, maxDeal: null, lastStatus: null });
      g.subs.push({ description: s.description || '—', start_date: s.start_date, end_date: s.end_date, status: s.status });
      if (!g.maxEnd || s.end_date > g.maxEnd) {
        g.maxEnd = s.end_date; g.maxDeal = deal; g.lastStatus = s.status;
      }
    }

    const now = Date.now();
    const horizon = now + 30 * 86400000;
    // Retentie-window: klanten met maxEnd tussen 2026-01-01 en (nu + 30d).
    // - Ondergrens 2026-01-01: sales pakt sinds dit jaar alle afgelopen +
    //   binnenkort-aflopende cases mee.
    // - Bovengrens now+30d: klanten die verlengd zijn (nieuwe active sub met
    //   latere end_date) vallen automatisch weg — dat is gewenst gedrag
    //   (verlengd = uit de lijst).
    const WINDOW_FROM = '2026-01-01';
    const horizonIso  = new Date(horizon).toISOString().slice(0, 10);
    const groups = Object.values(byCust).filter((g) =>
      g.maxEnd && g.maxEnd >= WINDOW_FROM && g.maxEnd <= horizonIso
    );
    if (!groups.length) return res.status(200).json({ items: [] });

    // 4) Joins: klant + entiteit + mentor + traject.
    const custIds = [...new Set(groups.map((g) => g.customer_id))];
    const custById = {};
    // Retention-vlag kolommen zijn optioneel — als de migratie nog niet
    // gedraaid heeft (42703), val terug op de core-select zonder de velden.
    // Beide paden lopen via chunkedIn (200/batch) tegen IN-overflow.
    let retentionColsAvailable = true;
    if (custIds.length) {
      const richCols = 'id, is_company, company_name, first_name, last_name, email, mentor_user_id, retention_not_renewing, retention_marked_at, retention_marked_by';
      const coreCols = 'id, is_company, company_name, first_name, last_name, email, mentor_user_id';
      try {
        const rows = await chunkedIn('customers', 'id', custIds, richCols);
        for (const c of rows) custById[c.id] = c;
      } catch (e) {
        // Detecteer 42703 (kolom ontbreekt) via de eigen error-message van
        // chunkedIn — die neemt de PostgREST-message over.
        if (/42703|column .* does not exist|retention_/i.test(e.message || '')) {
          retentionColsAvailable = false;
          const rows2 = await chunkedIn('customers', 'id', custIds, coreCols);
          for (const c of rows2) custById[c.id] = c;
        } else {
          throw e;
        }
      }
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

    let items = groups.map((g) => {
      const c    = custById[g.customer_id] || {};
      const dept = g.maxDeal?.tl_department_id || null;
      const vId  = g.maxDeal?.traject_variant_id || null;
      const activeSubs = g.subs.filter((s) => s.status === 'active').length;
      return {
        customer_id: g.customer_id,
        customer_name: customerDisplayName(c, '—'),
        customer_email: c.email || null,
        entity: dept ? (entByTl[dept] || null) : null,
        mentor_name: c.mentor_user_id ? (mentorById[c.mentor_user_id] || null) : null,
        traject_label: vId ? (variantLabel[vId] || null) : null,
        end_date: g.maxEnd,
        days_left: Math.ceil((new Date(g.maxEnd).getTime() - now) / 86400000),
        // Status van de laatst-eindigende sub: 'active' (loopt af) of
        // 'cancelled' (al afgelopen). UI kan hiermee onderscheid tonen.
        last_sub_status  : g.lastStatus || null,
        active_subs_count: activeSubs,
        total_subs_count : g.subs.length,
        subs: g.subs.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date))),
        // Handmatige 'Niet-verlengen'-markering (fail-soft: false/null als
        // kolommen ontbreken in dit schema).
        retention_not_renewing: c.retention_not_renewing === true,
        retention_marked_at   : c.retention_marked_at || null,
        retention_marked_by   : c.retention_marked_by || null,
      };
    });
    // Optioneel: verberg reeds-gemarkeerde klanten.
    if (!includeMarked) items = items.filter((i) => !i.retention_not_renewing);
    // Sortering: end_date ascending (soonest eerst).
    items.sort((a, b) => String(a.end_date || '').localeCompare(String(b.end_date || '')));

    return res.status(200).json({
      items,
      retention_columns_available: retentionColsAvailable,
    });
  } catch (e) {
    console.error('[sales-retention]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
