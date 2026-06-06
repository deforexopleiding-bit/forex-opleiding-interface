// api/finance-bank-balance.js
// GET → actueel saldo van de bank-rekening (default ING ledger 1010).
// Permission: finance.bank.view.
//
// Implementatie: live-call naar /v1/ledger/{id}/balance van e-Boekhouden
// (bestaat in REST, bevestigd via Mantix Client.php getLedgerBalance).
//
// Response:
//   { balance_cents, as_of_date, source: 'eboekhouden', ledger_id }
//
// Bij fout: 502 met tl_response-style echo. Geen DB-fallback want saldo is
// inherent realtime — een cached balans uit DB zou misleidend zijn.

import { createUserClient } from './supabase.js';
import { ebFetch } from './_lib/eboekhouden-token.js';
import { requirePermission } from './_lib/requirePermission.js';

const DEFAULT_BANK_LEDGER = 1010;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.bank.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.view)' });
  }

  const ledgerId = Number(process.env.EBH_BANK_LEDGER_ID) || DEFAULT_BANK_LEDGER;

  try {
    const r = await ebFetch('GET', `/ledger/${ledgerId}/balance`);
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      console.error('[finance-bank-balance] HTTP', r.status, text.slice(0, 300));
      return res.status(502).json({
        error: `e-Boekhouden /ledger/${ledgerId}/balance HTTP ${r.status}`,
        eb_response: text.slice(0, 2000),
      });
    }
    let data = null;
    try { data = JSON.parse(text); }
    catch { return res.status(502).json({ error: 'e-Boekhouden balance response niet parsebaar', eb_response: text.slice(0, 500) }); }

    // Response-shape niet expliciet bevestigd in Mantix docs — defensieve
    // veld-extractie: probeer balance / amount / total / saldo. Centen
    // conversie: als bedrag een float is, *100; als al integer in cents, direct.
    const raw = data.balance ?? data.amount ?? data.total ?? data.saldo ?? null;
    if (raw == null) {
      return res.status(502).json({
        error: 'Saldo-veld niet gevonden in e-Boekhouden response',
        eb_response_keys: Object.keys(data || {}),
        eb_response_sample: data,
      });
    }
    const rawNum = Number(raw);
    if (!Number.isFinite(rawNum)) {
      return res.status(502).json({ error: 'Saldo-veld niet numeriek', raw_value: raw });
    }
    // Defensief: euros (decimaal) → centen. Als e-Boekhouden int-cents al levert,
    // detecteer aan ontbreken van decimalen + grote magnitude (zeldzaam).
    const balanceCents = Math.round(rawNum * 100);

    const asOfDate = data.asOfDate || data.date || new Date().toISOString().slice(0, 10);

    return res.status(200).json({
      balance_cents: balanceCents,
      as_of_date:    asOfDate,
      source:        'eboekhouden',
      ledger_id:     ledgerId,
    });
  } catch (e) {
    console.error('[finance-bank-balance]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
