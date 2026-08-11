// api/finance-bank-camt-balance.js
//
// GET → slotsaldo (closing_balance_cents) per IBAN uit de MEEST RECENTE
// CAMT.053-statement van elke actieve bank-account. Sommert deze per-IBAN
// slotsaldos tot een grand-total.
//
// Sign-correctness: de parser (api/_lib/camt-parser.js:94) doet ALREADY de
// CdtDbtInd (CRDT / DBIT) → signed value conversie voor sla-in-DB. Dus
// closing_balance_cents in camt_statements is REEDS signed (negatief =
// overdraft / debit-slot). Deze endpoint hoeft alleen te sommeren.
//
// Ronde 5b fix: filter op is_active bank_accounts. Voorkomt dat oude
// test-CAMT-uploads (verkeerde IBAN, DBIT-test) of PayPal-import-rijen
// (aparte 'IBAN' als test-account) de som vervuilen. Bij lege
// bank_accounts (nieuwe workspace zonder GoCardless-koppeling): fallback
// op alle unieke IBANs uit camt_statements zoals voorheen.
//
// Permission: finance.bank.balance_view.
//
// Response:
//   {
//     balance_cents,        // grand-total (signed, in cents)
//     as_of_date,           // max(statement_to) over alle actieve IBANs
//     source: 'camt',
//     account_iban,         // dominant IBAN voor backwards-compat
//     statement_id,         // ID van de dominant-statement (largest abs)
//     file_name,            // filename van dominant
//     num_statements,       // total camt_statements-count (info)
//     num_accounts,         // aantal actieve IBANs meegetald
//     num_accounts_ignored, // aantal camt_statements-IBANs SKIPPED (filter)
//     per_account: [{iban, balance_cents, as_of_date, statement_id, file_name, source}]
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// IBAN-normalisatie: strip spaties + uppercase, zodat "NL01 INGB 0000 1234 56"
// matcht "NL01INGB0000123456".
function normalizeIban(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, '').toUpperCase();
}

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
    // 1. Actieve bank_accounts (canonical source). Bij lege lijst → geen
    //    filter (fallback op alle CAMT-IBANs).
    const { data: accts, error: acctsErr } = await supabaseAdmin
      .from('bank_accounts')
      .select('iban')
      .eq('is_active', true);
    if (acctsErr) throw new Error('bank_accounts: ' + acctsErr.message);
    const activeIbansSet = new Set(
      (accts || [])
        .map(a => normalizeIban(a.iban))
        .filter(Boolean)
    );
    const filterOnActive = activeIbansSet.size > 0;

    // 2. Fetch camt_statements (recente eerst). Limit 500 = ruim voldoende
    //    om per-IBAN de laatste te vinden bij realistische historie.
    const { data: rows, error: stmtErr } = await supabaseAdmin
      .from('camt_statements')
      .select('id, file_name, account_iban, closing_balance_cents, statement_to, uploaded_at')
      .order('statement_to', { ascending: false, nullsFirst: false })
      .order('uploaded_at', { ascending: false })
      .limit(500);
    if (stmtErr) throw new Error('camt_statements: ' + stmtErr.message);

    const stmts = rows || [];
    if (!stmts.length) {
      return res.status(200).json({
        balance_cents:   null,
        as_of_date:      null,
        source:          'camt',
        message:         'Nog geen CAMT-bestand geüpload. Upload één om te beginnen.',
        num_statements:  0,
        num_accounts:    0,
        num_accounts_ignored: 0,
        per_account:     [],
      });
    }

    // 3. Per-IBAN pak de EERSTE rij (= meest recente statement_to, tiebreak
    //    op uploaded_at). Skip IBANs die niet in bank_accounts staan (indien
    //    filter actief).
    const byIban = new Map();
    let ignoredCount = 0;
    for (const s of stmts) {
      const key = normalizeIban(s.account_iban);
      if (!key) { ignoredCount++; continue; } // camt zonder IBAN — skip
      if (filterOnActive && !activeIbansSet.has(key)) { ignoredCount++; continue; }
      if (!byIban.has(key)) byIban.set(key, s);
    }

    if (byIban.size === 0) {
      return res.status(200).json({
        balance_cents:   null,
        as_of_date:      null,
        source:          'camt',
        message:         filterOnActive
          ? 'CAMT-statements gevonden, maar geen enkele IBAN matcht een actieve bank_accounts-rij. Controleer bank_accounts.iban.'
          : 'CAMT-statements gevonden, maar allen zonder account_iban. Herupload met IBAN in stmt-header.',
        num_statements:        stmts.length,
        num_accounts:          0,
        num_accounts_ignored:  ignoredCount,
        per_account:           [],
      });
    }

    const perAccount = Array.from(byIban.entries()).map(([iban, r]) => ({
      account_iban:  iban,
      balance_cents: Number(r.closing_balance_cents) || 0, // parser levert al signed
      as_of_date:    r.statement_to,
      statement_id:  r.id,
      file_name:     r.file_name,
      source:        'camt',
    }));

    // 4. Sommering + peildatum + dominant-IBAN voor backwards-compat.
    const totalCents = perAccount.reduce((a, x) => a + x.balance_cents, 0);
    const asOfDate = perAccount.reduce(
      (max, x) => (!max || (x.as_of_date && x.as_of_date > max)) ? x.as_of_date : max,
      null
    );
    const dominant = perAccount.slice().sort(
      (a, b) => Math.abs(b.balance_cents) - Math.abs(a.balance_cents)
    )[0] || {};

    // 5. Total camt-count voor info (num_statements).
    const { count: totalStmts } = await supabaseAdmin
      .from('camt_statements')
      .select('id', { count: 'exact', head: true });

    return res.status(200).json({
      balance_cents:         totalCents,
      as_of_date:            asOfDate,
      source:                'camt',
      statement_id:          dominant.statement_id || null,
      file_name:             dominant.file_name || null,
      account_iban:          dominant.account_iban || null,
      num_statements:        totalStmts || 0,
      num_accounts:          perAccount.length,
      num_accounts_ignored:  ignoredCount,
      per_account:           perAccount,
    });
  } catch (e) {
    console.error('[finance-bank-camt-balance]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
