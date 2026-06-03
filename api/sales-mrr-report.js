// api/sales-mrr-report.js
// GET → MRR-overzicht (maandelijkse abonnementen-omzet). Permission: sales.reports.view.
// Pure DB-aggregatie over subscriptions (geen TL-calls).
//
// MRR per sub = incl-BTW bedrag per termijn (line_items mix-safe, anders amount).
// Trend: 12 maanden terug t/m 12 vooruit — een sub telt mee in maand M als
// start_date <= eind-M EN (end_date null OF end_date >= begin-M).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function inclPerTerm(s) {
  const lis = Array.isArray(s.line_items) ? s.line_items : [];
  if (lis.length) return lis.reduce((a, li) => a + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  return (Number(s.amount) || 0) * (1 + (Number(s.vat_percentage) || 0) / 100);
}
function ymKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

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

  try {
    const { data: subs } = await supabaseAdmin.from('subscriptions')
      .select('id, deal_id, status, amount, vat_percentage, term_count, start_date, end_date, line_items, description').limit(5000);
    const list = subs || [];
    const active = list.filter(s => s.status === 'active');
    const cancelled = list.filter(s => s.status === 'cancelled');

    // KPI's.
    const currentMrr = active.reduce((a, s) => a + inclPerTerm(s), 0);
    const avgMrr = active.length ? currentMrr / active.length : 0;
    const cancellationRate = (active.length + cancelled.length) ? cancelled.length / (active.length + cancelled.length) : 0;

    // Maand-reeks: -12 .. +12.
    const now = new Date();
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
        const activeInMonth = s.start_date < m.nextStart && (!s.end_date || s.end_date >= m.start);
        if (activeInMonth) { mrr += inclPerTerm(s); count++; }
        if (s.start_date >= m.start && s.start_date < m.nextStart) added += inclPerTerm(s);
        if (s.end_date && s.end_date >= m.start && s.end_date < m.nextStart) churned += inclPerTerm(s);
      }
      return { period: m.key, mrr: Math.round(mrr * 100) / 100, count, new_mrr: Math.round(added * 100) / 100, churned_mrr: Math.round(churned * 100) / 100 };
    });

    // Per traject (actieve subs → deal.traject_variant_id → variant/traject label).
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
    const trajAgg = {};
    for (const s of active) {
      const deal = dealById[s.deal_id] || {};
      const label = deal.traject_variant_id ? (variantLabel[deal.traject_variant_id] || 'Onbekend traject') : 'Geen traject';
      (trajAgg[label] ||= { traject: label, mrr: 0, count: 0 });
      trajAgg[label].mrr += inclPerTerm(s); trajAgg[label].count++;
    }
    const by_traject = Object.values(trajAgg).map(t => ({ ...t, mrr: Math.round(t.mrr * 100) / 100 })).sort((a, b) => b.mrr - a.mrr);

    // Top 10 grootste actieve subs (+ klantnaam).
    const custIds = [...new Set(active.map(s => (dealById[s.deal_id] || {}).customer_id).filter(Boolean))];
    const custName = {};
    if (custIds.length) { const { data } = await supabaseAdmin.from('customers').select('id, first_name, last_name').in('id', custIds); for (const c of data || []) custName[c.id] = `${c.first_name || ''} ${c.last_name || ''}`.trim(); }
    const top_subs = active.map(s => {
      const deal = dealById[s.deal_id] || {};
      return { id: s.id, customer_id: deal.customer_id || null, customer_name: custName[deal.customer_id] || '—', description: s.description || '—', mrr: Math.round(inclPerTerm(s) * 100) / 100 };
    }).sort((a, b) => b.mrr - a.mrr).slice(0, 10);

    return res.status(200).json({
      kpis: {
        current_mrr: Math.round(currentMrr * 100) / 100,
        active_count: active.length,
        avg_mrr: Math.round(avgMrr * 100) / 100,
        cancellation_rate: Math.round(cancellationRate * 100) / 100,
      },
      trend, by_traject, top_subs,
    });
  } catch (e) {
    console.error('[sales-mrr-report]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
