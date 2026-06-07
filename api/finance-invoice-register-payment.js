// api/finance-invoice-register-payment.js
// POST → registreer een (deel)betaling op een factuur. Thin wrapper rond
// _lib/register-payment-internal.js (gedeeld met camt-upload autopilot).
//
// Body: { invoice_id (onze uuid), amount (number > 0), paid_at (YYYY-MM-DD),
//         payment_method_id? }
// Permission: finance.invoice.payment.register.

import { createUserClient } from './supabase.js';
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

  const { invoice_id, amount, paid_at, payment_method_id } = req.body || {};

  try {
    const result = await registerPaymentInternal({
      invoiceId:       invoice_id,
      amount,
      paidAt:          paid_at,
      paymentMethodId: payment_method_id,
      source:          'manual',
      userId:          user.id,
      ipAddress:       getClientIp(req),
    });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    if (e instanceof RegisterPaymentError) {
      // Map error-kind naar HTTP status + body-shape.
      if (e.kind === 'validation') {
        return res.status(400).json({ error: e.message });
      }
      if (e.kind === 'tl_client') {
        return res.status(422).json({
          error: e.message,
          tl_status: e.details?.tl_status,
          tl_response: e.details?.tl_response
                    || `datetime: ${e.details?.tl_response_datetime || ''} | date-only: ${e.details?.tl_response_date_only || ''}`,
          tl_response_datetime: e.details?.tl_response_datetime,
          tl_response_date_only: e.details?.tl_response_date_only,
        });
      }
      if (e.kind === 'tl_network') {
        return res.status(502).json({ error: e.message });
      }
      if (e.kind === 'tl_server') {
        return res.status(502).json({
          error: e.message,
          tl_status: e.details?.tl_status,
          tl_response: e.details?.tl_response,
        });
      }
      if (e.kind === 'db') {
        return res.status(500).json({ error: e.message });
      }
    }
    console.error('[finance-invoice-register-payment]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
