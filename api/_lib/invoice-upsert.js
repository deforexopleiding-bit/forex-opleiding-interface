// api/_lib/invoice-upsert.js
// Mapper + upsert van één TL-factuur in onze `invoices`-tabel. Hergebruikt door
// de sync (finance-tl-invoice-sync.js) en alle write-endpoints (create/update/
// credit/send) om de zojuist gemuteerde factuur direct in onze DB te krijgen
// zonder te wachten op de volgende sync-run.
//
// Idempotent (SELECT → UPDATE/INSERT op tl_invoice_id). Partial unique index
// kan geen ON CONFLICT-arbiter zijn (lesson 20 mei) → 2-staps-pattern.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

// Zelfde status-mapping als de sync (overdue NIET opgeslagen — dynamisch in UI/GET).
function mapStatus(inv, payable, due) {
  const s = String(inv.status || '').toLowerCase();
  if (s === 'draft') return 'concept';
  if (s.includes('credit')) return 'credited';
  if (inv.paid === true) return 'paid';
  if (due != null && payable != null) {
    if (due <= 0 && payable > 0) return 'paid';
    if (due > 0 && due < payable) return 'partially_paid';
    if (due >= payable) return 'open';
  }
  return 'open';
}

/**
 * Haalt invoices.info op voor tlInvoiceId, mapt naar onze schema en upsert in `invoices`.
 * Customer-match: invoicee.customer.id → tl_company_id (type=company) of tl_contact_id (anders).
 * Geen match → default: throw (factuur kan niet zonder klant in onze NOT NULL FK).
 *
 * opts.skipIfNoCustomer=true → géén throw bij ontbrekende klant, maar return
 *   { action:'skipped_no_customer', ...skip-details }. Gebruikt door de cron
 *   (cron-finance-sync.js) zodat een onmatchbare factuur de cursor niet
 *   blokkeert maar wordt overgeslagen + geregistreerd. Write-endpoints laten de
 *   optie weg → gedrag ongewijzigd (throw).
 * @returns {Promise<{ id: string, invoice_number: string, status: string, action: 'inserted'|'updated' } | { action: 'skipped_no_customer', tl_invoice_id: string, reason: string, invoicee_id: string|null, invoicee_type: string|null, match_column: string|null, invoice_number: string|null, tl_department_id: string|null, invoice_date: string|null, amount_total: number|null, tl_updated_at: string|null }>}
 */
export async function upsertInvoiceFromTl(tlInvoiceId, opts = {}) {
  if (!tlInvoiceId) throw new Error('tl_invoice_id vereist');
  const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId }) });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`invoices.info HTTP ${r.status}: ${text.slice(0, 200)}`);
  let inv = null; try { inv = JSON.parse(text).data; } catch {}
  if (!inv) throw new Error('invoices.info gaf geen data');

  // Customer-match.
  const invoiceeId = inv.invoicee?.customer?.id || null;
  const invoiceeType = inv.invoicee?.customer?.type || 'contact';
  const matchCol = invoiceeId ? (invoiceeType === 'company' ? 'tl_company_id' : 'tl_contact_id') : null;
  // Bouw een skip-record uit de TL-factuur (voor skip-and-advance in de cron).
  const skipResult = (reason) => ({
    action: 'skipped_no_customer',
    tl_invoice_id: inv.id,
    reason,
    invoicee_id: invoiceeId,
    invoicee_type: invoiceeId ? invoiceeType : null,
    match_column: matchCol,
    invoice_number: (inv.invoice_number && String(inv.invoice_number).trim()) || null,
    tl_department_id: inv.department?.id || null,
    invoice_date: isoDate(inv.invoice_date) || isoDate(inv.booked_on) || null,
    amount_total: amt(inv.total?.tax_inclusive) ?? amt(inv.total?.payable) ?? null,
    tl_updated_at: inv.updated_at || null,
  });
  if (!invoiceeId) {
    if (opts.skipIfNoCustomer) return skipResult('no_invoicee');
    throw new Error('Factuur heeft geen invoicee-customer in TL');
  }
  // Bestand tegen >1 customer met dezelfde tl_*-id (kan tijdelijk vóór de dedupe
  // + unique-index bestaan). maybeSingle() zou op >1 een error geven → null →
  // onterecht als "geen klant" behandeld. Kies daarom DETERMINISTISCH: actieve
  // rijen eerst (archived_at/anonymized_at NULL), dan oudste (created_at asc).
  const { data: custRows } = await supabaseAdmin.from('customers')
    .select('id, archived_at, anonymized_at')
    .eq(matchCol, invoiceeId)
    .order('archived_at', { ascending: true, nullsFirst: true })
    .order('anonymized_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true });
  const cust = (custRows && custRows.length) ? custRows[0] : null;
  if (custRows && custRows.length > 1) {
    console.warn(`[invoice-upsert] >1 customer met ${matchCol}=${invoiceeId} (${custRows.length}) — dedupe nodig; koos ${cust.id}`);
  }
  if (!cust) {
    if (opts.skipIfNoCustomer) return skipResult('no_customer');
    throw new Error(`Geen lokale klant met ${matchCol}=${invoiceeId}`);
  }

  // Bedragen.
  const t = inv.total || {};
  const incl = amt(t.tax_inclusive) ?? amt(t.payable) ?? 0;
  const excl = amt(t.tax_exclusive);
  const payable = amt(t.payable);
  const due = amt(t.due);
  const vat = (incl != null && excl != null) ? r2(incl - excl) : null;
  const paid = (payable != null && due != null) ? Math.max(0, r2(payable - due)) : (inv.paid === true ? r2(incl) : 0);
  const status = mapStatus(inv, payable, due);
  const issue = isoDate(inv.invoice_date) || isoDate(inv.booked_on) || new Date().toISOString().slice(0, 10);

  // Drafts hebben geen nummer → placeholder CONCEPT-<tl_id>.
  const rawNumber = (inv.invoice_number && String(inv.invoice_number).trim()) || null;
  const invoiceNumber = rawNumber || `CONCEPT-${inv.id}`;

  const row = {
    customer_id: cust.id,
    tl_invoice_id: inv.id,
    tl_department_id: inv.department?.id || opts.fallback_department || null,
    tl_subscription_id: inv.subscription?.id ?? null,
    invoice_number: invoiceNumber,
    amount_total: r2(incl),
    amount_paid: paid,
    vat_amount: vat,
    issue_date: issue,
    due_date: isoDate(inv.due_on) || null,
    paid_date: isoDate(inv.paid_at) || (status === 'paid' ? (isoDate(inv.updated_at) || null) : null),
    status,
    is_manual: opts.is_manual || false,
    pushed_to_tl: opts.pushed_to_tl || false,
    is_historical: false,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabaseAdmin.from('invoices').select('id, status, deal_id').eq('tl_invoice_id', inv.id).maybeSingle();
  const oldStatus = existing?.status || null;
  let invId;
  let action;
  if (existing) {
    const { error } = await supabaseAdmin.from('invoices').update(row).eq('id', existing.id);
    if (error) throw new Error('invoices update: ' + error.message);
    invId = existing.id; action = 'updated';
  } else {
    const { data: ins, error } = await supabaseAdmin.from('invoices').insert(row).select('id').single();
    if (error) throw new Error('invoices insert: ' + error.message);
    invId = ins.id; action = 'inserted';
  }

  // Sales-bonus lifecycle-hooks bij een status-TRANSITIE. Dit is HÉT choke-point
  // voor betalingen/credits die IN Teamleader gebeuren (cron-finance-sync roept
  // upsertInvoiceFromTl) — register-payment-internal loopt hier NIET langs.
  // Fail-soft + transitie-guard + idempotent in de helpers → nooit dubbel-earn/
  // dubbel-void, en mag de sync nooit breken.
  try {
    if ((status === 'paid' && oldStatus !== 'paid') || (status === 'credited' && oldStatus !== 'credited')) {
      const invLike = {
        id: invId,
        deal_id: existing?.deal_id || null,
        tl_subscription_id: row.tl_subscription_id,
        invoice_number: invoiceNumber,
      };
      if (status === 'paid') {
        const { earnBonusForPaidInvoice } = await import('./sales-bonus.js');
        await earnBonusForPaidInvoice(invLike);
      } else {
        const { voidBonusForCreditedInvoice } = await import('./sales-bonus.js');
        await voidBonusForCreditedInvoice(invLike, { source: 'tl-sync' });
      }
    }
  } catch (e) {
    console.warn('[invoice-upsert] sales-bonus hook soft-fail', invId, e?.message || e);
  }

  return { id: invId, invoice_number: invoiceNumber, status, action };
}
