// api/finance-bank-camt-balance.js
// GET → meest recente closing_balance_cents + statement_to datum uit
// camt_statements. Geen e-Boekhouden-lag, geen offset — pure bank-truth uit
// het laatst geüploade CAMT-bestand.
//
// Permission: finance.bank.balance_view.
//
// Response:
//   { balance_cents, as_of_date, source: 'camt', statement_id, file_name,
//     account_iban, num_statements }
//
// Bij geen statements (eerste gebruik): 200 met balance_cents=null en
// hint-message zodat UI empty-state kan tonen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.bank.balance_view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.balance_view)' });
  }

  try {
    // Ronde 5 fix: -€114 kwam uit één enkele CAMT-statement (globally most-
    // recent). Bij meerdere IBANs (bv hoofdrekening + PayPal-account) miste
    // dat de andere rekeningen én toonde het een tussentijds saldo. Correct:
    // per IBAN de laatste statement, som van closing_balance_cents. Voor
    // response-shape blijft `account_iban` = IBAN met grootste absolute
    // bijdrage (backwards-compat); nieuw `per_account[]` toont detail.
    const { data, error } = await supabaseAdmin
      .from('camt_statements')
      .select('id, file_name, account_iban, closing_balance_cents, statement_to, uploaded_at')
      .order('statement_to', { ascending: false, nullsFirst: false })
      .order('uploaded_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const rows = data || [];
    if (!rows.length) {
      return res.status(200).json({
        balance_cents:   null,
        as_of_date:      null,
        source:          'camt',
        message:         'Nog geen CAMT-bestand geüpload. Upload één om te beginnen.',
        num_statements:  0,
        per_account:     [],
      });
    }

    // Per unieke IBAN: eerste rij (hoogste statement_to, tiebreak uploaded_at).
    const byIban = new Map();
    for (const r of rows) {
      const key = r.account_iban || '(onbekend)';
      if (!byIban.has(key)) byIban.set(key, r);
    }
    const perAccount = Array.from(byIban.values()).map(r => ({
      account_iban:         r.account_iban || null,
      balance_cents:        r.closing_balance_cents,
      as_of_date:           r.statement_to,
      statement_id:         r.id,
      file_name:            r.file_name,
    }));

    // Totale slotsaldo = som over alle unieke IBANs.
    const totalCents = perAccount.reduce((a, x) => a + (Number(x.balance_cents) || 0), 0);
    // Meest recente peildatum = max(as_of_date) over alle IBANs.
    const asOfDate = perAccount.reduce((max, x) => (!max || (x.as_of_date && x.as_of_date > max)) ? x.as_of_date : max, null);
    // Backwards-compat: pick IBAN met grootste absolute bijdrage voor `account_iban`.
    const dominant = perAccount.slice().sort((a, b) => Math.abs(Number(b.balance_cents) || 0) - Math.abs(Number(a.balance_cents) || 0))[0] || {};

    const { count: total } = await supabaseAdmin
      .from('camt_statements')
      .select('id', { count: 'exact', head: true });

    return res.status(200).json({
      balance_cents:   totalCents,
      as_of_date:      asOfDate,
      source:          'camt',
      statement_id:    dominant.statement_id || null,
      file_name:       dominant.file_name || null,
      account_iban:    dominant.account_iban || null,
      num_statements:  total || 0,
      num_accounts:    perAccount.length,
      per_account:     perAccount,
    });
  } catch (e) {
    console.error('[finance-bank-camt-balance]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
