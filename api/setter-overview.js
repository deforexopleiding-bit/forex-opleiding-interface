// api/setter-overview.js
//
// GET ?setter_user_id=<uuid>  (optioneel — default: user zelf)
//
// Retourneert Romy's overzicht met de 4 getallen:
//   - uitbetaald_totaal       — sum(amount) WHERE status='uitbetaald'
//   - deze_maand_te_ontvangen — sum(amount) WHERE status='vrijgegeven'
//   - forecast_nog_te_verwachten — (subs.amount * term_count - reeds_betaald) * pct
//                                  over ACTIEVE subscriptions van setter-deals
//   - vervallen_door_annulering — idem over CANCELLED subscriptions
// Plus regels-lijst (per klant/deal).
//
// Gate:
//   - setter.ledger.view — setter zelf ziet eigen data.
//   - setter.ledger.admin — manager+ mag andere setters bekijken.
//
// INCASSO-VEILIG: leest UITSLUITEND setter_ledger_entries + setter_config
// + deals + subscriptions + payments + invoices. Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { parseSetterPeriod } from './_lib/setter-period.js';

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
      .select('user_id, pct, is_active')
      .eq('user_id', targetSetter)
      .maybeSingle();
    const pct = cfg?.pct ? Number(cfg.pct) : 0;

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

    // ── Forecast + vervallen + sales-lijst — via deals + subs + invs ─────
    // Deals worden NIET begrensd door de periode: forecast is vooruitkijkend
    // en de sales-lijst laat álle geattribueerde deals zien zodat een sale
    // ook direct zichtbaar is vóór de eerste betaling.
    const { data: deals } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id, status, quote_reference, created_at')
      .eq('setter_user_id', targetSetter)
      .order('created_at', { ascending: false });
    const dealIds = (deals || []).map((d) => d.id);
    let forecast = 0;
    let vervallen = 0;
    let subsByDeal = new Map();
    let invsByDeal = new Map();
    let paidByDeal = {};
    let totalByDeal = {};
    if (dealIds.length) {
      const { data: subs } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, amount, term_count, status')
        .in('deal_id', dealIds);
      // Reeds-betaald + verwacht totaal per deal via invoices.
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, deal_id, amount_paid, amount_total, status')
        .in('deal_id', dealIds);
      for (const i of (invs || [])) {
        const d = i.deal_id;
        if (!d) continue;
        paidByDeal[d]  = (paidByDeal[d]  || 0) + (Number(i.amount_paid)  || 0);
        totalByDeal[d] = (totalByDeal[d] || 0) + (Number(i.amount_total) || 0);
        if (!invsByDeal.has(d)) invsByDeal.set(d, []);
        invsByDeal.get(d).push(i);
      }
      for (const s of (subs || [])) {
        if (!subsByDeal.has(s.deal_id)) subsByDeal.set(s.deal_id, []);
        subsByDeal.get(s.deal_id).push(s);
      }
      const CANCELLED = new Set(['cancelled', 'deactivated', 'geannuleerd']);
      for (const s of (subs || [])) {
        const totaalVerwacht = (Number(s.amount) || 0) * (Number(s.term_count) || 0);
        const alBetaald = paidByDeal[s.deal_id] || 0;
        const resterend = Math.max(0, totaalVerwacht - alBetaald);
        const commissie = round2(resterend * pct / 100);
        if (CANCELLED.has(String(s.status || '').toLowerCase())) {
          vervallen += commissie;
        } else {
          forecast += commissie;
        }
      }
    }

    // ── Regels-lijst: ledger-entries in de periode met labels ────────────
    const dealIdSet = [...new Set([
      ...rows.map((r) => r.deal_id).filter(Boolean),
      ...(deals || []).map((d) => d.id),        // ook alle setter-deals voor sales-lijst
    ])];
    const custIdSet = [...new Set([
      ...rows.map((r) => r.customer_id).filter(Boolean),
      ...(deals || []).map((d) => d.customer_id).filter(Boolean),
    ])];
    let dealLabels = {};
    let custLabels = {};
    if (dealIdSet.length) {
      const { data: d } = await supabaseAdmin.from('deals').select('id, quote_reference').in('id', dealIdSet);
      for (const x of (d || [])) dealLabels[x.id] = x.quote_reference || null;
    }
    if (custIdSet.length) {
      const { data: c } = await supabaseAdmin
        .from('customers').select('id, first_name, last_name, company_name, is_company').in('id', custIdSet);
      for (const x of (c || [])) {
        custLabels[x.id] = x.is_company
          ? (x.company_name || '—')
          : [x.first_name, x.last_name].filter(Boolean).join(' ') || '—';
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

    // ── Sales-lijst (BP3 v4-extra) — per deal: klant, bedrag, betaal-status,
    //    verwachte commissie. Toont geattribueerde sales ook vóór betaling.
    //    Bedrag = som(invoices.amount_total) ∪ (sub.amount * term_count) als
    //    er nog geen facturen zijn (nieuwe sale — abonnement wel gestempeld).
    //    Betaal-status: 'geen' / 'gedeeltelijk' / 'volledig' (op factuur-basis).
    const sales = (deals || []).map((d) => {
      const invs = invsByDeal.get(d.id) || [];
      const subsForDeal = subsByDeal.get(d.id) || [];
      const invTotal = totalByDeal[d.id] || 0;
      const subTotal = subsForDeal.reduce(
        (s, sub) => s + (Number(sub.amount) || 0) * (Number(sub.term_count) || 0), 0
      );
      const bedrag = invTotal > 0 ? invTotal : subTotal;
      const betaald = paidByDeal[d.id] || 0;
      let betaalStatus = 'geen';
      if (betaald > 0 && betaald + 0.01 < bedrag) betaalStatus = 'gedeeltelijk';
      else if (betaald > 0 && betaald + 0.01 >= bedrag) betaalStatus = 'volledig';
      const verwachteCommissie = round2(bedrag * pct / 100);
      return {
        deal_id:      d.id,
        deal_ref:     dealLabels[d.id] || null,
        customer:     d.customer_id ? (custLabels[d.customer_id] || null) : null,
        bedrag:       round2(bedrag),
        betaald:      round2(betaald),
        betaal_status: betaalStatus,           // 'geen' | 'gedeeltelijk' | 'volledig'
        verwachte_commissie: verwachteCommissie,
        deal_status:  d.status || null,
        created_at:   d.created_at,
      };
    });

    return res.status(200).json({
      setter_user_id: targetSetter,
      pct,
      period: { key: period.key, from: period.from, to: period.to },
      totals: {
        uitbetaald_totaal:            round2(uitbetaald),
        deze_maand_te_ontvangen:      round2(vrijgegeven),
        forecast_nog_te_verwachten:   round2(forecast),
        vervallen_door_annulering:    round2(vervallen),
      },
      regels,
      sales,
    });
  } catch (e) {
    console.error('[setter-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
