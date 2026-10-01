// api/setter-dashboard-metrics.js
//
// GET → KPI's voor Romy's setter-dashboard (uitsluitend gescoped op eigen
// boekingen). Manager+ mag ?setter_user_id=X opgeven om andere setters
// te bekijken (via setter.ledger.admin).
//
// Periodefilter (BP3 v4): ?period=dag|week|maand|jaar OF ?from&to (custom).
// Default 'maand'. De KPI's boekingen/opkomst/sales/commissie herberekenen
// voor de periode. Forecast is per-design vooruitkijkend en NIET begrensd
// door de periode.
//
// Response:
//   { setter_user_id, period, boekingen: { periode, alt_week, alt_maand },
//     opkomst_pct, no_show_pct, sales: { count, bruto_eur },
//     commissie_periode, commissie_forecast }
//
// Gate: setter.ledger.view (Romy heeft die uit BP2-seed).
//
// INCASSO-VEILIG: leest follow_up_appointments + deals + invoices +
// setter_ledger_entries + subscriptions. Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { parseSetterPeriod } from './_lib/setter-period.js';
import { betaaldBedrag } from './_lib/factuur-betaald.js';
import { isUitgeslotenDeal, quotationStatus } from './_lib/setter-sale-plan.js';
import { laadLedgerRegels, laadCommissieData, koppelFacturenAanDeals } from './_lib/setter-commissie-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function windowStart(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
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
    const period = parseSetterPeriod(req.query || {});

    // ── Boekingen in de periode + (voor UX-continuïteit) week+maand ────
    // Een BOEKING is de oorspronkelijke rij: parent_appointment_id IS NULL.
    // Sinds 1 okt 2026 erven verzette opvolgers de setter (api/_lib/setter-
    // keten.js); zonder dit filter telde één verzette boeking twee keer. De
    // statussen hieronder tellen de opvolgers wél mee — daar staat de afloop.
    const [appPeriodeRes, appWeekRes, appMaandRes, allApptsRes] = await Promise.all([
      supabaseAdmin.from('follow_up_appointments')
        .select('id', { count: 'exact', head: true })
        .eq('setter_user_id', targetSetter)
        .is('parent_appointment_id', null)
        .gte('scheduled_at', period.from)
        .lt('scheduled_at', period.to),
      supabaseAdmin.from('follow_up_appointments')
        .select('id', { count: 'exact', head: true })
        .eq('setter_user_id', targetSetter)
        .is('parent_appointment_id', null)
        .gte('scheduled_at', windowStart(7)),
      supabaseAdmin.from('follow_up_appointments')
        .select('id', { count: 'exact', head: true })
        .eq('setter_user_id', targetSetter)
        .is('parent_appointment_id', null)
        .gte('scheduled_at', windowStart(30)),
      // Statussen voor opkomst/no-show — begrensd door de gekozen periode.
      supabaseAdmin.from('follow_up_appointments')
        .select('status')
        .eq('setter_user_id', targetSetter)
        .gte('scheduled_at', period.from)
        .lt('scheduled_at', period.to)
        .limit(2000),
    ]);

    const boekingenPeriode = appPeriodeRes.count || 0;
    const boekingenWeek    = appWeekRes.count || 0;
    const boekingenMaand   = appMaandRes.count || 0;

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

    // ── Sales uit haar deals in de periode (created_at binnen periode) ──
    // Bruto = deals.total_amount (incl. BTW), zoals de saleslijst op de
    // Commissie-pagina. Gearchiveerde deals/afgewezen offertes tellen niet.
    const { data: dealsRaw } = await supabaseAdmin
      .from('deals')
      .select('id, created_at, total_amount, archived_at, tl_quotation_status')
      .eq('setter_user_id', targetSetter);
    const deals = (dealsRaw || []).filter((d) => !isUitgeslotenDeal(d));
    const dealsInPeriode = deals.filter((d) => {
      if (!d.created_at) return false;
      const t = new Date(d.created_at).getTime();
      return t >= new Date(period.from).getTime() && t < new Date(period.to).getTime();
    });
    const salesCount = dealsInPeriode.length;
    const salesBruto = round2(dealsInPeriode.reduce((s, d) => s + (Number(d.total_amount) || 0), 0));

    // ── Commissie in de periode (vrijgegeven+uitbetaald) ────────────────
    // Periode op BETAALdatum (betaal_datum; vóór de migratie created_at).
    const entries = await laadLedgerRegels(supabaseAdmin, targetSetter);
    const fromMs = new Date(period.from).getTime();
    const toMs = new Date(period.to).getTime();
    let commissiePeriode = 0;
    for (const e of entries) {
      if (e.status !== 'vrijgegeven' && e.status !== 'uitbetaald') continue;
      const t = new Date(e.betaal_datum || e.created_at).getTime();
      if (t >= fromMs && t < toMs) commissiePeriode += Number(e.amount) || 0;
    }
    commissiePeriode = round2(commissiePeriode);
    // Forecast leest ALLE deals (niet begrensd door periode — is vooruitkijkend).
    // Zelfde regel als setter-overview: geaccepteerde sales, (totaal −
    // ontvangen) × pct, niet als alle abonnementen geannuleerd zijn.
    const forecastDeals = deals.filter((d) => !quotationStatus(d).pending);
    const dealIds = forecastDeals.map((d) => d.id);
    let commissieForecast = 0;
    if (dealIds.length) {
      // Ontvangen via dezelfde factuurkoppeling als de commissie.
      const commData = await laadCommissieData(supabaseAdmin, { setterIds: [targetSetter] });
      const pct = Number(commData.configs[0]?.pct) || 0;
      const koppeling = koppelFacturenAanDeals(commData);
      const paidByDeal = {};
      for (const i of commData.invoices) {
        const k = koppeling.get(i.id);
        if (k) paidByDeal[k.deal.id] = (paidByDeal[k.deal.id] || 0) + betaaldBedrag(i);
      }
      const CANCELLED = new Set(['cancelled', 'deactivated', 'geannuleerd']);
      const subsByDeal = {};
      for (const s of commData.subs) (subsByDeal[s.deal_id] ||= []).push(s);
      for (const d of forecastDeals) {
        const subs = subsByDeal[d.id] || [];
        if (subs.length && subs.every((s) => CANCELLED.has(String(s.status || '').toLowerCase()))) continue;
        const al = paidByDeal[d.id] || 0;
        commissieForecast += round2(Math.max(0, (Number(d.total_amount) || 0) - al) * pct / 100);
      }
      commissieForecast = round2(commissieForecast);
    }

    return res.status(200).json({
      setter_user_id: targetSetter,
      period: { key: period.key, from: period.from, to: period.to },
      boekingen: { periode: boekingenPeriode, week: boekingenWeek, maand: boekingenMaand },
      opkomst_pct: opkomstPct,
      no_show_pct: noShowPct,
      sales: { count: salesCount, bruto_eur: salesBruto },
      commissie_periode:    commissiePeriode,
      // Backward-compat: oude UI-veldnaam blijft gevuld met periode-getal
      // wanneer periode='maand', anders met dezelfde waarde (frontend leest
      // 'commissie_periode' zodra 'ie de period-param stuurt).
      commissie_deze_maand: commissiePeriode,
      commissie_forecast:   commissieForecast,
    });
  } catch (e) {
    console.error('[setter-dashboard-metrics]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
