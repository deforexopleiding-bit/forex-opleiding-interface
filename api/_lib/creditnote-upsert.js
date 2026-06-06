// api/_lib/creditnote-upsert.js
// Mapper + upsert van één TL-creditnota in onze `credit_notes`-tabel, plus
// recompute van invoices.credited_amount voor één of meerdere geraakte facturen.
//
// Hergebruikt door cron-finance-sync.js en (toekomstig) write-endpoints. Idempotent
// (SELECT → UPDATE/INSERT op tl_credit_note_id). Geëxtraheerd uit het ingebakken
// patroon in finance-creditnote-sync.js zodat de cron precies hetzelfde gedrag krijgt.
//
// Net als invoice-upsert: partial unique index kan geen ON CONFLICT-arbiter zijn
// (lesson 20 mei) → expliciet 2-staps.

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

// TL koppelt creditnota's aan de originele factuur via `invoice.id` (object-ref).
// Defensieve fallbacks voor oudere/afwijkende shapes.
function invoiceRefId(cn) {
  if (cn?.invoice?.id) return cn.invoice.id;
  if (typeof cn?.invoice === 'string') return cn.invoice;
  if (cn?.invoiced_document?.id) return cn.invoiced_document.id;
  if (cn?.invoice_id) return cn.invoice_id;
  return null;
}

/**
 * Haalt creditNotes.info op en upsert in `credit_notes`. Returnt het geraakte
 * (lokale) invoice_id zodat de caller kan batchen voor recompute.
 *
 * @param {string} tlCreditNoteId
 * @returns {Promise<{ id: string, credit_note_number: string|null, action: 'inserted'|'updated', invoice_id: string|null, tl_invoice_id: string|null }>}
 */
export async function upsertCreditNoteFromTl(tlCreditNoteId) {
  if (!tlCreditNoteId) throw new Error('tl_credit_note_id vereist');
  const r = await tlFetch('/creditNotes.info', { method: 'POST', body: JSON.stringify({ id: tlCreditNoteId }) });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`creditNotes.info HTTP ${r.status}: ${text.slice(0, 200)}`);
  let cn = null; try { cn = JSON.parse(text).data; } catch {}
  if (!cn) throw new Error('creditNotes.info gaf geen data');

  const tlInvId = invoiceRefId(cn);
  const incl = r2(amt(cn.total?.tax_inclusive) ?? amt(cn.total?.payable) ?? 0);

  // Koppel aan onze factuur via tl_invoice_id (NULL als TL-factuur nog niet in onze DB staat).
  let invoiceUuid = null;
  if (tlInvId) {
    const { data: invRow } = await supabaseAdmin
      .from('invoices').select('id').eq('tl_invoice_id', tlInvId).maybeSingle();
    invoiceUuid = invRow?.id || null;
  }

  const row = {
    tl_credit_note_id:  cn.id,
    credit_note_number: cn.invoice_number || cn.number || cn.credit_note_number || null,
    tl_invoice_id:      tlInvId,
    invoice_id:         invoiceUuid,
    department_id:      cn.department?.id || null,
    amount_total:       incl,
    credit_note_date:   isoDate(cn.credit_note_date || cn.date || cn.booked_on),
    status:             cn.status || null,
    updated_at:         new Date().toISOString(),
  };

  const { data: existing } = await supabaseAdmin
    .from('credit_notes').select('id').eq('tl_credit_note_id', cn.id).maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin.from('credit_notes').update(row).eq('id', existing.id);
    if (error) throw new Error('credit_notes update: ' + error.message);
    return { id: existing.id, credit_note_number: row.credit_note_number, action: 'updated', invoice_id: invoiceUuid, tl_invoice_id: tlInvId };
  } else {
    const { data: ins, error } = await supabaseAdmin.from('credit_notes').insert(row).select('id').single();
    if (error) throw new Error('credit_notes insert: ' + error.message);
    return { id: ins.id, credit_note_number: row.credit_note_number, action: 'inserted', invoice_id: invoiceUuid, tl_invoice_id: tlInvId };
  }
}

/**
 * Herbereken invoices.credited_amount = som(credit_notes.amount_total) voor elke
 * gegeven invoice-uuid. Negeert fouten per item (logt + continue).
 *
 * @param {Iterable<string>} invoiceIds
 * @returns {Promise<{ updated: number, errors: number }>}
 */
export async function recomputeCreditedAmount(invoiceIds) {
  const stats = { updated: 0, errors: 0 };
  for (const invoiceId of invoiceIds) {
    if (!invoiceId) continue;
    try {
      const { data: rows } = await supabaseAdmin
        .from('credit_notes').select('amount_total').eq('invoice_id', invoiceId);
      const sum = Math.round((rows || []).reduce((a, r) => a + (Number(r.amount_total) || 0), 0) * 100) / 100;
      const { error } = await supabaseAdmin
        .from('invoices')
        .update({ credited_amount: sum, updated_at: new Date().toISOString() })
        .eq('id', invoiceId);
      if (error) throw new Error(error.message);
      stats.updated++;
    } catch (e) {
      stats.errors++;
      console.error('[creditnote-upsert] recompute', invoiceId, e.message);
    }
  }
  return stats;
}
