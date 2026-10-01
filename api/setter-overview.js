// api/setter-overview.js
//
// GET ?setter_user_id=<uuid>  (optioneel — default: user zelf)
//
// Retourneert Romy's overzicht met de 4 getallen:
//   - uitbetaald_totaal       — sum(amount) WHERE status='uitbetaald'
//   - deze_maand_te_ontvangen — sum(amount) WHERE status='vrijgegeven'
//   - forecast_nog_te_verwachten — (deal.total_amount − ontvangen) × pct over
//                                  GEACCEPTEERDE sales (incl. BTW)
//   - vervallen_door_annulering — idem, deals waarvan alle abonnementen zijn
//                                  geannuleerd
//   (+ in_afwachting_offerte — idem, offerte nog niet geaccepteerd)
// Plus ledger-regels en de saleslijst met per sale het betaalplan
// (_lib/setter-sale-plan.js) voor het detail.
//
// Gate:
//   - setter.ledger.view — setter zelf ziet eigen data.
//   - setter.ledger.admin — manager+ mag andere setters bekijken.
//
// INCASSO-VEILIG: leest UITSLUITEND setter_ledger_entries + setter_config
// + deals + traject_variants + subscriptions + invoices + customers.
// Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { parseSetterPeriod } from './_lib/setter-period.js';
import { betaaldBedrag } from './_lib/factuur-betaald.js';
import { isUitgeslotenDeal, bouwSaleRegel, klantNaam, SETTER_DEAL_COLS } from './_lib/setter-sale-plan.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

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

    // ── Setter-config voor pct ────────────────────────────────────────────
    const { data: cfg } = await supabaseAdmin
      .from('setter_config')
      .select('user_id, pct, is_active, effective_from')
      .eq('user_id', targetSetter)
      .maybeSingle();
    const pct = cfg?.pct ? Number(cfg.pct) : 0;
    const config = cfg
      ? { pct, is_active: !!cfg.is_active, effective_from: cfg.effective_from || null }
      : null;

    // ── Ledger totals + regels ────────────────────────────────────────────
    // Ledger-entries in de periode (bepaalt uitbetaald/vrijgegeven totalen
    // + de regels-lijst). Forecast + vervallen blijven vooruitkijkend.
    const { data: entries } = await supabaseAdmin
      .from('setter_ledger_entries')
      .select('id, deal_id, customer_id, invoice_id, payment_id, basis, pct, amount, status, created_at, paid_at')
      .eq('setter_user_id', targetSetter)
      .gte('created_at', period.from)
      .lt('created_at', period.to)
      .order('created_at', { ascending: false })
      .limit(500);
    const rows = entries || [];

    let uitbetaald = 0;
    let vrijgegeven = 0;
    for (const r of rows) {
      const a = Number(r.amount) || 0;
      if (r.status === 'uitbetaald') uitbetaald += a;
      else if (r.status === 'vrijgegeven') vrijgegeven += a;
    }

    // ── Sales + forecast + vervallen — via deals (incl. BTW) ─────────────
    // Deals worden NIET begrensd door de periode: forecast is vooruitkijkend
    // en de sales-lijst laat álle geattribueerde deals zien zodat een sale
    // ook direct zichtbaar is vóór de eerste betaling.
    //
    // Bedrag = deals.total_amount (INCL. BTW — deal_line_items hebben
    // price_includes_vat=true). Vroeger: Σ facturen óf Σ abonnement×termijnen
    // (EXCL. BTW) → een sale zonder abonnement (offerte geaccepteerd, wizard
    // nog niet gedraaid) stond op € 0. Gearchiveerde deals en afgewezen
    // offertes vallen eruit (isUitgeslotenDeal).
    const { data: dealsRaw, error: dealsErr } = await supabaseAdmin
      .from('deals')
      .select(SETTER_DEAL_COLS)
      .eq('setter_user_id', targetSetter)
      .order('created_at', { ascending: false });
    if (dealsErr) throw new Error('deals: ' + dealsErr.message);
    const deals = (dealsRaw || []).filter((d) => !isUitgeslotenDeal(d));
    const dealIds = deals.map((d) => d.id);

    const ontvangenByDeal = {};
    const subsByDeal = new Map();
    const trajectNaam = {};
    if (dealIds.length) {
      const variantIds = [...new Set(deals.map((d) => d.traject_variant_id).filter(Boolean))];
      const [subsRes, invsRes, tvRes] = await Promise.all([
        supabaseAdmin.from('subscriptions').select('id, deal_id, status').in('deal_id', dealIds),
        // Ontvangen per deal: credit-veilig via betaaldBedrag (een volledig
        // gecrediteerde factuur telt als 0).
        supabaseAdmin.from('invoices')
          .select('id, deal_id, amount_paid, amount_total, credited_amount, status')
          .in('deal_id', dealIds),
        variantIds.length
          ? supabaseAdmin.from('traject_variants').select('id, name').in('id', variantIds)
          : Promise.resolve({ data: [] }),
      ]);
      for (const s of (subsRes.data || [])) {
        if (!subsByDeal.has(s.deal_id)) subsByDeal.set(s.deal_id, []);
        subsByDeal.get(s.deal_id).push(s);
      }
      for (const i of (invsRes.data || [])) {
        if (!i.deal_id) continue;
        ontvangenByDeal[i.deal_id] = (ontvangenByDeal[i.deal_id] || 0) + betaaldBedrag(i);
      }
      for (const t of (tvRes.data || [])) trajectNaam[t.id] = t.name || null;
    }

    // ── Labels voor ledger-regels + sales ────────────────────────────────
    const dealIdSet = [...new Set([
      ...rows.map((r) => r.deal_id).filter(Boolean),
      ...dealIds,
    ])];
    const custIdSet = [...new Set([
      ...rows.map((r) => r.customer_id).filter(Boolean),
      ...deals.map((d) => d.customer_id).filter(Boolean),
    ])];
    let dealLabels = {};
    let custLabels = {};
    let custRows = {};
    if (dealIdSet.length) {
      const { data: d } = await supabaseAdmin.from('deals').select('id, quote_reference').in('id', dealIdSet);
      for (const x of (d || [])) dealLabels[x.id] = x.quote_reference || null;
    }
    if (custIdSet.length) {
      const { data: c } = await supabaseAdmin
        .from('customers').select('id, first_name, last_name, company_name, is_company').in('id', custIdSet);
      for (const x of (c || [])) {
        custRows[x.id] = x;
        custLabels[x.id] = klantNaam(x);
      }
    }
    const regels = rows.slice(0, 100).map((r) => ({
      id:         r.id,
      deal_id:    r.deal_id,
      deal_ref:   r.deal_id ? (dealLabels[r.deal_id] || null) : null,
      customer:   r.customer_id ? (custLabels[r.customer_id] || null) : null,
      basis:      Number(r.basis),
      pct:        Number(r.pct),
      amount:     Number(r.amount),
      status:     r.status,
      created_at: r.created_at,
      paid_at:    r.paid_at,
    }));

    // ── Sales-lijst — per deal: plan (aanbetaling/fee/termijnen), offerte-
    //    status, ontvangen, verwachte commissie. Het detail (klik op een rij)
    //    rendert uit sale.plan; ontvangen_regels vult fase B (facturen).
    const sales = deals.map((d) => bouwSaleRegel({
      deal: d,
      klant: d.customer_id ? custRows[d.customer_id] : null,
      traject: d.traject_variant_id ? (trajectNaam[d.traject_variant_id] || null) : null,
      pct,
      ontvangen: ontvangenByDeal[d.id] || 0,
    }));

    // ── Forecast / vervallen / in afwachting ─────────────────────────────
    //   forecast  = geaccepteerde sales: (totaal − ontvangen) × pct
    //   vervallen = idem, maar alle abonnementen van de deal zijn geannuleerd
    //   in_afwachting = offerte nog niet geaccepteerd (bv. alleen 'verstuurd')
    const CANCELLED = new Set(['cancelled', 'deactivated', 'geannuleerd']);
    let forecast = 0;
    let vervallen = 0;
    let inAfwachting = 0;
    for (const s of sales) {
      const rest = round2(Math.max(0, s.bedrag - s.betaald) * pct / 100);
      if (s.in_afwachting) { inAfwachting += rest; continue; }
      const subs = subsByDeal.get(s.deal_id) || [];
      const alleGeannuleerd = subs.length > 0 && subs.every((x) => CANCELLED.has(String(x.status || '').toLowerCase()));
      if (alleGeannuleerd) vervallen += rest; else forecast += rest;
    }

    return res.status(200).json({
      setter_user_id: targetSetter,
      pct,
      config,
      period: { key: period.key, from: period.from, to: period.to },
      totals: {
        uitbetaald_totaal:            round2(uitbetaald),
        deze_maand_te_ontvangen:      round2(vrijgegeven),
        forecast_nog_te_verwachten:   round2(forecast),
        vervallen_door_annulering:    round2(vervallen),
        in_afwachting_offerte:        round2(inAfwachting),
      },
      regels,
      sales,
    });
  } catch (e) {
    console.error('[setter-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
