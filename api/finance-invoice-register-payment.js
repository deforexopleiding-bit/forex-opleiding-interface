// api/finance-invoice-register-payment.js
// POST → registreer een (deel)betaling op een factuur. TL-FIRST + validate-first:
// eerst invoices.registerPayment in Teamleader; pas bij succes onze payments-tabel +
// factuurstatus bijwerken (her-sync via invoices.info). SUPER_ADMIN ONLY.
// (De Aron→Jeffrey approval-laag is de aparte volgende 2B-stap.)
//
// Body: { invoice_id (onze uuid), amount (number > 0), paid_at (datum/ISO), payment_method_id? }
//
// TL invoices.registerPayment body (gemengde shape — afgeleid uit onze TL 400-responses):
//   { id: <tl_invoice_id>,
//     payment: { amount: <number>, currency: 'EUR' },   // amount=getal, currency los (NIET genest)
//     paid_at: '<ISO 8601 datetime met offset, bv 2026-06-04T00:00:00+00:00>' }  // TOP-NIVEAU
//   Fallback bij "paid_at must be valid": retry met kale 'YYYY-MM-DD' op top-niveau.
// Bedragen in euro's (floats), GEEN centen → 0.01 blijft 0.01.
// Partial payments worden ondersteund (meerdere calls tellen op). Terugdraaien:
// invoices.removePayments { id, payment_ids[] }.

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
// Zelfde mapping als de factuur-sync (overdue NIET opgeslagen — dynamisch in GET/UI).
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
  if (!(await requirePermission(req, 'finance.invoice.payment.register'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.payment.register)' });
  }

  const { invoice_id, amount, paid_at, payment_method_id } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) return res.status(400).json({ error: 'Geldig bedrag (> 0) vereist' });

  try {
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, customer_id, tl_invoice_id, amount_total, amount_paid, status').eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id (handmatige factuur — volgt in 2B)' });

    // paid_at: valideer als plain ISO-date "YYYY-MM-DD". Leeg/ongeldig → 400 (niet doorsturen).
    const dateOnly = String(paid_at || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) || isNaN(new Date(dateOnly + 'T00:00:00Z').getTime())) {
      return res.status(400).json({ error: 'Ongeldige of ontbrekende betaaldatum (YYYY-MM-DD vereist)' });
    }

    // 1. TL-FIRST: registreer de betaling. Faal → GEEN DB-mutatie.
    // Gemengde shape (afgeleid uit ONZE TL 400-responses, niet de MCP-doc):
    //   payment.amount = GETAL (r2), payment.currency = los veld (NIET genest in amount),
    //   paid_at op TOP-NIVEAU naast id+payment, als volledige ISO datetime mét offset.
    //   payment_method_id nu weggelaten.
    const buildBody = (paidVal) => ({
      id: inv.tl_invoice_id,
      payment: { amount: r2(amtNum), currency: 'EUR' },
      paid_at: paidVal,
    });
    const tryRegister = async (paidVal) => {
      const body = buildBody(paidVal);
      console.log('[finance-register-payment] registerPayment payload', JSON.stringify(body));
      const r = await tlCall('/invoices.registerPayment', body);
      const text = await r.text().catch(() => '');
      return { r, text };
    };

    const paidDateTime = `${dateOnly}T00:00:00+00:00`;
    let pr, prText = '';
    try {
      // Poging 1: volledige ISO datetime mét offset op top-niveau.
      ({ r: pr, text: prText } = await tryRegister(paidDateTime));
      // EÉN fallback: enkel als TL specifiek op paid_at-formaat valt → retry met kale date.
      if (!pr.ok && /paid_at must be valid/i.test(prText)) {
        const firstText = prText;
        console.warn('[finance-register-payment] "paid_at must be valid" op datetime → retry met date-only');
        ({ r: pr, text: prText } = await tryRegister(dateOnly));
        if (!pr.ok) {
          // GEEN DB-mutatie. Beide TL-responses teruggeven (gelabeld).
          console.error('[finance-register-payment] beide paid_at-vormen GEWEIGERD | datetime=', firstText, '| date-only=', prText);
          return res.status(422).json({
            error: `Teamleader weigerde de betaling (HTTP ${pr.status}).`,
            tl_status: pr.status,
            tl_response_datetime: firstText,
            tl_response_date_only: prText,
            tl_response: `datetime: ${firstText} | date-only: ${prText}`,
          });
        }
      }
    } catch (netErr) {
      console.error('[finance-register-payment] registerPayment netwerk-fout', netErr.message);
      return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message });
    }
    if (!pr.ok) {
      // Elke andere TL-fout: 422 met de volledige tl_response, geen retry. GEEN DB-mutatie.
      console.error('[finance-register-payment] registerPayment GEWEIGERD | HTTP', pr.status, '| response=', prText);
      return res.status(422).json({ error: `Teamleader weigerde de betaling (HTTP ${pr.status}).`, tl_status: pr.status, tl_response: prText });
    }
    console.log('[finance-register-payment] registerPayment OK | HTTP', pr.status);

    // 2. Her-sync via invoices.info → werkelijke amount_paid + status.
    let newPaid = Math.min(r2((Number(inv.amount_paid) || 0) + amtNum), Number(inv.amount_total) || Infinity);
    let newStatus = inv.status, paidDate = dateOnly;
    try {
      const ir = await tlCall('/invoices.info', { id: inv.tl_invoice_id });
      if (ir.ok) {
        const info = (await ir.json()).data || {};
        const t = info.total || {};
        const payable = amt(t.payable) ?? amt(t.tax_inclusive) ?? (Number(inv.amount_total) || null);
        const due = amt(t.due);
        if (payable != null && due != null) newPaid = Math.max(0, r2(payable - due));
        newStatus = mapStatus(info, payable, due);
        paidDate = isoDate(info.paid_at) || paidDate;
      } else { console.error('[finance-register-payment] invoices.info HTTP', ir.status); }
    } catch (e) { console.error('[finance-register-payment] invoices.info', e.message); }

    // 3. payments-rij (na succesvolle TL-registratie).
    const { error: payErr } = await supabaseAdmin.from('payments').insert({
      customer_id: inv.customer_id, invoice_id: inv.id, amount: r2(amtNum),
      payment_date: dateOnly, payment_method: payment_method_id ? String(payment_method_id) : null,
      source: 'manual', matched_by: user.id,
    });
    if (payErr) console.error('[finance-register-payment] payments insert', payErr.message);

    // 4. Factuur bijwerken.
    const { error: upErr } = await supabaseAdmin.from('invoices').update({
      amount_paid: newPaid, status: newStatus,
      paid_date: newStatus === 'paid' ? (paidDate || dateOnly) : null,
      updated_at: new Date().toISOString(),
    }).eq('id', inv.id);
    if (upErr) { console.error('[finance-register-payment] invoice update', upErr.message); return res.status(500).json({ error: 'Betaling in TL geregistreerd, maar DB-update faalde: ' + upErr.message }); }

    // 5. Audit.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'finance_invoice.register_payment',
        entity_type: 'invoice', entity_id: inv.id,
        after_json: { amount: r2(amtNum), paid_at: dateOnly, payment_method_id: payment_method_id || null, new_status: newStatus, new_amount_paid: newPaid },
        reason_text: `Betaling €${r2(amtNum)} geregistreerd op factuur ${inv.id} (status → ${newStatus})`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-register-payment] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, amount_paid: newPaid, status: newStatus });
  } catch (e) {
    console.error('[finance-register-payment]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
