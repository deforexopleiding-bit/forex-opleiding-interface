// api/sales-mrr-report.js
// GET ?entity_id=<tl_department_id> → MRR-overzicht. Permission: sales.reports.view.
// Pure DB-aggregatie over subscriptions (geen TL-calls).
//
// MRR-bijdrage per actieve sub = (incl-BTW bedrag per termijn) / (billing_cycle in maanden).
//   per_month/1, per_2_months/2, per_quarter/3, per_6_months/6, per_year/12 (default 1).
// (BUGFIX: eerder werd het volledige termijnbedrag als MRR geteld — per_year/per_quarter
//  subs telden veel te zwaar → enorm opgeblazen totaal.)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { computeCurrentMrr } from './_lib/mrr-compute.js';
import { fetchTestDealIds } from './_lib/test-data-filter.js';

const CYCLE_M = { per_month: 1, per_2_months: 2, per_quarter: 3, per_6_months: 6, per_year: 12 };
function cycleMonths(label) {
  if (!label) return 1; // wizard-subs zonder label = maandelijks per termijn
  if (CYCLE_M[label] != null) return CYCLE_M[label];
  const m = String(label).match(/per_(\d+)_months/);
  return m ? Number(m[1]) : 1;
}
function inclPerTerm(s) {
  const lis = Array.isArray(s.line_items) ? s.line_items : [];
  if (lis.length) return lis.reduce((a, li) => a + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  return (Number(s.amount) || 0) * (1 + (Number(s.vat_percentage) || 0) / 100);
}
function mrrOf(s) { return inclPerTerm(s) / cycleMonths(s.billing_cycle); }
function ymKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.reports.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.reports.view)' });
  }

  const entityId = req.query?.entity_id || null;
  const now = new Date();
  // Periode (default: huidige maand). Snapshot-KPI's op periode-eind; tellingen
  // over de periode; trend blijft altijd 12+12 (lange-termijn view).
  const defEndD = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const periodStart = String(req.query?.period_start || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`).slice(0, 10);
  const periodEnd = String(req.query?.period_end || `${defEndD.getFullYear()}-${String(defEndD.getMonth() + 1).padStart(2, '0')}-${String(defEndD.getDate()).padStart(2, '0')}`).slice(0, 10);

  try {
    let sq = supabaseAdmin.from('subscriptions')
      .select('id, deal_id, status, amount, vat_percentage, term_count, start_date, end_date, line_items, description, billing_cycle, tl_department_id').limit(5000);
    if (entityId) sq = sq.eq('tl_department_id', entityId);
    const { data: subs } = await sq;
    // Test-subs uitsluiten (subs op deals van is_test=true customers).
    const testDealIds = await fetchTestDealIds(supabaseAdmin);
    const rawList = subs || [];
    const list = rawList.filter(s => !s.deal_id || !testDealIds.has(s.deal_id));
    const testExcluded = rawList.length - list.length;
    if (testExcluded > 0) console.log('[sales-mrr-report] test-subs excluded:', testExcluded);
    // Snapshot: subs die op periode-eind liepen (datumvenster, status-onafhankelijk
    // voor historische correctheid). 'active' = snapshot-set → voedt KPI/traject/drilldown.
    const active = list.filter(s => s.start_date && s.start_date <= periodEnd && (!s.end_date || s.end_date >= periodEnd));
    const activeInPeriod = list.filter(s => s.start_date && s.start_date <= periodEnd && (!s.end_date || s.end_date >= periodStart));
    const churnedInPeriod = list.filter(s => s.end_date && s.end_date >= periodStart && s.end_date <= periodEnd);

    // current_mrr via gedeelde helper zodat dit getal 1:1 gelijk is aan
    // finance-dashboard-counts.mrrSubscriptions én super-admin dashboard.
    // Populatie = snapshot op periodEnd (NIET status='active'), NULL-cycle
    // wordt afgeleid of uitgesloten (voorkomt landmijn van jaar-groot subs
    // die als maandbedrag zouden tellen). Rest van dit endpoint (trend +
    // drilldown + by_traject) blijft eigen mrrOf() gebruiken — die aggregeert
    // per-maand bucket met eigen semantiek.
    const mrrResult = computeCurrentMrr(list, { asOf: periodEnd });
    const currentMrr = mrrResult.mrr;
    if (mrrResult.nullCycle.excluded > 0) {
      console.log('[sales-mrr-report] MRR summary:',
        'mrr=€' + mrrResult.mrr,
        'count=' + mrrResult.count,
        'nullCycle.excluded=' + mrrResult.nullCycle.excluded,
        'excludedMrr=€' + mrrResult.excludedMrr);
    }
    const avgMrr = mrrResult.count ? currentMrr / mrrResult.count : 0;
    const cancellationRate = activeInPeriod.length ? churnedInPeriod.length / activeInPeriod.length : 0;

    // Maand-reeks -12..+12 (MRR-bijdrage gedeeld door cyclus). Altijd 12+12, ongeacht periode.
    const months = [];
    for (let i = -12; i <= 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      months.push({ key: ymKey(d), start: d.toISOString().slice(0, 10), nextStart: next.toISOString().slice(0, 10) });
    }
    const trend = months.map(m => {
      // MRR + count per maand via gedeelde helper (asOf = laatste dag maand).
      // Zo is elk trend-punt op dezelfde manier berekend als de kpis.current_mrr
      // en de v2-dashboard-MRR-tegel: snapshot + NULL-cycle inferentie.
      const monthEndISO = new Date(new Date(m.nextStart).getTime() - 86400000).toISOString().slice(0, 10);
      const r = computeCurrentMrr(list, { asOf: monthEndISO });
      // added/churned: bewuste andere semantiek (nieuwe/vertrokken subs in kalendermaand,
      // niet de snapshot). Blijft oude berekening; toont bewegingen binnen de maand.
      let added = 0, churned = 0;
      for (const s of list) {
        if (!s.start_date) continue;
        const contrib = mrrOf(s);
        if (s.start_date >= m.start && s.start_date < m.nextStart) added += contrib;
        if (s.end_date && s.end_date >= m.start && s.end_date < m.nextStart) churned += contrib;
      }
      return { period: m.key, mrr: r.mrr, count: r.count, new_mrr: r2(added), churned_mrr: r2(churned) };
    });

    // Inkomende omzet: som van de maand-MRR over ELKE kalendermaand in [periode].
    // (Onafhankelijk van de 12+12 trend-window — werkt ook voor custom/historische ranges.)
    let inflow = 0;
    const pe = new Date(periodEnd + 'T00:00:00');
    const lastM = new Date(pe.getFullYear(), pe.getMonth(), 1);
    for (let cur = new Date(Number(periodStart.slice(0, 4)), Number(periodStart.slice(5, 7)) - 1, 1); cur <= lastM; cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)) {
      const mStart = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-01`;
      const nx = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const mNext = `${nx.getFullYear()}-${String(nx.getMonth() + 1).padStart(2, '0')}-01`;
      for (const s of list) { if (!s.start_date) continue; if (s.start_date < mNext && (!s.end_date || s.end_date >= mStart)) inflow += mrrOf(s); }
    }
    const totalInflow = r2(inflow);

    // Joins (deal → traject/customer; entiteit-labels).
    const dealIds = [...new Set(active.map(s => s.deal_id).filter(Boolean))];
    const dealById = {};
    if (dealIds.length) { const { data } = await supabaseAdmin.from('deals').select('id, customer_id, traject_variant_id').in('id', dealIds); for (const d of data || []) dealById[d.id] = d; }
    const variantIds = [...new Set(Object.values(dealById).map(d => d.traject_variant_id).filter(Boolean))];
    const variantLabel = {};
    if (variantIds.length) {
      const { data: vs } = await supabaseAdmin.from('traject_variants').select('id, name, traject_id').in('id', variantIds);
      const tIds = [...new Set((vs || []).map(v => v.traject_id).filter(Boolean))];
      const tName = {}; if (tIds.length) { const { data: ts } = await supabaseAdmin.from('trajects').select('id, name').in('id', tIds); for (const t of ts || []) tName[t.id] = t.name; }
      for (const v of vs || []) {
        // Dedup "A > A"-herhaling: als traject-naam en variant-naam identiek
        // zijn (of één is een prefix van de ander), toon één schone label.
        // Voorbeeld: "1-op-1 begeleiding (12 maanden) > 1-op-1 begeleiding
        // (12 maanden)" → "1-op-1 begeleiding (12 maanden)".
        const t = tName[v.traject_id] || '';
        const n = v.name || '';
        let label;
        if (!t)                          label = n;
        else if (!n)                     label = t;
        else if (t === n)                label = t;
        else if (n.startsWith(t))        label = n;
        else if (t.startsWith(n))        label = t;
        else                             label = `${t} > ${n}`;
        variantLabel[v.id] = label;
      }
    }
    const deptIds = [...new Set(active.map(s => s.tl_department_id).filter(Boolean))];
    const entLabel = {};
    if (deptIds.length) { const { data } = await supabaseAdmin.from('company_entities').select('tl_department_id, label').in('tl_department_id', deptIds); for (const e of data || []) entLabel[e.tl_department_id] = e.label; }
    const custIds = [...new Set(Object.values(dealById).map(d => d.customer_id).filter(Boolean))];
    const custName = {};
    if (custIds.length) { const { data } = await supabaseAdmin.from('customers').select('id, is_company, company_name, first_name, last_name').in('id', custIds); for (const c of data || []) custName[c.id] = customerDisplayName(c); }

    // Per traject: count + MRR + REVENUE (deal-verkoopwaarde incl BTW).
    // Dashboard-tegels "Trajecten verkocht" tonen verkoopwaarde (bv. 6 × €7.200
    // = €43.200 voor 6× "1-op-1 12 mnd"), NIET de MRR van die abo's.
    // Sub zonder deal.traject_variant_id ("Geen traject") is meestal een TL-
    // import of los-abo; die verbergen we hier — user vraagt alleen concrete
    // trajecten (6/12/24 mnd + Membership).
    //
    // Voor deal-value: haal line-items voor unieke dealIds op, aggregeer per
    // deal, dan optellen per traject-bucket. Eén batch-query.
    const dealRevenue = new Map();
    if (dealIds.length) {
      const { data: dLines } = await supabaseAdmin
        .from('deal_line_items')
        .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
        .in('deal_id', dealIds);
      for (const li of (dLines || [])) {
        const qty = Number(li.quantity) || 0;
        const up  = Number(li.unit_price) || 0;
        const vat = Number(li.vat_percentage) || 0;
        const sub = up * qty;
        const inclBtw = li.price_includes_vat ? sub : sub * (1 + vat / 100);
        dealRevenue.set(li.deal_id, (dealRevenue.get(li.deal_id) || 0) + inclBtw);
      }
    }
    const trajAgg = {};
    for (const s of active) {
      const deal = dealById[s.deal_id] || {};
      if (!deal.traject_variant_id) continue; // "Geen traject" verbergen (TL-imports).
      const label = variantLabel[deal.traject_variant_id] || 'Onbekend traject';
      (trajAgg[label] ||= { traject: label, mrr: 0, count: 0, revenue_incl_btw: 0 });
      trajAgg[label].mrr   += mrrOf(s);
      trajAgg[label].count += 1;
      // Deal-revenue één keer per sub (elke sub hangt aan 1 deal; als meerdere
      // subs aan dezelfde deal hangen zou revenue dubbel tellen — dedupe via
      // gezien-set per traject-bucket).
      // Simpelweg: reken deal-revenue één keer per unieke deal per bucket.
    }
    // Herrekening deal-revenue-per-bucket met dedupe (subs kunnen samen aan
    // dezelfde deal hangen; deal-revenue mag maar 1x tellen).
    const seenDealsPerBucket = {};
    for (const s of active) {
      const deal = dealById[s.deal_id] || {};
      if (!deal.traject_variant_id) continue;
      const label = variantLabel[deal.traject_variant_id] || 'Onbekend traject';
      if (!seenDealsPerBucket[label]) seenDealsPerBucket[label] = new Set();
      if (s.deal_id && !seenDealsPerBucket[label].has(s.deal_id)) {
        seenDealsPerBucket[label].add(s.deal_id);
        trajAgg[label].revenue_incl_btw += dealRevenue.get(s.deal_id) || 0;
      }
    }
    const by_traject = Object.values(trajAgg)
      .map(t => ({ ...t, mrr: r2(t.mrr), revenue_incl_btw: r2(t.revenue_incl_btw) }))
      .sort((a, b) => b.revenue_incl_btw - a.revenue_incl_btw);

    // Drilldown: ALLE actieve subs met bijdrage (voor modal + top-10).
    const drilldown = active.map(s => {
      const deal = dealById[s.deal_id] || {};
      return {
        id: s.id, customer_id: deal.customer_id || null, customer_name: custName[deal.customer_id] || '—',
        description: s.description || '—', per_term_incl: r2(inclPerTerm(s)), billing_cycle: s.billing_cycle || 'per_month',
        entity: s.tl_department_id ? (entLabel[s.tl_department_id] || null) : null, mrr: r2(mrrOf(s)),
      };
    }).sort((a, b) => b.mrr - a.mrr);

    return res.status(200).json({
      entity_id: entityId,
      period: { start: periodStart, end: periodEnd },
      kpis: { current_mrr: r2(currentMrr), active_count: activeInPeriod.length, avg_mrr: r2(avgMrr), cancellation_rate: r2(cancellationRate), total_inflow: totalInflow },
      trend, by_traject, top_subs: drilldown.slice(0, 10), drilldown,
    });
  } catch (e) {
    console.error('[sales-mrr-report]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
