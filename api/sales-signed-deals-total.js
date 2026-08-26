// api/sales-signed-deals-total.js
// GET → totaal aanvaarde offertes (TL-fase "07. Aanvaard"), gefilterd op
// tl_quotation_accepted_at binnen periode. Sommeert INCL BTW per line-item.
//
// Query-params:
//   period       'today' | 'week' | 'month' | 'year' | 'all' (default 'month')
//                Week   = maandag t/m zondag (NL)
//                Month  = 1e t/m laatste dag van huidige maand
//                Year   = 1 jan t/m 31 dec huidig kalenderjaar
//   from,to      YYYY-MM-DD (inclusive both). Overschrijft period bij aanwezig.
//                Voor Custom-picker.
//   group_by     'month' (optioneel) → returnt trend[] per maand voor de
//                gekozen periode; standaard: alleen totaal.
//
// Response:
//   {
//     total_incl_vat: number,
//     count: number,
//     period, since, until,
//     test_excluded: number,
//     trend?: [{ period: 'YYYY-MM', total_incl_vat, count }]
//   }
//
// Permission: sales.view (fallback: dashboard.view).
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { fetchTestDealIds } from './_lib/test-data-filter.js';
import { classifyDeal, CATEGORY_ORDER, CATEGORY_LABELS } from './_lib/deal-classify.js';
import { computeSignedDealsTotal } from './_lib/sales-signed-deals-compute.js';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOfWeek(d) {
  const day = d.getDay(); // 0=zo, 1=ma, ..., 6=za
  const diff = day === 0 ? -6 : (1 - day);
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function startOfMonth(d)  { return new Date(d.getFullYear(), d.getMonth(),     1); }
function startOfNextMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function startOfYear(d)   { return new Date(d.getFullYear(), 0, 1); }
function startOfNextYear(d) { return new Date(d.getFullYear() + 1, 0, 1); }
function endOfWeek(monday) { const e = new Date(monday); e.setDate(monday.getDate() + 7); return e; }
function endOfDay(d)      { const e = new Date(d); e.setHours(0, 0, 0, 0); e.setDate(e.getDate() + 1); return e; }

// [sinceISO, untilISO) semantiek — half-open interval [start, end).
function rangeForPeriod(p) {
  const now = new Date();
  if (p === 'today') { const s = new Date(now); s.setHours(0,0,0,0); return [isoDate(s), isoDate(endOfDay(s))]; }
  if (p === 'week')  { const s = mondayOfWeek(now); return [isoDate(s), isoDate(endOfWeek(s))]; }
  if (p === 'month') { return [isoDate(startOfMonth(now)), isoDate(startOfNextMonth(now))]; }
  if (p === 'year')  { return [isoDate(startOfYear(now)),  isoDate(startOfNextYear(now))]; }
  return [null, null];
}

function lineInclVat(li) {
  const qty = Number(li.quantity) || 0;
  const up  = Number(li.unit_price) || 0;
  const vat = Number(li.vat_percentage) || 0;
  const sub = up * qty;
  return li.price_includes_vat ? sub : sub * (1 + vat / 100);
}

function ymKey(iso) { return String(iso).slice(0, 7); } // 'YYYY-MM'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // 2026-08-25: keys `sales.view` en `dashboard.view` staan NIET in de
  // RBAC-registry (registry.js) — ze zijn dus nooit aan iemand toegekend.
  // Alleen super_admin (RPC-bypass) kwam er nog doorheen; Dave/sales kreeg
  // 403 op de dashboard-tegels ("MOCK €0" i.p.v. live cijfers). Uitbreiden
  // met de wél-geregistreerde keys `sales.dashboard.view` en
  // `sales.reports.view` (registry.js:178,181) verruimt niks nieuws — sales
  // heeft die keys al via de v2-shell (Sales-module + dashboard-tegels
  // zichtbaar in de sidebar via roles: SAMS).
  const allowed = (await requirePermission(req, 'sales.view'))
    || (await requirePermission(req, 'dashboard.view'))
    || (await requirePermission(req, 'sales.dashboard.view'))
    || (await requirePermission(req, 'sales.reports.view'));
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    const q = req.query || {};
    const from = q.from ? String(q.from).slice(0, 10) : null;
    const to   = q.to   ? String(q.to).slice(0, 10)   : null;
    const periodRaw = String(q.period || 'month').toLowerCase();
    const period = ['today', 'week', 'month', 'year', 'all'].includes(periodRaw) ? periodRaw : 'month';
    const groupByRaw = String(q.group_by || '').toLowerCase();
    const groupByMonth    = groupByRaw === 'month';
    const groupByCategory = groupByRaw === 'category';

    // Custom range OF period-preset. Custom = inclusive to → daarom +1 dag
    // om als half-open [since, until) te matchen.
    let since, until;
    if (from && to) {
      since = from;
      const toDate = new Date(to + 'T00:00:00');
      toDate.setDate(toDate.getDate() + 1);
      until = isoDate(toDate);
    } else {
      [since, until] = rangeForPeriod(period);
    }

    const debugMode = String(q.debug || '') === '1';

    // 2026-08-25: standaard totaal-pad via _lib/sales-signed-deals-compute.js
    // (byte-parity met de logica hieronder — zelfde effectiveAcceptedAt,
    // testDealIds, lineInclVat, filter + rounding). group_by=month|category
    // en debug=1 blijven het bestaande pad gebruiken want die vereisen
    // per-deal-metadata die de compact-helper niet exposeet.
    if (!groupByMonth && !groupByCategory && !debugMode) {
      const out = await computeSignedDealsTotal({ supabaseAdmin, since, until });
      return res.status(200).json({ ...out, period, since, until });
    }

    // Stap 1: aanvaarde deals — status='accepted' + NIET declined_at/archived_at.
    // Ronde-21 fix PUNT-B: eerder telden deals mee die WEL geaccepteerd waren
    // maar later declined ÉN gearchiveerd — die zijn niet meer valide. Volgens
    // TL-officieel augustus reconstruct: exclude tl_quotation_declined_at !=
    // null én archived_at != null. Datum: accepted_at → signed_at → created_at
    // COALESCE in JS.
    const selectCols = 'id, customer_id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, tl_quotation_declined_at, archived_at, created_at, traject_variant_id, discount_percentage, sale_type, total_amount, quote_reference';
    let qy = supabaseAdmin
      .from('deals')
      .select(selectCols)
      .eq('tl_quotation_status', 'accepted')
      .is('tl_quotation_declined_at', null)
      .is('archived_at', null)
      .limit(20000);
    const { data: dealsRaw, error: dErr } = await qy;
    if (dErr) throw new Error('deals: ' + dErr.message);
    const effectiveAcceptedAt = (d) => d.tl_quotation_accepted_at || d.tl_quotation_signed_at || d.created_at || null;
    const inRange = (iso) => {
      if (!iso) return false;
      const d = String(iso).slice(0, 10);
      if (since && d < since) return false;
      if (until && d >= until) return false;
      return true;
    };
    const deals = (dealsRaw || []).filter(d => inRange(effectiveAcceptedAt(d)));

    // Test-deals uitsluiten (customer.is_test=true → deal-ids).
    const testDealIds = await fetchTestDealIds(supabaseAdmin);
    const clean = deals.filter(d => !testDealIds.has(d.id));
    const testExcluded = deals.length - clean.length;
    // Ronde-20 diagnose: log altijd de flow-counts zodat we kunnen bewijzen
    // dat een tegel-nul-uitkomst uit lege data komt en niet uit over-filtering.
    console.log('[sales-signed-deals-total]', {
      period, since, until, group_by: groupByMonth ? 'month' : 'none',
      raw_deals_from_db: (dealsRaw || []).length,
      after_date_range:  deals.length,
      test_customer_deal_ids: testDealIds.size,
      test_excluded_from_range: testExcluded,
      final_deal_count: clean.length,
    });

    const ids = clean.map(d => d.id);
    if (!ids.length) {
      return res.status(200).json({
        total_incl_vat: 0, count: 0, period, since, until, test_excluded: testExcluded,
        ...(groupByMonth ? { trend: [] } : {}),
      });
    }

    // Stap 2: line-items voor deze deals → som incl BTW.
    const { data: lines, error: lErr } = await supabaseAdmin
      .from('deal_line_items')
      .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
      .in('deal_id', ids);
    if (lErr) throw new Error('deal_line_items: ' + lErr.message);

    // Aggreate incl-BTW per deal, dan totaal + optionele trend.
    const perDeal = new Map();
    for (const li of (lines || [])) {
      perDeal.set(li.deal_id, (perDeal.get(li.deal_id) || 0) + lineInclVat(li));
    }
    let total = 0;
    for (const v of perDeal.values()) total += v;
    total = Math.round(total * 100) / 100;

    // Ronde-20 PUNT-4: by_category — aanvaarde deals per traject-classify.
    // Bron-van-waarheid voor "Trajecten verkocht" (was: snapshot van actieve
    // subs → miste 24-mnd deals waarvan de sub nog niet 'active' was in
    // periode-eind). classifyDeal gebruikt variant.default_duration_months +
    // line-item scan + regex → robuust voor TL-imports zonder variant_id.
    let by_category;
    if (groupByCategory) {
      // Fetch variants + line-items voor classify.
      const variantIds = [...new Set(clean.map(d => d.traject_variant_id).filter(Boolean))];
      const variantById = new Map();
      if (variantIds.length) {
        const { data: vs } = await supabaseAdmin
          .from('traject_variants')
          .select('id, name, default_duration_months, traject_id')
          .in('id', variantIds);
        for (const v of (vs || [])) variantById.set(v.id, v);
      }
      const linesByDealId = new Map();
      if (ids.length) {
        const { data: dLines } = await supabaseAdmin
          .from('deal_line_items')
          .select('deal_id, product_name, product_id, quantity, unit_price, vat_percentage, price_includes_vat')
          .in('deal_id', ids);
        for (const li of (dLines || [])) {
          if (!linesByDealId.has(li.deal_id)) linesByDealId.set(li.deal_id, []);
          linesByDealId.get(li.deal_id).push(li);
        }
      }
      const catAgg = Object.fromEntries(CATEGORY_ORDER.map(k => [k, { category: k, label: CATEGORY_LABELS[k], count: 0, total_incl_vat: 0 }]));
      const distribution = { by_source: { variant: 0, lineitems: 0, fallback: 0 } };
      for (const d of clean) {
        const lineItems = linesByDealId.get(d.id) || [];
        const { category, source } = classifyDeal(d, { lineItems, variantById });
        catAgg[category].count += 1;
        catAgg[category].total_incl_vat += perDeal.get(d.id) || 0;
        distribution.by_source[source] = (distribution.by_source[source] || 0) + 1;
      }
      by_category = CATEGORY_ORDER.map(k => ({
        ...catAgg[k],
        total_incl_vat: Math.round(catAgg[k].total_incl_vat * 100) / 100,
      }));
      console.log('[sales-signed-deals-total group=category]', {
        period, since, until, total_deals: clean.length,
        distribution: Object.fromEntries(CATEGORY_ORDER.map(k => [k, catAgg[k].count])),
        source_split: distribution.by_source,
      });
    }

    let trend;
    if (groupByMonth) {
      // Trend: één bucket per YYYY-MM binnen [since, until).
      const buckets = new Map();
      // Voor-init lege buckets zodat lege maanden ook een punt hebben.
      if (since && until) {
        let cur = new Date(since + 'T00:00:00');
        const stop = new Date(until + 'T00:00:00');
        while (cur < stop) {
          buckets.set(ymKey(isoDate(cur)), { period: ymKey(isoDate(cur)), total_incl_vat: 0, count: 0 });
          cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        }
      }
      for (const d of clean) {
        const key = ymKey(effectiveAcceptedAt(d));
        if (!buckets.has(key)) buckets.set(key, { period: key, total_incl_vat: 0, count: 0 });
        const b = buckets.get(key);
        b.total_incl_vat += perDeal.get(d.id) || 0;
        b.count += 1;
      }
      trend = Array.from(buckets.values())
        .sort((a, b) => a.period.localeCompare(b.period))
        .map(b => ({ ...b, total_incl_vat: Math.round(b.total_incl_vat * 100) / 100 }));
    }

    // Debug-mode: itemized lijst per deal (klantnaam + incl-bedrag + flags).
    let debug;
    if (debugMode) {
      const custIds = [...new Set(clean.map(d => d.customer_id).filter(Boolean))];
      const nameByCust = new Map();
      const testFlagByCust = new Map();
      if (custIds.length) {
        const { data: custs } = await supabaseAdmin
          .from('customers')
          .select('id, first_name, last_name, company_name, is_company, is_test')
          .in('id', custIds);
        for (const c of (custs || [])) {
          const nm = c.is_company ? (c.company_name || '') : `${c.first_name || ''} ${c.last_name || ''}`.trim();
          nameByCust.set(c.id, nm || '—');
          testFlagByCust.set(c.id, !!c.is_test);
        }
      }
      debug = clean.map(d => ({
        deal_id:                    d.id,
        klantnaam:                  nameByCust.get(d.customer_id) || '—',
        customer_id:                d.customer_id,
        is_test:                    testFlagByCust.get(d.customer_id) || false,
        quote_reference:            d.quote_reference,
        tl_quotation_status:        d.tl_quotation_status,
        tl_quotation_accepted_at:   d.tl_quotation_accepted_at,
        tl_quotation_declined_at:   d.tl_quotation_declined_at,
        archived_at:                d.archived_at,
        sale_type:                  d.sale_type,
        total_amount:               d.total_amount,
        bedrag_incl:                Math.round((perDeal.get(d.id) || 0) * 100) / 100,
      })).sort((a, b) => String(b.tl_quotation_accepted_at || '').localeCompare(String(a.tl_quotation_accepted_at || '')));
    }

    return res.status(200).json({
      total_incl_vat: total,
      count: ids.length,
      period, since, until,
      test_excluded: testExcluded,
      ...(trend ? { trend } : {}),
      ...(by_category ? { by_category } : {}),
      ...(debug ? { debug } : {}),
    });
  } catch (e) {
    console.error('[sales-signed-deals-total]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
