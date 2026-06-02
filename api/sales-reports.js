// api/sales-reports.js
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=day|week|month
// Aggregeert alle Sales-rapport-widgets in 1 call. Permission: sales.reports.view.
//
// Aanpak: een handvol gebatchte queries (deals/bonuses/subs/customers/labels)
// + aggregatie in JS. Geen per-rij queries (N+1 vermeden). Bedragen zijn EXCL
// BTW op basis van deals.total_amount × (1 − korting%).
//
// Metric-definities (MVP — bewust pragmatisch, gedocumenteerd in het rapport):
//   pipeline_value   = som total_amount van OPEN offertes (draft/sent), snapshot
//   revenue_period   = som revenue van offertes met accepted_at in periode
//   bonus_pending    = som bonuses.status='pending' (snapshot)
//   funnel.paid      = getekende deals in periode met ≥1 subscription (proxy)
//   retention.rate   = renewed / (renewed + not_renewed) van subs geëindigd in periode

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SIGNED = ['accepted', 'signed'];
const OPEN = ['draft', 'sent'];

function dayStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function periodKey(dateStr, groupBy) {
  if (!dateStr) return null;
  const ds = dateStr.slice(0, 10);
  if (groupBy === 'day') return ds;
  if (groupBy === 'week') return isoWeekKey(ds);
  return ds.slice(0, 7); // month
}

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

  // Periode: default huidige maand t/m vandaag.
  const now = new Date();
  const from = (req.query?.from || dayStr(new Date(now.getFullYear(), now.getMonth(), 1))).slice(0, 10);
  const to = (req.query?.to || dayStr(now)).slice(0, 10);
  const groupBy = ['day', 'week', 'month'].includes(req.query?.group_by) ? req.query.group_by : 'month';
  const todayStr = dayStr(now);
  const in30 = dayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30));
  const inPeriod = (iso) => { if (!iso) return false; const d = iso.slice(0, 10); return d >= from && d <= to; };
  const revenueOf = (deal) => (Number(deal.total_amount) || 0) * (1 - (Number(deal.discount_percentage) || 0) / 100);

  try {
    // ── Gebatchte fetches ──
    const [{ data: deals }, { data: bonuses }, { data: subs }, { data: ents }, { data: variants }, { data: trajs }, { data: profs }, { data: customers }] = await Promise.all([
      supabaseAdmin.from('deals').select('id, customer_id, sales_user_id, tl_department_id, traject_variant_id, total_amount, discount_percentage, status, tl_quotation_status, source, created_at, tl_quotation_sent_at, tl_quotation_accepted_at, archived_at').is('archived_at', null).limit(5000),
      supabaseAdmin.from('bonuses').select('id, deal_id, sales_user_id, amount, status, created_at').limit(5000),
      supabaseAdmin.from('subscriptions').select('id, deal_id, status, start_date, end_date').limit(5000),
      supabaseAdmin.from('company_entities').select('tl_department_id, label'),
      supabaseAdmin.from('traject_variants').select('id, name, traject_id'),
      supabaseAdmin.from('trajects').select('id, name'),
      supabaseAdmin.from('profiles').select('id, full_name'),
      supabaseAdmin.from('customers').select('id, onboarding_status, onboarding_sent_at, onboarding_completed_at').not('onboarding_sent_at', 'is', null).limit(5000),
    ]);

    const dealList = deals || [];
    const entLabel = {}; for (const e of ents || []) entLabel[e.tl_department_id] = e.label;
    const trajName = {}; for (const t of trajs || []) trajName[t.id] = t.name;
    const variantById = {}; for (const v of variants || []) variantById[v.id] = { name: v.name, traject: trajName[v.traject_id] || null };
    const userName = {}; for (const p of profs || []) userName[p.id] = p.full_name;
    const subsByDeal = {}; for (const s of subs || []) (subsByDeal[s.deal_id] ||= []).push(s);

    const isSigned = (d) => SIGNED.includes(d.tl_quotation_status);
    const isQuoted = (d) => d.tl_quotation_status && d.tl_quotation_status !== 'draft' && d.tl_quotation_status !== 'no_quotation';

    // Subsets.
    const createdInPeriod = dealList.filter(d => inPeriod(d.created_at) && d.tl_quotation_status !== 'no_quotation');
    const signedInPeriod = dealList.filter(d => isSigned(d) && inPeriod(d.tl_quotation_accepted_at || d.created_at));

    // ── KPIs ──
    const pipeline_value = dealList.filter(d => OPEN.includes(d.tl_quotation_status)).reduce((s, d) => s + revenueOf(d), 0);
    const revenue_period = signedInPeriod.reduce((s, d) => s + revenueOf(d), 0);
    const bonus_pending = (bonuses || []).filter(b => b.status === 'pending').reduce((s, b) => s + (Number(b.amount) || 0), 0);

    // ── Funnel ──
    const funnel = {
      leads: createdInPeriod.length,
      quotations: createdInPeriod.filter(isQuoted).length,
      signed: createdInPeriod.filter(isSigned).length,
      paid: createdInPeriod.filter(d => isSigned(d) && (subsByDeal[d.id] || []).length > 0).length,
    };

    // ── Per sales-user ──
    const userAgg = {};
    const ensureUser = (uid) => (userAgg[uid] ||= { user_id: uid, user_name: userName[uid] || '—', quotations_count: 0, signed_count: 0, revenue: 0, bonus_pending: 0, bonus_paid: 0 });
    for (const d of createdInPeriod) { if (!d.sales_user_id) continue; const u = ensureUser(d.sales_user_id); if (isQuoted(d)) u.quotations_count++; if (isSigned(d)) u.signed_count++; }
    for (const d of signedInPeriod) { if (!d.sales_user_id) continue; ensureUser(d.sales_user_id).revenue += revenueOf(d); }
    for (const b of bonuses || []) {
      if (!b.sales_user_id || !inPeriod(b.created_at)) continue;
      const u = ensureUser(b.sales_user_id);
      if (b.status === 'pending') u.bonus_pending += Number(b.amount) || 0;
      else if (b.status === 'paid') u.bonus_paid += Number(b.amount) || 0;
    }
    const by_sales_user = Object.values(userAgg).map(u => ({
      ...u, revenue: Math.round(u.revenue * 100) / 100,
      conversion_rate: u.quotations_count ? Math.round((u.signed_count / u.quotations_count) * 100) / 100 : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    // ── Trend (op accepted_at van getekende deals + bonus.created_at) ──
    const trendMap = {};
    const ensureTrend = (k) => (trendMap[k] ||= { period: k, revenue: 0, deal_count: 0, bonus_total: 0 });
    for (const d of signedInPeriod) { const k = periodKey(d.tl_quotation_accepted_at || d.created_at, groupBy); if (!k) continue; const t = ensureTrend(k); t.revenue += revenueOf(d); t.deal_count++; }
    for (const b of bonuses || []) { if (!inPeriod(b.created_at)) continue; const k = periodKey(b.created_at, groupBy); if (!k) continue; ensureTrend(k).bonus_total += Number(b.amount) || 0; }
    const trend = Object.values(trendMap).map(t => ({ ...t, revenue: Math.round(t.revenue * 100) / 100, bonus_total: Math.round(t.bonus_total * 100) / 100 })).sort((a, b) => a.period.localeCompare(b.period));

    // ── Per entiteit (getekend in periode) ──
    const entAgg = {};
    for (const d of signedInPeriod) { const label = entLabel[d.tl_department_id] || 'Onbekend'; (entAgg[label] ||= { entity: label, revenue: 0, count: 0 }); entAgg[label].revenue += revenueOf(d); entAgg[label].count++; }
    const by_entity = Object.values(entAgg).map(e => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 })).sort((a, b) => b.revenue - a.revenue);

    // ── Top trajecten (signed numerator / created denominator in periode) ──
    const trajAgg = {};
    for (const d of createdInPeriod) { if (!d.traject_variant_id) continue; (trajAgg[d.traject_variant_id] ||= { variant_id: d.traject_variant_id, created: 0, sold_count: 0, total_revenue: 0 }); trajAgg[d.traject_variant_id].created++; }
    for (const d of signedInPeriod) { if (!d.traject_variant_id) continue; const a = (trajAgg[d.traject_variant_id] ||= { variant_id: d.traject_variant_id, created: 0, sold_count: 0, total_revenue: 0 }); a.sold_count++; a.total_revenue += revenueOf(d); }
    const top_trajecten = Object.values(trajAgg).map(a => {
      const v = variantById[a.variant_id] || {};
      return { traject_name: v.traject || '—', variant_name: v.name || '—', sold_count: a.sold_count, total_revenue: Math.round(a.total_revenue * 100) / 100, conversion_rate: a.created ? Math.round((a.sold_count / a.created) * 100) / 100 : 0 };
    }).sort((a, b) => b.total_revenue - a.total_revenue).slice(0, 10);

    // ── Retentie ──
    const expiring_in_30_days = (subs || []).filter(s => s.status === 'active' && s.end_date && s.end_date >= todayStr && s.end_date <= in30).length;
    // renewed/not_renewed: subs geëindigd in periode; renewed = zelfde klant heeft een sub die later start.
    const subsByCustomer = {};
    for (const s of subs || []) { const cid = (dealList.find(d => d.id === s.deal_id) || {}).customer_id; if (cid) (subsByCustomer[cid] ||= []).push(s); }
    let renewed = 0, not_renewed = 0;
    for (const s of subs || []) {
      if (!s.end_date || !inPeriod(s.end_date)) continue;
      const cid = (dealList.find(d => d.id === s.deal_id) || {}).customer_id;
      const peers = cid ? (subsByCustomer[cid] || []) : [];
      const hasRenewal = peers.some(p => p.id !== s.id && p.start_date && p.start_date >= s.end_date);
      if (hasRenewal) renewed++; else not_renewed++;
    }
    const retention = {
      expiring_in_30_days, renewed, not_renewed,
      rate: (renewed + not_renewed) ? Math.round((renewed / (renewed + not_renewed)) * 100) / 100 : 0,
    };

    // ── Onboarding (verzonden in periode) ──
    const onbSent = (customers || []).filter(c => inPeriod(c.onboarding_sent_at));
    const onbCompleted = onbSent.filter(c => c.onboarding_completed_at);
    const onboarding = { sent: onbSent.length, completed: onbCompleted.length, completion_rate: onbSent.length ? Math.round((onbCompleted.length / onbSent.length) * 100) / 100 : 0 };

    return res.status(200).json({
      period: { from, to, group_by: groupBy },
      kpis: {
        pipeline_value: Math.round(pipeline_value * 100) / 100,
        revenue_period: Math.round(revenue_period * 100) / 100,
        bonus_pending: Math.round(bonus_pending * 100) / 100,
        retention_rate: retention.rate,
      },
      funnel, by_sales_user, trend, by_entity, top_trajecten, retention, onboarding,
    });
  } catch (e) {
    console.error('[sales-reports]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
