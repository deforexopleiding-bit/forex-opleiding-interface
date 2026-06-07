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
    // Meest recente statement op basis van statement_to date (= einde periode).
    // Bij gelijke datum: meest recent geüpload eerst.
    const { data, error } = await supabaseAdmin
      .from('camt_statements')
      .select('id, file_name, account_iban, closing_balance_cents, statement_to, uploaded_at')
      .order('statement_to', { ascending: false, nullsFirst: false })
      .order('uploaded_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    if (!data || !data.length) {
      return res.status(200).json({
        balance_cents:   null,
        as_of_date:      null,
        source:          'camt',
        message:         'Nog geen CAMT-bestand geüpload. Upload één om te beginnen.',
        num_statements:  0,
      });
    }

    const stmt = data[0];

    // Totaal aantal statements (voor UI-info).
    const { count: total } = await supabaseAdmin
      .from('camt_statements')
      .select('id', { count: 'exact', head: true });

    return res.status(200).json({
      balance_cents:   stmt.closing_balance_cents,
      as_of_date:      stmt.statement_to,
      source:          'camt',
      statement_id:    stmt.id,
      file_name:       stmt.file_name,
      account_iban:    stmt.account_iban,
      num_statements:  total || 0,
    });
  } catch (e) {
    console.error('[finance-bank-camt-balance]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
