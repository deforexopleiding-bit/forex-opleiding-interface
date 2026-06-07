// api/finance-payment-match-confirm.js
// POST → bevestig een match-candidate handmatig. Roept registerPaymentInternal
// aan voor TL-cascade + DB-mutaties. Update match-row naar 'confirmed' bij
// succes; geen status-wijziging bij TL-fout (UI kan retry tonen).
//
// Body: { match_id }
// Permission: finance.invoice.payment.register (zelfde als handmatige flow).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { registerPaymentInternal, RegisterPaymentError } from './_lib/register-payment-internal.js';

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

  const { match_id } = req.body || {};
  if (!match_id) return res.status(400).json({ error: 'match_id vereist' });

  try {
    // Lees match-row + JOIN voor camt-data (amount + booking_date).
    const { data: m, error: mErr } = await supabaseAdmin
      .from('payment_match_candidates')
      .select(`
        id, status, invoice_id, camt_transaction_id,
        camt_transactions ( amount_cents, booking_date )
      `)
      .eq('id', match_id)
      .maybeSingle();
    if (mErr) throw new Error(mErr.message);
    if (!m) return res.status(404).json({ error: 'Match niet gevonden' });
    if (m.status !== 'suggested') {
      return res.status(409).json({ error: `Match heeft status '${m.status}', alleen 'suggested' kan bevestigd worden` });
    }
    const tx = m.camt_transactions || {};
    if (!tx.amount_cents || !tx.booking_date) {
      return res.status(500).json({ error: 'CAMT-transactie-data ontbreekt op match' });
    }

    // Roep internal aan met camt-amount (in EUR) + booking_date.
    let result;
    try {
      result = await registerPaymentInternal({
        invoiceId:       m.invoice_id,
        amount:          (Number(tx.amount_cents) || 0) / 100,
        paidAt:          String(tx.booking_date).slice(0, 10),
        paymentMethodId: null,
        source:          'camt_match',
        userId:          user.id,
        ipAddress:       getClientIp(req),
      });
    } catch (e) {
      if (e instanceof RegisterPaymentError) {
        if (e.kind === 'validation') return res.status(400).json({ error: e.message });
        if (e.kind === 'tl_client') return res.status(422).json({
          error: e.message,
          tl_status: e.details?.tl_status,
          tl_response: e.details?.tl_response
                    || `datetime: ${e.details?.tl_response_datetime || ''} | date-only: ${e.details?.tl_response_date_only || ''}`,
        });
        if (e.kind === 'tl_network' || e.kind === 'tl_server') return res.status(502).json({ error: e.message });
        if (e.kind === 'db') return res.status(500).json({ error: e.message });
      }
      throw e;
    }

    // Update match-row → confirmed.
    const { error: upErr } = await supabaseAdmin
      .from('payment_match_candidates')
      .update({
        status:                'confirmed',
        confirmed_by_user_id:  user.id,
        confirmed_at:          new Date().toISOString(),
        registered_payment_id: result.payment_db_id,
      })
      .eq('id', match_id);
    if (upErr) {
      // Edge: TL+payment OK maar match-update faalt — niet-blokkerend, log.
      console.error('[finance-payment-match-confirm] match update', upErr.message);
    }

    return res.status(200).json({
      success: true,
      match_id,
      invoice_id: result.invoice_id,
      amount_paid: result.amount_paid,
      status: result.status,
      payment_db_id: result.payment_db_id,
    });
  } catch (e) {
    console.error('[finance-payment-match-confirm]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
