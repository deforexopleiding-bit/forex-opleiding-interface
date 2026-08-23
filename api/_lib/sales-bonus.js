// api/_lib/sales-bonus.js
// SALES-bonus lifecycle-helpers (Fase 2). Draait NAAST primaire geld-acties
// (betaling registreren / TL-sync / TL-webhook / crediteren): ALLES FAIL-SOFT —
// een fout hier mag die acties nooit afbreken. Idempotent op bonus-status.
//
//   earnBonusForPaidInvoice(inv)      — betaalde AANBETALINGSfactuur → pending→earned
//   voidActiveBonusForDeal(dealId,..) — deal geannuleerd (deal.lost) → void
//   voidBonusForCreditedInvoice(inv,) — creditnota op aanbetaling      → void
//
// Bij het voiden van een REEDS 'paid' bonus: clawback_pending=true + een
// zichtbare finance-notificatie ("terugvorderen / verrekenen"). Geen stille flip.
// clawback_cleared_at blijft null tot finance verrekent.
//
// "Aanbetalingsfactuur" = IDENTITEIT van de deal (los van betaalstatus):
//   precies  → aanbetalings-sub (eerste term_count=1) gekoppeld via
//              invoices.tl_subscription_id = subscriptions.teamleader_subscription_id
//   fallback → vroegste (issue_date) NIET-fee factuur van de deal
// De reserverings-/aanmeldfee (deals.reservation_fee_invoice_id) telt NOOIT mee.
//
// DEAL-RESOLUTIE: TL-gesyncte facturen (upsertInvoiceFromTl) hebben vaak GEEN
// invoices.deal_id, maar WEL tl_subscription_id. Daarom resolven we de deal via
// deal_id ÓF via de subscription (tl_subscription_id → subscriptions.deal_id).

import { supabaseAdmin } from '../supabase.js';
import { createNotification } from './notify.js';

// Resolve { id, reservation_fee_invoice_id } van de deal die bij deze factuur hoort.
async function resolveDeal(inv) {
  if (inv?.deal_id) {
    const { data } = await supabaseAdmin.from('deals')
      .select('id, reservation_fee_invoice_id').eq('id', inv.deal_id).maybeSingle();
    if (data) return data;
  }
  if (inv?.tl_subscription_id) {
    const { data: sub } = await supabaseAdmin.from('subscriptions')
      .select('deal_id').eq('teamleader_subscription_id', inv.tl_subscription_id)
      .limit(1).maybeSingle();
    if (sub?.deal_id) {
      const { data } = await supabaseAdmin.from('deals')
        .select('id, reservation_fee_invoice_id').eq('id', sub.deal_id).maybeSingle();
      if (data) return data;
    }
  }
  return null;
}

async function isDownPaymentInvoice(inv, deal) {
  if (!inv?.id || !deal?.id) return false;
  const feeInvId = deal.reservation_fee_invoice_id || null;
  if (feeInvId && inv.id === feeInvId) return false;         // fee ≠ aanbetaling

  // Subscriptions van de deal (voor de precieze match én de fallback-linkage).
  const { data: subs } = await supabaseAdmin.from('subscriptions')
    .select('teamleader_subscription_id, term_count, created_at')
    .eq('deal_id', deal.id).order('created_at', { ascending: true });

  // Precies: aanbetalings-sub (eerste term_count=1) → tl_subscription_id.
  const downSub = (subs || []).find(s => Number(s.term_count) === 1);
  if (downSub?.teamleader_subscription_id && inv.tl_subscription_id
      && downSub.teamleader_subscription_id === inv.tl_subscription_id) {
    return true;
  }

  // Fallback: vroegste NIET-fee factuur van de deal. Facturen hangen aan de deal
  // via invoices.deal_id ÓF via een subscription van de deal (tl_subscription_id)
  // — TL-gesyncte facturen hebben vaak alleen dat laatste.
  // tl_subscription_id = Teamleader-UUID (hex + koppeltekens). Defensief dubbel-
  // quoten in de in-lijst zodat een onverwachte waarde (komma/haakje) de
  // PostgREST-or-filter nooit stil kan breken; embedded quotes escapen.
  const tlSubIds = (subs || []).map(s => s.teamleader_subscription_id).filter(Boolean);
  const orParts = [`deal_id.eq.${deal.id}`];
  if (tlSubIds.length) {
    const quoted = tlSubIds.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
    orParts.push(`tl_subscription_id.in.(${quoted})`);
  }
  const { data: dealInv } = await supabaseAdmin.from('invoices')
    .select('id, issue_date, created_at')
    .or(orParts.join(','))
    .order('issue_date', { ascending: true }).order('created_at', { ascending: true });
  const nonFee = (dealInv || []).filter(r => !feeInvId || r.id !== feeInvId);
  return nonFee.length > 0 && nonFee[0].id === inv.id;
}

// Void de ACTIEVE (niet-voided) bonus van een deal + clawback-signaal bij 'paid'.
// De partiële index uq_bonuses_deal_active garandeert hooguit 1 actieve bonus.
async function _voidActiveBonus(dealId, reason, source) {
  const { data: bonus } = await supabaseAdmin.from('bonuses')
    .select('id, status, sales_user_id')
    .eq('deal_id', dealId).neq('status', 'voided')
    .limit(1).maybeSingle();
  if (!bonus) return { ok: true, skipped: 'no_active_bonus' };

  const wasPaid = bonus.status === 'paid';
  const patch = { status: 'voided', voided_at: new Date().toISOString(), void_reason: reason || null };
  if (wasPaid) patch.clawback_pending = true;               // reeds uitbetaald → terugvorderen

  const { data: upd } = await supabaseAdmin.from('bonuses')
    .update(patch).eq('id', bonus.id).neq('status', 'voided')   // idempotent
    .select('id').maybeSingle();
  if (!upd) return { ok: true, skipped: 'already_voided' };

  if (wasPaid) {
    // ZICHTBAAR finance-signaal: al uitbetaalde bonus ge-void → terugvorderen.
    createNotification({
      toRole:     ['manager', 'super_admin'],
      type:       'finance.bonus_clawback',
      title:      'Bonus terugvorderen',
      body:       `Reeds uitbetaalde verkoper-bonus ge-void (${reason || 'clawback'}) — verrekenen met volgende uitbetaling.`,
      linkUrl:    '/modules/sales.html',
      entityType: 'bonus',
      entityId:   bonus.id,
    }).catch(() => {});
    console.log('[sales-bonus] CLAWBACK: paid bonus', bonus.id, 'voided —', reason, '| source', source);
  } else {
    console.log('[sales-bonus] bonus', bonus.id, 'voided (niet uitbetaald) —', reason, '| source', source);
  }
  return { ok: true, voided: bonus.id, clawback: wasPaid };
}

/**
 * Earn-hook: als `inv` de aanbetalingsfactuur van zijn deal is, zet de pending
 * bonus van die deal op 'earned'. Aanroepen bij de paid-transitie van een factuur
 * (app-direct én TL-sync). `inv` = { id, deal_id?, tl_subscription_id?, invoice_number? }.
 */
export async function earnBonusForPaidInvoice(inv) {
  try {
    const deal = await resolveDeal(inv);
    if (!deal) return { ok: true, skipped: 'no_deal' };
    const { data: bonus } = await supabaseAdmin.from('bonuses')
      .select('id').eq('deal_id', deal.id).eq('status', 'pending')
      .limit(1).maybeSingle();
    if (!bonus) return { ok: true, skipped: 'no_pending_bonus' };
    if (!(await isDownPaymentInvoice(inv, deal))) return { ok: true, skipped: 'not_downpayment' };

    const { data: upd } = await supabaseAdmin.from('bonuses')
      .update({ status: 'earned', earned_at: new Date().toISOString() })
      .eq('id', bonus.id).eq('status', 'pending')            // idempotent: alleen vanuit pending
      .select('id').maybeSingle();
    if (upd) console.log('[sales-bonus] earned:', bonus.id, 'via aanbetalingsfactuur', inv.id);
    return { ok: true, earned: upd ? bonus.id : null };
  } catch (e) {
    console.warn('[sales-bonus] earnBonusForPaidInvoice fail-soft:', e?.message || e);
    return { ok: false, reason: e?.message };
  }
}

/** Clawback bij deal.lost / annulering: void de actieve bonus van de deal. */
export async function voidActiveBonusForDeal(dealId, { reason, source } = {}) {
  try {
    if (!dealId) return { ok: true, skipped: 'no_deal' };
    return await _voidActiveBonus(dealId, reason || 'deal geannuleerd', source || 'unknown');
  } catch (e) {
    console.warn('[sales-bonus] voidActiveBonusForDeal fail-soft:', e?.message || e);
    return { ok: false, reason: e?.message };
  }
}

/**
 * Clawback bij creditnota: als de GECREDITEERDE factuur de aanbetaling van de
 * deal is, void de actieve bonus. `inv` = { id, deal_id?, tl_subscription_id?, invoice_number? }.
 */
export async function voidBonusForCreditedInvoice(inv, { source } = {}) {
  try {
    const deal = await resolveDeal(inv);
    if (!deal) return { ok: true, skipped: 'no_deal' };
    if (!(await isDownPaymentInvoice(inv, deal))) return { ok: true, skipped: 'not_downpayment' };
    const label = inv.invoice_number || inv.id;
    return await _voidActiveBonus(deal.id, `creditnota op aanbetalingsfactuur ${label}`, source || 'invoice-credit');
  } catch (e) {
    console.warn('[sales-bonus] voidBonusForCreditedInvoice fail-soft:', e?.message || e);
    return { ok: false, reason: e?.message };
  }
}
