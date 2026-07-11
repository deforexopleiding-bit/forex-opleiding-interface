// api/_lib/invoice-credit.js
//
// creditInvoiceCore(invoiceId, { description, userId }) → {
//   invoice, tl_credit_note_id, synced, description
// }
//
// Gedeelde TL-credit-core. Roept /invoices.credit met MINIMAL parameters
// (TL default-mapping — geen grootboek/BTW overrides), doet daarna een
// creditnota-resync (creditNotes.info → credit_notes upsert →
// credited_amount herberekenen op invoices) + re-upsert van de originele
// factuur zodat status/payable weer klopt.
//
// Wordt gebruikt door:
//   - api/finance-invoice-credit.js  (handmatige TL-knop, per factuur)
//   - api/crediteer-ronde-execute.js (bulk crediteerronde, N facturen per klant)
//
// Gooit typed errors met `.code`:
//   - 'NOT_FOUND'              — factuur bestaat niet
//   - 'NO_TL_ID'               — factuur heeft geen tl_invoice_id
//   - 'CONCEPT_NOT_CREDITABLE' — status = 'concept'
//   - 'TL_NETWORK'             — netwerkfout richting TL
//   - 'TL_REFUSED'             — TL gaf non-2xx (details in .tlStatus / .tlText)
// De HTTP-caller mapt code → status; deze helper doet zelf géén audit-log,
// géén RBAC — dat is caller-verantwoordelijkheid.
//
// Belangrijk: gedrag moet identiek blijven aan de originele
// finance-invoice-credit.js (Combidesk → e-boekhouden flow ongewijzigd).

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';
import { upsertInvoiceFromTl } from './invoice-upsert.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tlCall(path, body, attempt = 0) {
  await sleep(150);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}

function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

function typedError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export async function creditInvoiceCore(invoiceId, opts = {}) {
  const description = opts.description ? String(opts.description) : null;

  // 1) Factuur ophalen (server-side, geen RBAC hier).
  const { data: inv, error: invErr } = await supabaseAdmin
    .from('invoices')
    .select('id, customer_id, tl_invoice_id, invoice_number, amount_total, status')
    .eq('id', invoiceId).maybeSingle();
  if (invErr) throw typedError('DB_ERROR', 'invoices lookup: ' + invErr.message);
  if (!inv) throw typedError('NOT_FOUND', 'Factuur niet gevonden');
  if (!inv.tl_invoice_id) throw typedError('NO_TL_ID', 'Factuur heeft geen Teamleader-id');
  if (inv.status === 'concept') {
    throw typedError('CONCEPT_NOT_CREDITABLE', 'Conceptfacturen kunnen niet gecrediteerd worden (verwijder ze).');
  }

  // 2) TL-credit call — MINIMAL body zoals in de handmatige flow.
  const body = { id: inv.tl_invoice_id };
  if (description) body.description = description;
  console.log('[invoice-credit-core] payload', JSON.stringify(body));

  let pr, prText = '';
  try {
    pr = await tlCall('/invoices.credit', body);
    prText = await pr.text().catch(() => '');
  } catch (netErr) {
    console.error('[invoice-credit-core] netwerk', netErr.message);
    throw typedError('TL_NETWORK', 'Kon Teamleader niet bereiken: ' + netErr.message);
  }
  if (!pr.ok) {
    console.error('[invoice-credit-core] GEWEIGERD | HTTP', pr.status, '| payload=', JSON.stringify(body), '| response=', prText);
    throw typedError('TL_REFUSED', `Teamleader weigerde de creditnota (HTTP ${pr.status}).`, {
      tlStatus: pr.status,
      tlText: prText,
    });
  }
  let creditId = null;
  try { creditId = JSON.parse(prText)?.data?.id || null; } catch (_) {}
  console.log('[invoice-credit-core] OK | HTTP', pr.status, '| credit_note_id', creditId);

  // 3) Re-sync deze ene creditnota — zelfde patroon als de originele
  //    finance-invoice-credit.js. Fail-soft: DB kan lagen achter, maar de
  //    TL-credit is al gebeurd, dus we blokkeren de caller niet.
  let synced = false;
  try {
    if (creditId) {
      const cr = await tlCall('/creditNotes.info', { id: creditId });
      if (cr.ok) {
        const cn = (await cr.json()).data || {};
        const incl = r2(amt(cn.total?.tax_inclusive) ?? amt(cn.total?.payable) ?? 0);
        const tlInv = cn.invoice?.id || inv.tl_invoice_id;
        const row = {
          tl_credit_note_id: cn.id,
          credit_note_number: cn.invoice_number || cn.number || cn.credit_note_number || null,
          tl_invoice_id: tlInv,
          invoice_id: inv.id,
          department_id: cn.department?.id || null,
          amount_total: incl,
          credit_note_date: isoDate(cn.credit_note_date || cn.date || cn.booked_on),
          status: cn.status || null,
          updated_at: new Date().toISOString(),
        };
        const { data: ex } = await supabaseAdmin.from('credit_notes')
          .select('id').eq('tl_credit_note_id', cn.id).maybeSingle();
        if (ex) await supabaseAdmin.from('credit_notes').update(row).eq('id', ex.id);
        else    await supabaseAdmin.from('credit_notes').insert(row);

        // credited_amount op de factuur herberekenen.
        const { data: rows } = await supabaseAdmin.from('credit_notes')
          .select('amount_total').eq('invoice_id', inv.id);
        const sum = r2((rows || []).reduce((a, r) => a + (Number(r.amount_total) || 0), 0));
        await supabaseAdmin.from('invoices')
          .update({ credited_amount: sum, updated_at: new Date().toISOString() })
          .eq('id', inv.id);
        synced = true;
      } else {
        console.error('[invoice-credit-core] creditNotes.info HTTP', cr.status);
      }
    }
  } catch (e) {
    console.error('[invoice-credit-core] sync', e.message);
  }

  // 4) Re-upsert originele factuur — status/payable kan gewijzigd zijn.
  try {
    await upsertInvoiceFromTl(inv.tl_invoice_id);
  } catch (e) {
    console.error('[invoice-credit-core] invoice resync', e.message);
  }

  return {
    invoice: inv,
    tl_credit_note_id: creditId,
    synced,
    description,
  };
}
