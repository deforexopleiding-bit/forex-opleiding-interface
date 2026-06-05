// api/finance-invoice-remove-payment.js
// POST → draai ALLE geregistreerde betalingen van een factuur terug. TL-FIRST.
// Permission: finance.invoice.payment.remove.
//
// TL invoices.removePayments markeert de factuur als onbetaald en verwijdert alle
// gekoppelde betalingen (+ PDF re-render). Body (apiary-excerpt onvolledig; gebruik de
// gedocumenteerde simpele vorm — valt TL erover, dan toont tl_response het echte contract):
//   { id: <tl_invoice_id> }
//
// Body (onze): { invoice_id (onze uuid) OF tl_invoice_id }
// Validate-first: TL-fout → 422 + volledige tl_response, GEEN DB-mutatie. 502 bij netwerkfout.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) { await sleep(2000 * Math.pow(2, attempt)); return tlCall(path, body, attempt + 1); }
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.payment.remove'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.payment.remove)' });
  }

  const { invoice_id, tl_invoice_id } = req.body || {};
  if (!invoice_id && !tl_invoice_id) return res.status(400).json({ error: 'invoice_id of tl_invoice_id vereist' });

  try {
    // Resolve onze factuur (op id of tl_invoice_id).
    let q = supabaseAdmin.from('invoices').select('id, customer_id, tl_invoice_id, amount_total, amount_paid, status');
    q = invoice_id ? q.eq('id', invoice_id) : q.eq('tl_invoice_id', tl_invoice_id);
    const { data: inv } = await q.maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });
    const prevStatus = inv.status;

    // 1. TL-FIRST: verwijder alle betalingen. Faal → GEEN DB-mutatie.
    const body = { id: inv.tl_invoice_id };
    console.log('[finance-remove-payment] removePayments payload', JSON.stringify(body));
    let pr, prText = '';
    try {
      pr = await tlCall('/invoices.removePayments', body);
      prText = await pr.text().catch(() => '');
    } catch (netErr) {
      console.error('[finance-remove-payment] removePayments netwerk-fout', netErr.message);
      return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message });
    }
    if (!pr.ok) {
      console.error('[finance-remove-payment] removePayments GEWEIGERD | HTTP', pr.status, '| payload=', JSON.stringify(body), '| response=', prText);
      return res.status(422).json({ error: `Teamleader weigerde de actie (HTTP ${pr.status}).`, tl_status: pr.status, tl_response: prText });
    }
    console.log('[finance-remove-payment] removePayments OK | HTTP', pr.status);

    // 2. Her-sync via invoices.info → werkelijke amount_paid + status (verwacht: open, paid 0).
    let newPaid = 0, newStatus = 'open';
    try {
      const ir = await tlCall('/invoices.info', { id: inv.tl_invoice_id });
      if (ir.ok) {
        const info = (await ir.json()).data || {};
        const t = info.total || {};
        const payable = amt(t.payable) ?? amt(t.tax_inclusive) ?? (Number(inv.amount_total) || null);
        const due = amt(t.due);
        if (payable != null && due != null) newPaid = Math.max(0, r2(payable - due));
        newStatus = mapStatus(info, payable, due);
      } else { console.error('[finance-remove-payment] invoices.info HTTP', ir.status); }
    } catch (e) { console.error('[finance-remove-payment] invoices.info', e.message); }

    // 3. Onze payments-rijen voor deze factuur verwijderen.
    const { error: delErr } = await supabaseAdmin.from('payments').delete().eq('invoice_id', inv.id);
    if (delErr) console.error('[finance-remove-payment] payments delete', delErr.message);

    // 4. Factuur bijwerken.
    const { error: upErr } = await supabaseAdmin.from('invoices').update({
      amount_paid: newPaid, status: newStatus, paid_date: null, updated_at: new Date().toISOString(),
    }).eq('id', inv.id);
    if (upErr) { console.error('[finance-remove-payment] invoice update', upErr.message); return res.status(500).json({ error: 'TL bijgewerkt, maar DB-update faalde: ' + upErr.message }); }

    // 5. Audit.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.payment.remove',
        entity_type: 'invoice', entity_id: inv.id,
        after_json: { prev_status: prevStatus, new_status: newStatus, new_amount_paid: newPaid },
        reason_text: `Alle betalingen teruggedraaid op factuur ${inv.id} (${prevStatus} → ${newStatus})`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-remove-payment] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, amount_paid: newPaid, status: newStatus });
  } catch (e) {
    console.error('[finance-remove-payment]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
