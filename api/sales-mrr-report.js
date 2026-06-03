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
    const list = subs || [];
    // Snapshot: subs die op periode-eind liepen (datumvenster, status-onafhankelijk
    // voor historische correctheid). 'active' = snapshot-set → voedt KPI/traject/drilldown.
    const active = list.filter(s => s.start_date && s.start_date <= periodEnd && (!s.end_date || s.end_date >= periodEnd));
    const activeInPeriod = list.filter(s => s.start_date && s.start_date <= periodEnd && (!s.end_date || s.end_date >= periodStart));
    const churnedInPeriod = list.filter(s => s.end_date && s.end_date >= periodStart && s.end_date <= periodEnd);

    const currentMrr = active.reduce((a, s) => a + mrrOf(s), 0);
    const avgMrr = active.length ? currentMrr / active.length : 0;
    const cancellationRate = activeInPeriod.length ? churnedInPeriod.length / activeInPeriod.length : 0;

    // Maand-reeks -12..+12 (MRR-bijdrage gedeeld door cyclus). Altijd 12+12, ongeacht periode.
    const months = [];
    for (let i = -12; i <= 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      months.push({ key: ymKey(d), start: d.toISOString().slice(0, 10), nextStart: next.toISOString().slice(0, 10) });
    }
    const trend = months.map(m => {
      let mrr = 0, count = 0, added = 0, churned = 0;
      for (const s of list) {
        if (!s.start_date) continue;
        const contrib = mrrOf(s);
        if (s.start_date < m.nextStart && (!s.end_date || s.end_date >= m.start)) { mrr += contrib; count++; }
        if (s.start_date >= m.start && s.start_date < m.nextStart) added += contrib;
        if (s.end_date && s.end_date >= m.start && s.end_date < m.nextStart) churned += contrib;
      }
      return { period: m.key, mrr: r2(mrr), count, new_mrr: r2(added), churned_mrr: r2(churned) };
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
      for (const v of vs || []) variantLabel[v.id] = [tName[v.traject_id], v.name].filter(Boolean).join(' > ');
    }
    const deptIds = [...new Set(active.map(s => s.tl_department_id).filter(Boolean))];
    const entLabel = {};
    if (deptIds.length) { const { data } = await supabaseAdmin.from('company_entities').select('tl_department_id, label').in('tl_department_id', deptIds); for (const e of data || []) entLabel[e.tl_department_id] = e.label; }
    const custIds = [...new Set(Object.values(dealById).map(d => d.customer_id).filter(Boolean))];
    const custName = {};
    if (custIds.length) { const { data } = await supabaseAdmin.from('customers').select('id, first_name, last_name').in('id', custIds); for (const c of data || []) custName[c.id] = `${c.first_name || ''} ${c.last_name || ''}`.trim(); }

    // Per traject.
    const trajAgg = {};
    for (const s of active) {
      const deal = dealById[s.deal_id] || {};
      const label = deal.traject_variant_id ? (variantLabel[deal.traject_variant_id] || 'Onbekend traject') : 'Geen traject';
      (trajAgg[label] ||= { traject: label, mrr: 0, count: 0 });
      trajAgg[label].mrr += mrrOf(s); trajAgg[label].count++;
    }
    const by_traject = Object.values(trajAgg).map(t => ({ ...t, mrr: r2(t.mrr) })).sort((a, b) => b.mrr - a.mrr);

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
