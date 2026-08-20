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

// IBAN-validatie (structuur, geen checksum-check). Format: 2 letters
// country + 2 digits checksum + 10-30 alphanumeric. Sluit pseudo-accounts
// uit die geen echte IBAN zijn — bv. "PAYPAL" (PayPal CSV-import pakt de
// header-label als account_iban). Ronde-5e fix na Jeffrey's debug:
// grand-total was -€258 omdat een PAYPAL-pseudo-account met onzin-saldo
// werd meegeteld naast de echte NL53INGB* rekening.
function isValidIban(s) {
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(String(s || ''));
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
    // 1. Alle bank_accounts (canonical registry). Voor F2 fix-ronde-2:
    //    haal ook INACTIEVE rijen op zodat we onderscheid kunnen maken
    //    tussen 'registered' (actief), 'inactive' (bekend maar uitgeschakeld)
    //    en 'unregistered' (niet in bank_accounts). Filter voor grand-total
    //    blijft actief-only via activeIbansSet.
    const { data: accts, error: acctsErr } = await supabaseAdmin
      .from('bank_accounts')
      .select('iban, is_active');
    if (acctsErr) throw new Error('bank_accounts: ' + acctsErr.message);
    const activeIbansSet = new Set();
    const inactiveIbansSet = new Set();
    for (const a of (accts || [])) {
      const k = normalizeIban(a.iban);
      if (!k) continue;
      if (a.is_active) activeIbansSet.add(k);
      else             inactiveIbansSet.add(k);
    }
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
    //    op uploaded_at). FIX-RONDE-2 F2: bewaar ALLE geldige IBAN's — ook
    //    inactive en unregistered — zodat de UI ze zichtbaar kan maken met
    //    een status-label. Grand-total telt alleen de actieve set.
    const byIban = new Map();
    let ignoredCount = 0; // pseudo-accounts + rijen zonder IBAN
    for (const s of stmts) {
      const key = normalizeIban(s.account_iban);
      if (!key) { ignoredCount++; continue; }
      if (!isValidIban(key)) { ignoredCount++; continue; } // PAYPAL etc.
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

    // FIX-RONDE-2 F2: per-account met status-label.
    //   'registered'   → IBAN in bank_accounts + is_active=true (telt in totaal)
    //   'inactive'     → IBAN in bank_accounts + is_active=false
    //   'unregistered' → IBAN nergens in bank_accounts (CAMT-only)
    const perAccount = Array.from(byIban.entries()).map(([iban, r]) => {
      let status = 'unregistered';
      if (activeIbansSet.has(iban))        status = 'registered';
      else if (inactiveIbansSet.has(iban)) status = 'inactive';
      return {
        account_iban:  iban,
        balance_cents: Number(r.closing_balance_cents) || 0, // parser levert al signed
        as_of_date:    r.statement_to,
        statement_id:  r.id,
        file_name:     r.file_name,
        source:        'camt',
        status,
      };
    });
    // Grand-total telt alleen registered accounts (voorheen: alle passeerden
    // sowieso al de filter). Behoud num_accounts_ignored voor UI-samenvatting.
    const registeredAccounts = perAccount.filter(a => a.status === 'registered');
    // num_accounts_ignored = accounts die NIET actief in bank_accounts staan
    // (dus inactive + unregistered) plus pseudo-accounts/lege IBAN's.
    ignoredCount += perAccount.filter(a => a.status !== 'registered').length;

    // 4. Sommering + peildatum + dominant-IBAN voor backwards-compat.
    //    Alleen registered accounts tellen mee in grand-total.
    const totalCents = registeredAccounts.reduce((a, x) => a + x.balance_cents, 0);
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

    // Debug-mode: ?debug=1 → dump raw DB-data + processing-detail voor
    // diagnose (ronde-5c). Alleen toegankelijk voor rol met
    // finance.bank.balance_view; niet gevoelig want alleen slotsaldos.
    const debugMode = String(req.query?.debug || '') === '1';
    const debugPayload = debugMode ? {
      _debug: {
        bank_accounts: (accts || []).map(a => ({ iban: a.iban, iban_normalized: normalizeIban(a.iban) })),
        filter_on_active: filterOnActive,
        active_ibans_set: Array.from(activeIbansSet),
        camt_statements_raw: stmts.slice(0, 50).map(s => ({
          id: s.id,
          file_name: s.file_name,
          account_iban: s.account_iban,
          account_iban_normalized: normalizeIban(s.account_iban),
          closing_balance_cents: s.closing_balance_cents,
          closing_balance_eur: (Number(s.closing_balance_cents) || 0) / 100,
          statement_to: s.statement_to,
          uploaded_at: s.uploaded_at,
          in_active_set: !s.account_iban ? '(no IBAN)' : (filterOnActive ? activeIbansSet.has(normalizeIban(s.account_iban)) : '(no filter)'),
        })),
        chosen_per_iban: Array.from(byIban.entries()).map(([iban, r]) => ({
          iban,
          statement_id: r.id,
          file_name: r.file_name,
          statement_to: r.statement_to,
          closing_balance_cents: r.closing_balance_cents,
          closing_balance_eur: (Number(r.closing_balance_cents) || 0) / 100,
        })),
        total_cents: totalCents,
        total_eur: totalCents / 100,
      },
    } : {};

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
      ...debugPayload,
    });
  } catch (e) {
    console.error('[finance-bank-camt-balance]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
