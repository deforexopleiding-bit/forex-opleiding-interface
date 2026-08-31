// api/cron-setter-cash-release.js
//
// Dagelijkse cron (schedule: 0 6 * * * — via vercel.json).
// Vertaalt nieuwe payments naar setter_ledger_entries op basis van
// deals.setter_user_id. 3% (per setter_config.pct) van elke payment.
//
// INCASSO-VEILIG:
//   - Leest UITSLUITEND: payments, invoices, deals, setter_config, setter_watermark.
//   - Schrijft UITSLUITEND: setter_ledger_entries, setter_watermark.
//   - RAAKT NIET AAN: payment_arrangements, pending_actions, dunning_*,
//     _lib/register-payment-internal.js, _lib/mentor-*, finance.html.
//
// FLOW:
//   1. Lees watermark (key='cash_release'). Bij eerste run zonder rij:
//      init op now() — schoon startpunt, GEEN backfill van oude payments.
//   2. Query payments met payment_date > watermark, join invoices → deals →
//      setter_user_id NOT NULL, en setter_config voor de setter (is_active).
//   3. Per rij: compute amount = round(payment.amount * pct / 100, 2).
//      INSERT setter_ledger_entries met idempotency_key = setter+payment_id.
//      ON CONFLICT (idempotency_key) DO NOTHING → dubbele runs idempotent.
//   4. Update watermark op de max(payment_date) van de verwerkte batch.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth in supabase.js).

import { supabaseAdmin, checkCronAuth } from './supabase.js';

const WATERMARK_KEY = 'cash_release';
const BATCH_LIMIT   = 500;

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const summary = {
    processed: 0,
    created:   0,
    skipped:   0,
    errors:    [],
    watermark_before: null,
    watermark_after:  null,
  };

  try {
    // ── 1. Watermark ophalen ──────────────────────────────────────────────
    let watermarkAt;
    {
      const { data } = await supabaseAdmin
        .from('setter_watermark')
        .select('last_seen_at')
        .eq('key', WATERMARK_KEY)
        .maybeSingle();
      if (data?.last_seen_at) {
        watermarkAt = new Date(data.last_seen_at).toISOString();
      } else {
        // Eerste run: init op now(). Schoon startpunt.
        watermarkAt = new Date().toISOString();
        await supabaseAdmin
          .from('setter_watermark')
          .insert({ key: WATERMARK_KEY, last_seen_at: watermarkAt });
        summary.errors.push({ note: 'watermark geinitialiseerd op now() — geen backfill' });
        return res.status(200).json({ ok: true, ...summary, watermark_before: watermarkAt, watermark_after: watermarkAt });
      }
    }
    summary.watermark_before = watermarkAt;

    // ── 2. Query nieuwe payments met deal-setter-koppeling ────────────────
    // Doe dit in 2 stappen om supabase-js query-complexity te beperken:
    //   a) payments sinds watermark.
    //   b) per payment invoice → deal → setter opzoeken.
    const { data: payments, error: pErr } = await supabaseAdmin
      .from('payments')
      .select('id, customer_id, invoice_id, amount, payment_date, created_at')
      .gt('payment_date', watermarkAt.slice(0, 10))  // date-compare
      .order('payment_date', { ascending: true })
      .limit(BATCH_LIMIT);
    if (pErr) throw pErr;

    if (!payments || payments.length === 0) {
      return res.status(200).json({ ok: true, ...summary });
    }

    // Batch invoice-ids voor 1 lookup.
    const invoiceIds = [...new Set(payments.map((p) => p.invoice_id).filter(Boolean))];
    let invoiceMap = {};
    if (invoiceIds.length) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, deal_id, customer_id')
        .in('id', invoiceIds);
      for (const i of (invs || [])) invoiceMap[i.id] = i;
    }

    const dealIds = [...new Set(Object.values(invoiceMap).map((i) => i.deal_id).filter(Boolean))];
    let dealMap = {};
    if (dealIds.length) {
      const { data: deals } = await supabaseAdmin
        .from('deals')
        .select('id, setter_user_id')
        .in('id', dealIds)
        .not('setter_user_id', 'is', null);
      for (const d of (deals || [])) dealMap[d.id] = d;
    }

    // Setter-configs (pct) voor alle unieke setters.
    const setterIds = [...new Set(Object.values(dealMap).map((d) => d.setter_user_id).filter(Boolean))];
    let cfgMap = {};
    if (setterIds.length) {
      const { data: cfgs } = await supabaseAdmin
        .from('setter_config')
        .select('user_id, pct, is_active')
        .in('user_id', setterIds)
        .eq('is_active', true);
      for (const c of (cfgs || [])) cfgMap[c.user_id] = c;
    }

    // ── 3. Loop en insert ─────────────────────────────────────────────────
    let maxPaymentDate = watermarkAt;
    for (const p of payments) {
      summary.processed++;
      try {
        if (p.payment_date && p.payment_date > maxPaymentDate.slice(0, 10)) {
          maxPaymentDate = new Date(p.payment_date + 'T23:59:59.999Z').toISOString();
        }
        const inv = invoiceMap[p.invoice_id];
        if (!inv) { summary.skipped++; continue; }         // geen invoice (of TL-only)
        if (!inv.deal_id) { summary.skipped++; continue; } // legacy deal-loze factuur
        const deal = dealMap[inv.deal_id];
        if (!deal) { summary.skipped++; continue; }        // deal zonder setter
        const cfg = cfgMap[deal.setter_user_id];
        if (!cfg) { summary.skipped++; continue; }         // setter zonder actieve config
        const pct    = Number(cfg.pct) || 0;
        const basis  = Number(p.amount) || 0;
        const amount = round2(basis * pct / 100);
        if (amount <= 0) { summary.skipped++; continue; }

        const idempotencyKey = `${deal.setter_user_id}:pay:${p.id}`;
        const { error: insErr } = await supabaseAdmin
          .from('setter_ledger_entries')
          .insert({
            setter_user_id: deal.setter_user_id,
            deal_id:        deal.id,
            customer_id:    inv.customer_id || p.customer_id || null,
            invoice_id:     inv.id,
            payment_id:     p.id,
            basis:          basis,
            basis_incl_btw: true,
            pct:            pct,
            amount:         amount,
            status:         'vrijgegeven',
            idempotency_key: idempotencyKey,
          });
        if (insErr) {
          if (insErr.code === '23505') { summary.skipped++; }
          else { summary.errors.push({ payment_id: p.id, error: insErr.message }); }
        } else {
          summary.created++;
        }
      } catch (e) {
        summary.errors.push({ payment_id: p.id, error: e?.message || String(e) });
      }
    }

    // ── 4. Watermark bijwerken ────────────────────────────────────────────
    await supabaseAdmin
      .from('setter_watermark')
      .update({ last_seen_at: maxPaymentDate, updated_at: new Date().toISOString() })
      .eq('key', WATERMARK_KEY);
    summary.watermark_after = maxPaymentDate;

    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[cron-setter-cash-release]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e), ...summary });
  }
}
