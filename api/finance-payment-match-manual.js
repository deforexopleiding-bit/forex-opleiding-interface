// api/finance-payment-match-manual.js
// POST → handmatige koppeling tussen een bank-tx (camt_transactions) en een
// factuur (invoices). Voor gevallen waar de auto-matcher niks vond.
//
// Body: { camt_transaction_id, invoice_id }
// Permission: finance.invoice.payment.register (zelfde als reguliere
// register-payment endpoint — schrijft TL + payments-row).
//
// Flow:
// 1. Validate camt_tx + invoice bestaan en invoice.status in
//    ('open','partially_paid','overdue').
// 2. Idempotency: als er al een payment_match_candidates row is voor deze
//    (camt_tx, invoice) combo met een confirm-status (confirmed,
//    auto_confirmed, manual_confirmed) → 409 'al gekoppeld'.
// 3. Insert nieuwe match-row status='manual_confirmed', score=100,
//    match_reasons=['manual_link']. Of UPDATE een bestaande 'suggested'
//    rij naar 'manual_confirmed' (kan voorkomen als de matcher een
//    laag-score voorstel had gemaakt).
// 4. registerPaymentInternal met camt_tx.amount_cents/100 + booking_date,
//    source='camt_match'. TL-FIRST — bij TL-fout: rollback match-row
//    naar 'suggested' is niet kritiek; we laten 'm op 'manual_confirmed'
//    maar zonder registered_payment_id — gebruiker ziet dan dat de
//    payment niet is gelukt en kan handmatig opnieuw.
// 5. UPDATE match-row met registered_payment_id, confirmed_by_user_id,
//    confirmed_at.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { registerPaymentInternal, RegisterPaymentError } from './_lib/register-payment-internal.js';
import { getClientIp } from './_lib/audit-customer.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

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

  const { camt_transaction_id, invoice_id } = req.body || {};
  if (!camt_transaction_id) return res.status(400).json({ error: 'camt_transaction_id vereist' });
  if (!invoice_id)          return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    // 1. Validate camt-tx.
    const { data: camt } = await supabaseAdmin
      .from('camt_transactions')
      .select('id, booking_date, amount_cents, description, counterparty_name')
      .eq('id', camt_transaction_id).maybeSingle();
    if (!camt) return res.status(404).json({ error: 'Bank-transactie niet gevonden' });
    if (!camt.amount_cents || Number(camt.amount_cents) <= 0) {
      return res.status(400).json({ error: 'Bank-transactie is geen inkomende betaling (amount_cents <= 0)' });
    }

    // 2. Validate invoice + open-status.
    const { data: inv } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, status, amount_total, amount_paid, tl_invoice_id')
      .eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!OPEN_STATUSES.includes(inv.status)) {
      return res.status(409).json({ error: `Factuur status '${inv.status}' — alleen open/partially_paid/overdue kunnen handmatig gekoppeld worden` });
    }
    if (!inv.tl_invoice_id) {
      return res.status(409).json({ error: 'Factuur heeft geen Teamleader-id (lokaal-only)' });
    }

    // 3. Idempotency: bestaande candidate voor deze combo?
    const { data: existing } = await supabaseAdmin
      .from('payment_match_candidates')
      .select('id, status, registered_payment_id')
      .eq('camt_transaction_id', camt_transaction_id)
      .eq('invoice_id', invoice_id)
      .maybeSingle();
    if (existing && ['confirmed', 'auto_confirmed', 'manual_confirmed'].includes(existing.status)) {
      return res.status(409).json({
        error: `Deze bank-tx is al gekoppeld aan factuur ${inv.invoice_number} (status: ${existing.status})`,
        match_id: existing.id,
        registered_payment_id: existing.registered_payment_id,
      });
    }

    // 4. Insert of UPDATE match-row naar 'manual_confirmed'.
    let matchId = existing?.id || null;
    if (existing) {
      const { error: upErr } = await supabaseAdmin
        .from('payment_match_candidates')
        .update({
          status:        'manual_confirmed',
          match_score:   100,
          match_reasons: ['manual_link'],
        })
        .eq('id', existing.id);
      if (upErr) throw new Error('match update: ' + upErr.message);
    } else {
      const { data: ins, error: insErr } = await supabaseAdmin
        .from('payment_match_candidates')
        .insert({
          camt_transaction_id,
          invoice_id,
          match_score:   100,
          match_reasons: ['manual_link'],
          status:        'manual_confirmed',
        })
        .select('id').single();
      if (insErr) throw new Error('match insert: ' + insErr.message);
      matchId = ins.id;
    }

    // 5. TL register-payment via shared internal helper.
    const amount = Number(camt.amount_cents) / 100;
    const paidAt = String(camt.booking_date).slice(0, 10);
    let payResult;
    try {
      payResult = await registerPaymentInternal({
        invoiceId:       inv.id,
        amount,
        paidAt,
        paymentMethodId: null,
        source:          'camt_match',
        userId:          user.id,
        ipAddress:       getClientIp(req),
      });
    } catch (e) {
      // TL of DB faalde — match-row blijft op manual_confirmed zonder
      // registered_payment_id. Geef de error transparant terug zodat
      // UI 'm kan tonen + gebruiker handmatig opnieuw kan proberen.
      if (e instanceof RegisterPaymentError) {
        const httpStatus = e.kind === 'validation' ? 400
                        : e.kind === 'tl_client'  ? 422
                        : e.kind === 'tl_network' ? 502
                        : e.kind === 'tl_server'  ? 502
                        :                            500;
        return res.status(httpStatus).json({
          error:        e.message,
          kind:         e.kind,
          details:      e.details,
          match_id:     matchId,
          warning:      'Match-koppeling is opgeslagen maar payment-registratie mislukte.',
        });
      }
      throw e;
    }

    // 6. UPDATE match-row met payment-link.
    const nowIso = new Date().toISOString();
    const { error: linkErr } = await supabaseAdmin
      .from('payment_match_candidates')
      .update({
        registered_payment_id: payResult.payment_db_id,
        confirmed_by_user_id:  user.id,
        confirmed_at:          nowIso,
      })
      .eq('id', matchId);
    if (linkErr) console.error('[match-manual] match link update', linkErr.message);

    return res.status(200).json({
      success:        true,
      match_id:       matchId,
      payment_id:     payResult.payment_db_id,
      invoice_status: payResult.status,
      invoice_amount_paid: payResult.amount_paid,
      message:        `Betaling €${amount.toFixed(2)} gekoppeld aan factuur ${inv.invoice_number}`,
    });
  } catch (e) {
    console.error('[finance-payment-match-manual]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
