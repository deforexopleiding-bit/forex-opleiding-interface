// api/_lib/credited-debt.js
//
// Read-only queries over dunning_credited_debt (migratie 039 uit PR-2).
// Wordt gebruikt door de pipeline-detail-endpoint (1 klant, volledige rows),
// de pipeline-lijst-endpoint (N klanten, alleen aggregate voor badge) en
// de incasso-dossier-detail + incasso-pdf (per klant, aggregate + rows).
//
// getCreditedDebt(customerId) → {
//   rows                : [row, ...] (nieuwste eerst),
//   count               : N (aantal gecrediteerde facturen),
//   total_incl          : € som van amount_incl,
//   total_vat           : € som van vat_amount,
//   last_credited_on    : YYYY-MM-DD (laatste ronde), nullable,
//   months_extended_total: som per (subscription_id, credited_on)-ronde,
//                          NIET per rij — één ronde met 3 facturen die het
//                          abo +3 mnd verlengt telt als 3 mnd (niet 9).
// }
//
// getCreditedDebtBatch(customerIds) → Map<customer_id, aggregate>. Alleen
// aggregate zonder rows[], zodat de pipeline-lijst niet onnodig grote
// payloads doorstuurt.

import { supabaseAdmin } from '../supabase.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function aggregateFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let totalIncl = 0;
  let totalVat  = 0;
  let last      = null;
  // Verlengd-maanden telling: groepeer op ronde (subscription_id + credited_on)
  // en tel per unieke ronde één keer. months_extended is per-rij gelijk binnen
  // dezelfde insert-batch.
  const roundMonths = new Map(); // key -> months_extended (max)
  for (const r of list) {
    totalIncl += Number(r.amount_incl) || 0;
    totalVat  += Number(r.vat_amount)  || 0;
    const d = String(r.credited_on || '').slice(0, 10);
    if (d && (!last || d > last)) last = d;
    const sid = r.subscription_id || '';
    const m   = Number(r.months_extended) || 0;
    if (sid && m > 0) {
      const key = sid + '::' + d;
      const prev = roundMonths.get(key) || 0;
      if (m > prev) roundMonths.set(key, m);
    }
  }
  let monthsExtendedTotal = 0;
  for (const m of roundMonths.values()) monthsExtendedTotal += m;
  return {
    count                 : list.length,
    total_incl            : r2(totalIncl),
    total_vat             : r2(totalVat),
    last_credited_on      : last,
    months_extended_total : monthsExtendedTotal,
  };
}

export async function getCreditedDebt(customerId) {
  if (!customerId) {
    return { rows: [], count: 0, total_incl: 0, total_vat: 0, last_credited_on: null, months_extended_total: 0 };
  }
  const { data, error } = await supabaseAdmin
    .from('dunning_credited_debt')
    .select('id, customer_id, invoice_id, tl_credit_note_id, amount_incl, vat_amount, credited_on, quarter, subscription_id, months_extended, created_by, created_at')
    .eq('customer_id', customerId)
    .order('credited_on', { ascending: false })
    .order('created_at',  { ascending: false });
  if (error) {
    // Fail-soft: geen tabel of andere DB-fout → lege agg, caller ziet gewoon
    // "geen credit-historie" zonder crash.
    console.warn('[credited-debt] lookup soft-fail:', error.message);
    return { rows: [], count: 0, total_incl: 0, total_vat: 0, last_credited_on: null, months_extended_total: 0 };
  }
  const rows = data || [];
  return { rows, ...aggregateFromRows(rows) };
}

export async function getCreditedDebtBatch(customerIds) {
  const ids = Array.from(new Set((customerIds || []).filter(Boolean)));
  const out = new Map();
  if (ids.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('dunning_credited_debt')
    .select('customer_id, amount_incl, vat_amount, credited_on, subscription_id, months_extended')
    .in('customer_id', ids);
  if (error) {
    console.warn('[credited-debt-batch] lookup soft-fail:', error.message);
    return out;
  }
  const perCust = new Map();
  for (const r of data || []) {
    const arr = perCust.get(r.customer_id) || [];
    arr.push(r);
    perCust.set(r.customer_id, arr);
  }
  for (const [cid, rows] of perCust) {
    out.set(cid, aggregateFromRows(rows));
  }
  return out;
}
