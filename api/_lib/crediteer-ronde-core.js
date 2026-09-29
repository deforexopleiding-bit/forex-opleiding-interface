// api/_lib/crediteer-ronde-core.js
//
// Gedeelde, pure logica voor crediteer-ronde-preview én -execute, zodat de
// preview exact toont wat de execute zou crediteren (preview == execute).
//
//   - isCrediteerRondeDryRun(): EIGEN vlag app_settings.crediteer_ronde_dry_run.
//     Bewust NIET de systeembrede dunning_dry_run: die zet het hele
//     aanmaansysteem (bulk-send, engine, Joost-outbound, incasso-mail) stil.
//     Ontbreekt de rij of faalt het lezen → dry-run AAN (fail-safe).
//   - selectCreditable(): welke facturen van één klant in scope vallen.
//   - planExtension(): hoeveel maanden een abonnement verlengd wordt. Gokt
//     NIET bij een onbekende/andere billing_cycle — dan is een expliciete
//     months_override nodig.

import { supabaseAdmin } from '../supabase.js';

export const DRY_RUN_KEY = 'crediteer_ronde_dry_run';
export const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
export const MAX_ITEMS_PER_CALL = 5;
export const MAX_MONTHS_OVERRIDE = 36;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export async function isCrediteerRondeDryRun() {
  try {
    const { data, error } = await supabaseAdmin.from('app_settings')
      .select('value').eq('key', DRY_RUN_KEY).maybeSingle();
    if (error || !data) return true;
    return data.value?.enabled !== false;
  } catch {
    return true;
  }
}

export function todayAmsterdam(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(now);
}

export function openAmountEur(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid) || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, r2(t - p - c));
}

export function daysOverdue(dueIso, today) {
  if (!dueIso) return 0;
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(dueIso).slice(0, 10)}T00:00:00Z`)) / 86400000);
  return d > 0 ? d : 0;
}

// Scope: minstens één van beide moet gezet zijn — "alle open facturen van de
// klant" bestaat niet meer. invoice_ids wint als beide gezet zijn (ids die niet
// te laat zijn vallen dan alsnog af als onlyOverdue ook aan staat).
export function hasScope({ invoiceIds, onlyOverdue }) {
  return (Array.isArray(invoiceIds) && invoiceIds.length > 0) || onlyOverdue === true;
}

/**
 * @returns {{ creditable: object[], rejected: {invoice_id, reden}[] }}
 */
export function selectCreditable(invoices, { invoiceIds = null, onlyOverdue = false, today }) {
  const want = Array.isArray(invoiceIds) && invoiceIds.length ? new Set(invoiceIds) : null;
  const creditable = [];
  const rejected = [];
  const reden = (iv) => {
    if (iv.is_test) return 'test-factuur';
    if (iv.status === 'concept') return 'concept';
    if (!OPEN_STATUSES.includes(iv.status)) return `status ${iv.status}`;
    if (!iv.tl_invoice_id) return 'geen Teamleader-id';
    if (openAmountEur(iv) <= 0) return 'niets meer open';
    if (onlyOverdue && !(iv.due_date && String(iv.due_date).slice(0, 10) < today)) return 'nog niet vervallen';
    return null;
  };
  for (const iv of invoices || []) {
    if (want && !want.has(iv.id)) continue;
    const r = reden(iv);
    if (r) { if (want) rejected.push({ invoice_id: iv.id, invoice_number: iv.invoice_number || null, reden: r }); continue; }
    creditable.push(iv);
  }
  if (want) {
    const seen = new Set((invoices || []).map((iv) => iv.id));
    for (const id of want) if (!seen.has(id)) rejected.push({ invoice_id: id, invoice_number: null, reden: 'hoort niet bij deze klant of bestaat niet' });
  }
  return { creditable, rejected };
}

export function isUsableSubscription(sub) {
  return !!sub && String(sub.status || '').toLowerCase() === 'active' && !!sub.teamleader_subscription_id;
}

/**
 * Verlengplan. per_month → 1 maand per gecrediteerde factuur. Andere of
 * onbekende cyclus → géén gok: alleen met expliciete monthsOverride.
 * @returns {{ months: number|null, basis: 'per_month'|'override'|null, error: string|null, cycle: string|null }}
 */
export function planExtension(sub, nInvoices, monthsOverride = null) {
  const cycle = sub?.billing_cycle || null;
  if (monthsOverride != null) {
    const m = Number(monthsOverride);
    if (!Number.isInteger(m) || m < 1 || m > MAX_MONTHS_OVERRIDE) {
      return { months: null, basis: null, error: 'MONTHS_OVERRIDE_INVALID', cycle };
    }
    return { months: m, basis: 'override', error: null, cycle };
  }
  if (cycle === 'per_month') return { months: nInvoices, basis: 'per_month', error: null, cycle };
  return { months: null, basis: null, error: 'CYCLE_UNSUPPORTED', cycle };
}
