// api/setter-dashboard-metrics.js
//
// GET → KPI's voor Romy's setter-dashboard (uitsluitend gescoped op eigen
// boekingen). Manager+ mag ?setter_user_id=X opgeven om andere setters
// te bekijken (via setter.ledger.admin).
//
// Response:
//   { setter_user_id, boekingen: { week, maand }, opkomstpct, no_show_pct,
//     sales: { count, bruto_eur }, commissie_deze_maand, commissie_forecast }
//
// Gate: setter.ledger.view (Romy heeft die uit BP2-seed).
//
// INCASSO-VEILIG: leest follow_up_appointments + deals + invoices +
// setter_ledger_entries + subscriptions. Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function windowStart(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}
function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'setter.ledger.view'))) {
    return res.status(403).json({ error: 'Geen rechten (setter.ledger.view)' });
  }

  const requestedSetter = String(req.query?.setter_user_id || '').trim();
  let targetSetter = user.id;
  if (requestedSetter && requestedSetter !== user.id) {
    if (!UUID_RE.test(requestedSetter)) return res.status(400).json({ error: 'setter_user_id ongeldig' });
    if (!(await requirePermission(req, 'setter.ledger.admin'))) {
      return res.status(403).json({ error: 'Alleen setter.ledger.admin mag andere setters bekijken' });
    }
    targetSetter = requestedSetter;
  }

  try {
    const weekStart  = windowStart(7);
    const maandStart = windowStart(30);
    const mStart     = monthStart();

    // ── Boekingen deze week + deze maand (30-daagse window) ─────────────
    const [appWeekRes, appMaandRes, allApptsRes] = await Promise.all([
      supabaseAdmin.from('follow_up_appointments')
        .select('id', { count: 'exact', head: true })
        .eq('setter_user_id', targetSetter)
        .gte('scheduled_at', weekStart),
      supabaseAdmin.from('follow_up_appointments')
        .select('id', { count: 'exact', head: true })
        .eq('setter_user_id', targetSetter)
        .gte('scheduled_at', maandStart),
      // Statussen voor opkomst/no-show (laatste 90d — genoeg data zonder
      // hele historie te trekken).
      supabaseAdmin.from('follow_up_appointments')
        .select('status')
        .eq('setter_user_id', targetSetter)
        .gte('scheduled_at', windowStart(90))
        .limit(2000),
    ]);

    const boekingenWeek  = appWeekRes.count || 0;
    const boekingenMaand = appMaandRes.count || 0;

    // Opkomstpercentage = completed / (completed + no_show + cancelled).
    let completed = 0, noShow = 0, cancelled = 0;
    for (const r of (allApptsRes.data || [])) {
      const s = String(r.status || '').toLowerCase();
      if (s === 'completed') completed++;
      else if (s === 'no_show' || s === 'noshow') noShow++;
      else if (s === 'cancelled' || s === 'canceled') cancelled++;
    }
    const resolvedTotal = completed + noShow + cancelled;
    const opkomstPct = resolvedTotal > 0 ? Math.round((completed / resolvedTotal) * 100) : null;
    const noShowPct  = resolvedTotal > 0 ? Math.round((noShow    / resolvedTotal) * 100) : null;

    // ── Sales uit haar deals (aantal + bruto € via invoices.amount_total) ─
    const { data: deals } = await supabaseAdmin
      .from('deals')
      .select('id')
      .eq('setter_user_id', targetSetter);
    const dealIds = (deals || []).map((d) => d.id);
    let salesCount = 0;
    let salesBruto = 0;
    if (dealIds.length) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, amount_total, status')
        .in('deal_id', dealIds);
      salesCount = dealIds.length;
      salesBruto = round2((invs || []).reduce((s, i) => s + (Number(i.amount_total) || 0), 0));
    }

    // ── Commissie deze maand (vrijgegeven) + forecast (subscription-stand) ─
    const { data: entries } = await supabaseAdmin
      .from('setter_ledger_entries')
      .select('amount, status, created_at')
      .eq('setter_user_id', targetSetter)
      .gte('created_at', mStart);
    let commissieDezeMaand = 0;
    for (const e of (entries || [])) {
      if (e.status === 'vrijgegeven' || e.status === 'uitbetaald') {
        commissieDezeMaand += Number(e.amount) || 0;
      }
    }
    commissieDezeMaand = round2(commissieDezeMaand);

    // Forecast = (sub.amount × term_count - reeds_betaald) × pct
    // over ACTIEVE subs van haar deals. Hergebruikt setter-overview-logica.
    let commissieForecast = 0;
    if (dealIds.length) {
      const [subsRes, cfgRes, invsForPaidRes] = await Promise.all([
        supabaseAdmin.from('subscriptions')
          .select('deal_id, amount, term_count, status').in('deal_id', dealIds),
        supabaseAdmin.from('setter_config')
          .select('pct').eq('user_id', targetSetter).maybeSingle(),
        supabaseAdmin.from('invoices')
          .select('deal_id, amount_paid').in('deal_id', dealIds),
      ]);
      const pct = cfgRes?.data?.pct ? Number(cfgRes.data.pct) : 0;
      const paidByDeal = {};
      for (const i of (invsForPaidRes.data || [])) {
        paidByDeal[i.deal_id] = (paidByDeal[i.deal_id] || 0) + (Number(i.amount_paid) || 0);
      }
      for (const s of (subsRes.data || [])) {
        const st = String(s.status || '').toLowerCase();
        if (st === 'cancelled' || st === 'deactivated' || st === 'geannuleerd') continue;
        const totaal = (Number(s.amount) || 0) * (Number(s.term_count) || 0);
        const al     = paidByDeal[s.deal_id] || 0;
        commissieForecast += round2(Math.max(0, totaal - al) * pct / 100);
      }
      commissieForecast = round2(commissieForecast);
    }

    return res.status(200).json({
      setter_user_id: targetSetter,
      boekingen: { week: boekingenWeek, maand: boekingenMaand },
      opkomst_pct: opkomstPct,
      no_show_pct: noShowPct,
      sales: { count: salesCount, bruto_eur: salesBruto },
      commissie_deze_maand: commissieDezeMaand,
      commissie_forecast:   commissieForecast,
    });
  } catch (e) {
    console.error('[setter-dashboard-metrics]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
