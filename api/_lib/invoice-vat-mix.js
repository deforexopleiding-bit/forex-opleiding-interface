// api/_lib/invoice-vat-mix.js
//
// BTW-mix helper voor D1.5 consolidate-payload (UITSTEL "consolidate + restart").
// Bouwt vat_distribution + outstanding-totals + termijn-bedragen op basis van
// LIVE TeamLeader invoice line-items (geen DB-cache van line-items beschikbaar).
//
// Strategie (per recon-aanbeveling 2026-06-09):
//   - Lokaal hebben we GEEN invoice_line_items tabel, alleen totalen op invoices.
//   - Voor btw-tarief verdeling per invoice gebruiken we de bestaande
//     /api/finance-invoice-lines logica: live `tlFetch('/invoices.info')` per
//     factuur, met defensieve env-fallback voor tax_rate_id -> percentage.
//   - Voor outstanding-bedrag bij partially_paid: gebruik `total.due` uit TL
//     (autoritatief), met fallback op lokale `amount_total - amount_paid`.
//   - Performance: bij <= 10 invoices sequentieel met 150ms throttle (zelfde
//     pattern als finance-invoice-credit.js tlCall). Boven 10: ook sequentieel
//     om TL rate-limit (100 req/min) niet te raken; 60s budget is ruim genoeg.
//
// Geen permission-checks; callers (arrangements-propose, consolidate-preview
// endpoint) doen zelf authn/authz.

import { supabaseAdmin as defaultAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THROTTLE_MS = 150;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}

// TL tax_rate_id -> integer BTW% via env reverse-map (zelfde envs als
// finance-invoice-lines.js).
function buildReverseTaxMap() {
  const map = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    const m = k.match(/^TEAMLEADER_TAX_RATE_ID_(\d+)(?:_[A-Z]+)?$/);
    if (m) { map[v] = Number(m[1]); continue; }
    if (/^TEAMLEADER_TAX_RATE_ID_(INTRA|OUTSIDE_EU)/.test(k)) map[v] = 0;
  }
  return map;
}

// BTW-percentage (integer 0/9/21) per line-item. TL kan rate als fractie geven
// (li.tax.rate = 0.21) of alleen tax_rate_id (env-map fallback).
function ratePctOf(li, taxMap) {
  if (li.tax && typeof li.tax.rate === 'number') return Math.round(li.tax.rate * 100);
  if (typeof li.tax_rate === 'number') return Math.round(li.tax_rate * 100);
  const id = li.tax_rate_id || (li.tax?.type === 'taxRate' ? li.tax?.id : null);
  if (id && taxMap[id] != null) return Number(taxMap[id]);
  return null;
}

// Stukprijs EXCL btw; defensief over unit_price-shape (object met amount/tax of
// plat getal). Bij include-pricing wordt teruggerekend met de gevonden rate.
function unitExcl(li, taxMap) {
  const up = li.unit_price;
  let unit = null, incl = false;
  if (up && typeof up === 'object') { unit = Number(up.amount); incl = up.tax === 'including'; }
  else if (up != null && up !== '') unit = Number(up);
  if (!Number.isFinite(unit)) unit = Number(amt(li.total?.tax_exclusive) ?? amt(li.total) ?? 0);
  if (!Number.isFinite(unit)) unit = 0;
  const pct = ratePctOf(li, taxMap);
  if (incl && pct != null && pct > 0) unit = unit / (1 + pct / 100);
  return unit;
}

/**
 * Fetch en parse TL invoices.info voor 1 invoice. Returnt per-tarief totalen
 * (excl btw), het totale excl/incl, en TL's autoritatieve `due` (nog te betalen).
 *
 * @returns {Promise<{
 *   tl_invoice_id: string,
 *   per_rate: Record<number, number>,   // { 21: 100.00, 9: 50.00 } -- excl btw per tarief
 *   total_excl: number,
 *   total_incl: number,
 *   due: number|null                    // TL total.due (nullable als TL het veld niet stuurt)
 * }>}
 */
async function fetchInvoiceVatBreakdown(tlInvoiceId, taxMap) {
  const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId }) });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error('[invoice-vat-mix] invoices.info HTTP', r.status, txt.slice(0, 200));
    throw new Error(`TL invoices.info HTTP ${r.status} voor tl_invoice_id=${tlInvoiceId}`);
  }
  const json = await r.json().catch(() => null);
  const inv = json?.data || null;
  if (!inv) throw new Error(`TL invoices.info response onleesbaar voor tl_invoice_id=${tlInvoiceId}`);

  const perRate = {};
  for (const g of (inv.grouped_lines || [])) {
    for (const li of (g.line_items || [])) {
      const qty = Number(li.quantity) || 0;
      const ue = unitExcl(li, taxMap);
      const lineExcl = ue * qty;
      const pct = ratePctOf(li, taxMap);
      // Onbekend tarief: parkeer onder 0% bucket (conservatief, geen btw aangenomen).
      const key = pct != null ? pct : 0;
      perRate[key] = (perRate[key] || 0) + lineExcl;
    }
  }
  for (const k of Object.keys(perRate)) perRate[k] = r2(perRate[k]);

  const t = inv.total || {};
  const excl = amt(t.tax_exclusive);
  const incl = amt(t.tax_inclusive) ?? amt(t.payable);
  const due = amt(t.due);

  return {
    tl_invoice_id: tlInvoiceId,
    per_rate: perRate,
    total_excl: excl != null ? r2(excl) : r2(Object.values(perRate).reduce((a, b) => a + b, 0)),
    total_incl: incl != null ? r2(incl) : null,
    due: due != null ? r2(due) : null,
  };
}

/**
 * Lookup invoice-rows (lokaal) voor de gegeven uuids. Returnt id + tl_invoice_id
 * + lokale totaal/paid voor due-fallback.
 */
async function lookupInvoices(supabaseAdmin, invoiceIds) {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('id, tl_invoice_id, amount_total, amount_paid, status')
    .in('id', invoiceIds);
  if (error) throw new Error('invoices lookup: ' + error.message);
  return data || [];
}

/**
 * Bouw vat_distribution over een set invoices.
 *
 * Per vat_rate: som van line_total_excl_vat over alle invoices in de set.
 * Sortering: vat_rate DESC (hoogste eerst, bv. 21 > 9 > 0).
 *
 * @param {object} supabaseAdmin - service-role client (default: import).
 * @param {string[]} invoiceIds - lokale invoice uuids.
 * @returns {Promise<Array<{ vat_rate: number, total_amount_excl_vat: number }>>}
 */
export async function buildVatDistribution(supabaseAdmin, invoiceIds) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new Error('invoiceIds (non-empty array) vereist');
  }
  for (const id of invoiceIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(`Ongeldig invoice_id (uuid vereist): ${id}`);
    }
  }
  const admin = supabaseAdmin || defaultAdmin;
  const rows = await lookupInvoices(admin, invoiceIds);
  const missing = invoiceIds.filter(id => !rows.find(r => r.id === id));
  if (missing.length) throw new Error(`Invoice(s) niet gevonden: ${missing.join(', ')}`);

  const taxMap = buildReverseTaxMap();
  const perRateTotals = {};

  for (let i = 0; i < rows.length; i++) {
    const inv = rows[i];
    if (!inv.tl_invoice_id) {
      throw new Error(`Invoice ${inv.id} heeft geen tl_invoice_id (lokale-only invoice, geen BTW-breakdown beschikbaar)`);
    }
    if (i > 0) await sleep(THROTTLE_MS);
    const bd = await fetchInvoiceVatBreakdown(inv.tl_invoice_id, taxMap);
    for (const [k, v] of Object.entries(bd.per_rate)) {
      const rate = Number(k);
      perRateTotals[rate] = (perRateTotals[rate] || 0) + Number(v);
    }
  }

  const out = Object.entries(perRateTotals)
    .map(([rate, total]) => ({
      vat_rate: Number(rate),
      total_amount_excl_vat: r2(total),
    }))
    .filter(x => x.total_amount_excl_vat > 0)
    .sort((a, b) => b.vat_rate - a.vat_rate);

  return out;
}

/**
 * Som van outstanding-bedragen over de gegeven invoices.
 *
 * `total_outstanding` gebruikt TL `total.due` per invoice (autoritatief); valt
 * terug op lokaal `amount_total - amount_paid` als TL geen due-veld stuurt.
 * `total_excl_vat` / `total_incl_vat` zijn de som van factuur-totalen (NIET
 * de outstanding-pro-rata) — voor de wizard nodig om te tonen "totaal te
 * consolideren bedrag".
 *
 * @param {object} supabaseAdmin - service-role client.
 * @param {string[]} invoiceIds - lokale invoice uuids.
 * @returns {Promise<{ total_excl_vat: number, total_incl_vat: number, total_outstanding: number }>}
 */
export async function getInvoiceOutstandingTotals(supabaseAdmin, invoiceIds) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new Error('invoiceIds (non-empty array) vereist');
  }
  for (const id of invoiceIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(`Ongeldig invoice_id (uuid vereist): ${id}`);
    }
  }
  const admin = supabaseAdmin || defaultAdmin;
  const rows = await lookupInvoices(admin, invoiceIds);
  const missing = invoiceIds.filter(id => !rows.find(r => r.id === id));
  if (missing.length) throw new Error(`Invoice(s) niet gevonden: ${missing.join(', ')}`);

  const taxMap = buildReverseTaxMap();
  let sumExcl = 0;
  let sumIncl = 0;
  let sumDue = 0;

  for (let i = 0; i < rows.length; i++) {
    const inv = rows[i];
    if (!inv.tl_invoice_id) {
      // Lokale-only invoice: gebruik lokaal amount_total als incl + amount_paid voor due.
      const incl = Number(inv.amount_total) || 0;
      const paid = Number(inv.amount_paid) || 0;
      sumIncl += incl;
      sumDue += Math.max(0, incl - paid);
      // Zonder TL kunnen we geen excl bepalen — overschat NIET, gooi error voor
      // duidelijkheid (consolidate-payload heeft excl per tarief nodig).
      throw new Error(`Invoice ${inv.id} heeft geen tl_invoice_id (lokale-only invoice, geen excl-totaal beschikbaar)`);
    }
    if (i > 0) await sleep(THROTTLE_MS);
    const bd = await fetchInvoiceVatBreakdown(inv.tl_invoice_id, taxMap);
    sumExcl += Number(bd.total_excl) || 0;
    if (bd.total_incl != null) sumIncl += Number(bd.total_incl);
    else sumIncl += Number(inv.amount_total) || 0;
    if (bd.due != null) {
      sumDue += Number(bd.due);
    } else {
      // Fallback: lokaal amount_total - amount_paid (zelfde formule als
      // finance-invoices.js + inbox-conversation-context.js).
      const incl = Number(inv.amount_total) || 0;
      const paid = Number(inv.amount_paid) || 0;
      sumDue += Math.max(0, incl - paid);
    }
  }

  return {
    total_excl_vat: r2(sumExcl),
    total_incl_vat: r2(sumIncl),
    total_outstanding: r2(sumDue),
  };
}

/**
 * Verdeel een totaal excl btw over N termijnen, per vat_rate.
 *
 * Per vat_rate: amount_per_invoice_excl_vat = total_for_rate / termijnen, op 2
 * decimalen afgerond. De LAATSTE termijn pakt het restant (subtract som van
 * eerste N-1 termijnen) zodat de som exact gelijk blijft aan het origineel —
 * geen verdwenen of dubbele cent door rounding.
 *
 * Output `last_invoice_adjustment` is het bedrag dat de laatste termijn EXTRA
 * (of MINDER, bij negatief) krijgt t.o.v. de gewone termijn-amount, zodat de
 * caller kan tonen "termijn 1-N-1: EUR X.XX; termijn N: EUR X.XX (+ adj)".
 *
 * @param {number} total_excl_vat - totaal excl btw te verdelen (>0).
 *                                  Voor uniformiteit met buildVatDistribution
 *                                  wordt deze parameter genegeerd als
 *                                  vat_distribution items ook total_amount_excl_vat
 *                                  bevatten — die zijn dan leidend.
 * @param {number} termijnen - aantal termijnen (integer >= 1).
 * @param {Array<{vat_rate: number, total_amount_excl_vat: number}>} vat_distribution
 * @returns {Array<{
 *   vat_rate: number,
 *   amount_per_invoice_excl_vat: number,
 *   last_invoice_adjustment: number
 * }>}
 */
export function computeTermijnAmounts(total_excl_vat, termijnen, vat_distribution) {
  if (!Array.isArray(vat_distribution) || vat_distribution.length === 0) {
    throw new Error('vat_distribution (non-empty array) vereist');
  }
  const n = Math.floor(Number(termijnen));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error('termijnen moet een integer >= 1 zijn');
  }

  const out = [];
  for (const item of vat_distribution) {
    const rate = Number(item.vat_rate);
    const total = Number(item.total_amount_excl_vat);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`Ongeldig vat_rate in distribution: ${item.vat_rate}`);
    }
    if (!Number.isFinite(total) || total < 0) {
      throw new Error(`Ongeldig total_amount_excl_vat in distribution: ${item.total_amount_excl_vat}`);
    }
    const per = r2(total / n);
    // Restant voor laatste termijn: origineel total minus (n-1) * per.
    const firstSum = r2(per * (n - 1));
    const lastAmount = r2(total - firstSum);
    const adjustment = r2(lastAmount - per);
    out.push({
      vat_rate: rate,
      amount_per_invoice_excl_vat: per,
      last_invoice_adjustment: adjustment,
    });
  }

  out.sort((a, b) => b.vat_rate - a.vat_rate);
  return out;
}
