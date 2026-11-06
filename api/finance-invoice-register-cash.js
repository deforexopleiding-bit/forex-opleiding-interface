// api/finance-invoice-register-cash.js
// POST → registreer een CONTANTE (deel)betaling op een open factuur.
// De factuur blijft staan en wordt NIET gecrediteerd. Thin wrapper rond
// api/_lib/cash-betaling.js, die de gewone betaalflow gebruikt
// (register-payment-internal: Teamleader-first + payments + factuurmotor).
//
// Body: { invoice_id, amount, paid_at (YYYY-MM-DD), ontvangen_door,
//         ontvangen_door_user_id?, notitie, bevestig_dubbel? }
// Permission: finance.invoice.payment.register (het bestaande betaalrecht).
// Er wordt niets verstuurd; het ontvangstbewijs is een PDF-download
// (/api/finance-cash-ontvangstbewijs?id=<bewijs.id>).

import { createUserClient } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { registreerCashBetaling, CashBetalingError } from './_lib/cash-betaling.js';

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

  try {
    const result = await registreerCashBetaling(req.body || {}, { userId: user.id, ipAddress: getClientIp(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    if (e instanceof CashBetalingError) {
      if (e.status >= 500) console.error('[finance-invoice-register-cash]', e.code, e.message);
      return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    }
    console.error('[finance-invoice-register-cash]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
