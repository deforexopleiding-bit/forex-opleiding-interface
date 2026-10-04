// api/setter-commission-timeline.js
//
// BP3 v4 (2026-09-01) — Commissie-timeline voor de setter-Commissie-pagina.
// Geeft maand-buckets terug voor 6 maanden terug tot 18 maanden vooruit
// (25 buckets totaal: 6 verleden + huidige + 18 toekomst).
//
// Response:
//   {
//     setter_user_id, pct, months: [
//       { ym: 'YYYY-MM', label: 'mrt 2026', realized: <eur>, forecast: <eur> },
//       ...
//     ]
//   }
//
// Verleden buckets: som(setter_ledger_entries.amount) waar
//   status ∈ ('vrijgegeven','uitbetaald') EN betaal_datum (betaaldatum van
//   de factuur; vóór de migratie: created_at) in de maand.
// Toekomst buckets: het betaalplan van elke GEACCEPTEERDE sale (deals.
//   total_amount incl. BTW: reserveringsfee/aanbetaling/termijnen met
//   datums, zie _lib/setter-sale-plan.js), minus wat al ontvangen is,
//   × pct/100 in de maand van het geplande moment (achterstand → volgende
//   maand).
// Huidige maand mag beide bevatten (mix: al gerealiseerd + nog verwacht).
//
// Gate: setter.ledger.view. setter.ledger.admin mag ?setter_user_id=X.
//
// INCASSO-VEILIG: leest UITSLUITEND setter_config + setter_ledger_entries
// + deals + subscriptions + invoices. Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { betaaldBedrag } from './_lib/factuur-betaald.js';
import {
  SETTER_DEAL_COLS, isUitgeslotenDeal, quotationStatus, bouwBetaalplan, forecastUitPlan,
} from './_lib/setter-sale-plan.js';
import {
  laadLedgerRegels, maandVanRegel, laadCommissieData, koppelFacturenAanDeals,
} from './_lib/setter-commissie-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

const MONTHS_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function ymOf(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function labelOf(date) {
  return `${MONTHS_NL[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const CANCELLED = new Set(['cancelled', 'deactivated', 'geannuleerd']);

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
    const now = new Date();
    const currentY = now.getUTCFullYear();
    const currentM = now.getUTCMonth();

    // Bucket-lijst: 6 mnd verleden + huidige + 18 mnd toekomst = 25 buckets.
    const months = [];
    for (let off = -6; off <= 18; off++) {
      const d = new Date(Date.UTC(currentY, currentM + off, 1));
      months.push({
        ym:       ymOf(d),
        label:    labelOf(d),
        realized: 0,
        forecast: 0,
        _startUtc: Date.UTC(currentY, currentM + off, 1),
        _endUtc:   Date.UTC(currentY, currentM + off + 1, 1),
      });
    }
    const ymIndex = new Map(months.map((m, i) => [m.ym, i]));

    // ── Verleden + huidige maand: setter_ledger_entries ──────────────────
    // Maand = betaaldatum van de factuur (betaal_datum); vóór de migratie
    // valt laadLedgerRegels terug op created_at. Alleen t/m huidige maand.
    const currentYm = ymOf(new Date(Date.UTC(currentY, currentM, 1)));
    const entries = await laadLedgerRegels(supabaseAdmin, targetSetter);
    for (const e of entries) {
      if (e.status !== 'vrijgegeven' && e.status !== 'uitbetaald') continue;
      const ym = maandVanRegel(e);
      if (!ym || ym > currentYm) continue;
      const idx = ymIndex.get(ym);
      if (idx != null) months[idx].realized += Number(e.amount) || 0;
    }

    // ── setter-config voor pct ──────────────────────────────────────────
    const { data: cfg } = await supabaseAdmin
      .from('setter_config')
      .select('pct').eq('user_id', targetSetter).maybeSingle();
    const pct = cfg?.pct ? Number(cfg.pct) : 0;

    // ── Toekomst: uit het betaalplan van haar geaccepteerde sales ────────
    // Zelfde bron als de saleslijst in setter-overview: deals.total_amount
    // (incl. BTW) + aanbetaling/reserveringsfee/termijnen met datums.
    // Ontvangen geld (credit-veilig) wordt van voren af aan afgeboekt.
    // Niet-geaccepteerde offertes en sales waarvan alle abonnementen zijn
    // geannuleerd tellen niet mee.
    const { data: dealsRaw } = await supabaseAdmin
      .from('deals').select(SETTER_DEAL_COLS).eq('setter_user_id', targetSetter);
    const deals = (dealsRaw || []).filter((d) => !isUitgeslotenDeal(d) && !quotationStatus(d).pending);
    const dealIds = deals.map((d) => d.id);
    if (dealIds.length && pct > 0) {
      // Ontvangen via dezelfde factuurkoppeling als de commissie (deal_id /
      // abonnement / reserveringsfee-factuur).
      const commData = await laadCommissieData(supabaseAdmin, { setterIds: [targetSetter] });
      const koppeling = koppelFacturenAanDeals(commData);
      const paidByDeal = {};
      for (const i of commData.invoices) {
        const k = koppeling.get(i.id);
        if (k) paidByDeal[k.deal.id] = (paidByDeal[k.deal.id] || 0) + betaaldBedrag(i);
      }
      const subsByDeal = {};
      for (const s of commData.subs) (subsByDeal[s.deal_id] ||= []).push(s);

      for (const d of deals) {
        const subs = subsByDeal[d.id] || [];
        if (subs.length && subs.every((s) => CANCELLED.has(String(s.status || '').toLowerCase()))) continue;
        const plan = bouwBetaalplan(d, { pct });
        for (const b of forecastUitPlan(plan, { ontvangen: paidByDeal[d.id] || 0, now })) {
          const idx = ymIndex.get(b.ym);
          if (idx != null) months[idx].forecast += b.commissie;
        }
      }
    }

    // ── Cleanup + serialize ─────────────────────────────────────────────
    const out = months.map((m) => ({
      ym:       m.ym,
      label:    m.label,
      realized: round2(m.realized),
      forecast: round2(m.forecast),
    }));

    return res.status(200).json({
      setter_user_id: targetSetter,
      pct,
      months: out,
    });
  } catch (e) {
    console.error('[setter-commission-timeline]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
