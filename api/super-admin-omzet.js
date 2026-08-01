// api/super-admin-omzet.js
//
// GET → omzet-samenvatting INCL BTW voor het super_admin-dashboard.
//
// Query: ?from=YYYY-MM-DD & ?to=YYYY-MM-DD & ?group_by=day|week|month
//        (defaults: from = 1e van deze maand, to = vandaag, group_by = month)
//
// Response 200:
//   {
//     kpis: {
//       los_incl_btw:       number   (som INCL BTW van getekende deals zonder subs, in periode)
//       abo_mrr_incl_btw:   number   (MRR-snapshot van actieve subs op einde periode, INCL BTW)
//       totaal_incl_btw:    number   (los + abo_mrr)
//       deal_count:         number   (# getekende deals in periode)
//       edge_deals_zonder_lineitems: number  (deals in periode zonder line_items — fallback op amount_total x 1.21)
//     },
//     trend: [{ period, los_incl_btw, abo_mrr_incl_btw }],
//     per_product: [{ product_key, label, count, revenue_incl_btw }]  (voor de prod-strip)
//   }
//
// BTW-methode: som per line = sum(amount * (1 + vat_percentage/100)) per deal_line_items rij.
// Consistent met api/_lib/customer-monthly-payment.js:41 en api/_lib/deal-total.js.
// Aannames:
//   - `deals.tl_quotation_accepted_at` (of `_signed_at`) is de teken-datum.
//   - Deal zonder line-items = fallback op total_amount * (1-discount) * 1.21 (edge-case, wordt geteld).
//   - Los vs abo: presence van rijen in `subscriptions.deal_id`.
//
// Permission: dashboard.module.access (management + super_admin hebben deze — RBAC).
//
// NB: deze endpoint doet BEWUST geen "sales-reports"-shape hergebruiken, want die
// levert EXCL BTW. Voor mixed-VAT-consistentie (9%/21%) MOET per-line worden
// gerekend, en dat geeft alleen deze route (deal_line_items join).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function dayStr(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function inPeriod(iso, from, to) {
  if (!iso) return false;
  const d = String(iso).slice(0, 10);
  return d >= from && d <= to;
}

function periodKey(dateStr, groupBy) {
  const d = new Date(dateStr);
  if (groupBy === 'day') return dayStr(d);
  if (groupBy === 'week') {
    const monday = new Date(d);
    const dow = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - dow);
    return dayStr(monday);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Mix-safe INCL-BTW som over line_items array (deal_line_items OR
// subscriptions.line_items jsonb). Fallback: geen items -> 0 (caller beslist).
function sumInclBtw(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return lineItems.reduce((acc, l) => {
    const amt = Number(l?.amount ?? l?.total_price ?? l?.unit_price ?? 0);
    const qty = Number(l?.quantity ?? 1);
    const vat = Number(l?.vat_percentage ?? 21);
    const line = amt * (Number.isFinite(qty) && qty > 0 ? qty : 1);
    return acc + line * (1 + vat / 100);
  }, 0);
}

function billingCycleMonths(cycle) {
  const map = { per_month: 1, per_2_months: 2, per_quarter: 3, per_6_months: 6, per_year: 12 };
  return map[cycle] || 1;
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
  // Dashboard-toegang volstaat — dezelfde gate als /api/dashboard-stats.
  if (!(await requirePermission(req, 'dashboard.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (dashboard.module.access)' });
  }

  const now = new Date();
  const from = (req.query?.from || dayStr(new Date(now.getFullYear(), now.getMonth(), 1))).slice(0, 10);
  const to   = (req.query?.to   || dayStr(now)).slice(0, 10);
  const groupBy = ['day', 'week', 'month'].includes(req.query?.group_by) ? req.query.group_by : 'month';

  try {
    // 1) Deals in periode via TL-accepted_at (fallback: signed_at).
    const { data: deals, error: dErr } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id, total_amount, discount_percentage, status, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, traject_variant_id, source, archived_at')
      .is('archived_at', null)
      .limit(5000);
    if (dErr) throw new Error('deals: ' + dErr.message);

    const acceptedInPeriod = (deals || []).filter((d) => {
      const signed = d.tl_quotation_accepted_at || d.tl_quotation_signed_at;
      return signed && inPeriod(signed, from, to);
    });
    const dealIds = acceptedInPeriod.map((d) => d.id);

    // 2) Line-items voor die deals (voor INCL-BTW-som).
    let linesByDeal = new Map();
    if (dealIds.length > 0) {
      const { data: lines } = await supabaseAdmin
        .from('deal_line_items')
        .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
        .in('deal_id', dealIds);
      for (const l of lines || []) {
        if (!linesByDeal.has(l.deal_id)) linesByDeal.set(l.deal_id, []);
        // Map naar sumInclBtw-schema: amount = unit_price (excl of incl-marker).
        // price_includes_vat=true → amount is al incl; converteer terug naar excl
        // door / (1+vat) omdat sumInclBtw altijd * (1+vat) doet.
        const rate = 1 + (Number(l.vat_percentage) || 0) / 100;
        const amt = l.price_includes_vat ? (Number(l.unit_price) || 0) / rate : Number(l.unit_price) || 0;
        linesByDeal.get(l.deal_id).push({
          amount: amt,
          quantity: Number(l.quantity) || 1,
          vat_percentage: Number(l.vat_percentage) || 21,
        });
      }
    }

    // 3) Subscriptions per deal (om los vs abo te bepalen).
    let subsByDeal = new Map();
    if (dealIds.length > 0) {
      const { data: subs } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, amount, vat_percentage, billing_cycle, line_items, status, start_date, end_date');
      for (const s of subs || []) {
        if (!subsByDeal.has(s.deal_id)) subsByDeal.set(s.deal_id, []);
        subsByDeal.get(s.deal_id).push(s);
      }
    }

    // 4) Aggregatie los vs abo per deal.
    let losInclBtw = 0;
    let edgeDealsZonderLineitems = 0;
    const trendMap = new Map();     // key -> { los, deals }
    for (const d of acceptedInPeriod) {
      const hasSubs = (subsByDeal.get(d.id) || []).length > 0;
      const lines   = linesByDeal.get(d.id) || [];
      let inclBtw;
      if (lines.length === 0) {
        // Fallback: geen line-items → gebruik total_amount * (1-disc) * 1.21.
        // Wordt geteld als edge-case in kpis zodat we het kunnen zien.
        edgeDealsZonderLineitems++;
        const disc = Number(d.discount_percentage) || 0;
        inclBtw = (Number(d.total_amount) || 0) * (1 - disc / 100) * 1.21;
      } else {
        inclBtw = sumInclBtw(lines);
      }
      if (!hasSubs) losInclBtw += inclBtw;
      // Trend: alleen 'los' hier (MRR-trend zit apart — voor snapshot van MRR
      // is een lange-tijdreeks nodig die we in dit endpoint niet uitrollen).
      const signed = d.tl_quotation_accepted_at || d.tl_quotation_signed_at;
      const pk = periodKey(signed, groupBy);
      if (!trendMap.has(pk)) trendMap.set(pk, { period: pk, los_incl_btw: 0, abo_mrr_incl_btw: 0 });
      if (!hasSubs) trendMap.get(pk).los_incl_btw += inclBtw;
    }

    // 5) MRR-snapshot: actieve subs op einde periode. Per sub: som line_items
    //    INCL BTW / cycle_months. Fallback: legacy amount + vat_percentage / cycle.
    let mrrInclBtw = 0;
    const { data: subsAll } = await supabaseAdmin
      .from('subscriptions')
      .select('id, deal_id, amount, vat_percentage, billing_cycle, line_items, status, start_date, end_date');
    const toDate = new Date(to);
    for (const s of subsAll || []) {
      // Actief op `to`-datum: status='active' en start <= to en (end null of end > to).
      if (s.status !== 'active') continue;
      if (s.start_date && new Date(s.start_date) > toDate) continue;
      if (s.end_date && new Date(s.end_date) <= toDate) continue;
      const cycleM = billingCycleMonths(s.billing_cycle);
      let perTerm = sumInclBtw(s.line_items);
      if (perTerm <= 0) {
        // Legacy: amount + vat_percentage veld.
        perTerm = (Number(s.amount) || 0) * (1 + (Number(s.vat_percentage) || 0) / 100);
      }
      mrrInclBtw += perTerm / cycleM;
    }

    // 6) Verkoop per producttype (voor prod-strip).
    // Groepeer op traject_variants.default_duration_months.
    // Mapping:
    //   6  → "1-op-1 · 6 mnd"
    //   12 → "1-op-1 · 12 mnd"
    //   24 → "1-op-1 · 24 mnd"
    //   overig / null / heeft membership-abo → "Memberships"
    const variantIds = [...new Set(acceptedInPeriod.map((d) => d.traject_variant_id).filter(Boolean))];
    let variantsById = new Map();
    if (variantIds.length > 0) {
      const { data: variants } = await supabaseAdmin
        .from('traject_variants')
        .select('id, name, default_duration_months, traject_id, trajects:traject_id(name)')
        .in('id', variantIds);
      for (const v of variants || []) variantsById.set(v.id, v);
    }
    const productBuckets = { m6: 0, m12: 0, m24: 0, mem: 0 };
    const productRevenue = { m6: 0, m12: 0, m24: 0, mem: 0 };
    for (const d of acceptedInPeriod) {
      const v = d.traject_variant_id ? variantsById.get(d.traject_variant_id) : null;
      const dur = v?.default_duration_months;
      const hasSubs = (subsByDeal.get(d.id) || []).length > 0;
      const trajectName = String(v?.trajects?.name || v?.name || '').toLowerCase();
      const isMembership = hasSubs && (trajectName.includes('membership') || trajectName.includes('lidmaatschap') || !dur);
      const lines = linesByDeal.get(d.id) || [];
      const inclBtw = lines.length > 0 ? sumInclBtw(lines)
        : (Number(d.total_amount) || 0) * (1 - (Number(d.discount_percentage) || 0) / 100) * 1.21;
      let key = 'mem';
      if (!isMembership) {
        if (dur === 6)  key = 'm6';
        else if (dur === 12) key = 'm12';
        else if (dur === 24) key = 'm24';
        else key = 'mem';
      }
      productBuckets[key]++;
      productRevenue[key] += inclBtw;
    }

    // Trend sortering.
    const trend = Array.from(trendMap.values()).sort((a, b) => a.period.localeCompare(b.period));

    return res.status(200).json({
      kpis: {
        los_incl_btw:                   Math.round(losInclBtw * 100) / 100,
        abo_mrr_incl_btw:               Math.round(mrrInclBtw * 100) / 100,
        totaal_incl_btw:                Math.round((losInclBtw + mrrInclBtw) * 100) / 100,
        deal_count:                     acceptedInPeriod.length,
        edge_deals_zonder_lineitems:    edgeDealsZonderLineitems,
      },
      trend,
      per_product: [
        { product_key: 'm6',  label: '1-op-1 · 6 mnd',   count: productBuckets.m6,  revenue_incl_btw: Math.round(productRevenue.m6  * 100) / 100 },
        { product_key: 'm12', label: '1-op-1 · 12 mnd',  count: productBuckets.m12, revenue_incl_btw: Math.round(productRevenue.m12 * 100) / 100 },
        { product_key: 'm24', label: '1-op-1 · 24 mnd',  count: productBuckets.m24, revenue_incl_btw: Math.round(productRevenue.m24 * 100) / 100 },
        { product_key: 'mem', label: 'Memberships',      count: productBuckets.mem, revenue_incl_btw: Math.round(productRevenue.mem * 100) / 100 },
      ],
      meta: { from, to, group_by: groupBy },
    });
  } catch (e) {
    console.error('[super-admin-omzet]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
