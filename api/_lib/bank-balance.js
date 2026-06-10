// api/_lib/bank-balance.js
//
// Core lazy-cache helper voor bank-account balans (Groep E van de Finance
// mega-restructure). Pattern: zelfde als api/_lib/invoice-payment-link.js:
//   - persisteer waarde + fetched_at op de row zelf
//   - TTL via env-var (FINANCE_BANK_BALANCE_CACHE_MIN, default 15min)
//   - typed Error.code voor HTTP-mapping in dunne endpoints
//   - force-bypass via { force: true }
//
// Wordt gebruikt door:
//   - api/finance-bank-balance.js (huidige e-Boekhouden balance endpoint blijft
//     bestaan voor backward-compat; nieuwe TL-balance per bank_account is een
//     aparte pad).
//   - api/finance-dashboard-counts.js (KPI "bankBalans" som over actieve accounts)
//
// LET OP — bron-keuze (TL vs e-Boekhouden):
//   Het bestaande api/finance-bank-balance.js endpoint hangt op e-Boekhouden
//   (ledger-balance). Dat is een correct keuze voor het oude scherm omdat we
//   daar één enkel ledger-saldo lezen, niet per IBAN. Voor de nieuwe
//   bank_accounts-tabel is de canonical source TL (focus.teamleader.eu
//   GET /financialAccounts.list bevat balans-velden indien beschikbaar in
//   het account-record), met fallback naar `current_balance` van de eerdere
//   GoCardless sync zodat we nooit een 502 returnen op een dashboard-KPI.
//
//   In de praktijk hebben we momenteel GEEN actieve TL financialAccounts
//   sync — daarom is de strategie:
//     1) Hoogste prioriteit: lees `balance` + `balance_fetched_at` van de row.
//     2) Als stale: probeer TL /financialAccounts.info (defensief, accept 404).
//     3) Fallback bij geen TL-resp: lees `current_balance` (legacy GoCardless).
//     4) Bij alles miss: error code BALANCE_UNAVAILABLE.
//
// Error-codes:
//   - INVALID_INPUT       → ontbrekende of niet-uuid accountId
//   - ACCOUNT_NOT_FOUND   → bank_accounts row niet gevonden
//   - TL_DOWN             → TL API faalt (netwerk / 5xx) EN geen fallback aanwezig
//   - BALANCE_UNAVAILABLE → geen balance kolom EN geen current_balance fallback
//   - LOOKUP_FAILED       → Supabase lookup faalde

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

const DEFAULT_CACHE_MIN = 15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BankBalanceError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name    = 'BankBalanceError';
    this.code    = code;
    this.detail  = detail;
  }
}

function getCacheTtlMs() {
  const raw = process.env.FINANCE_BANK_BALANCE_CACHE_MIN;
  const min = parseInt(raw, 10);
  const eff = Number.isFinite(min) && min > 0 ? min : DEFAULT_CACHE_MIN;
  return eff * 60 * 1000;
}

function toNumberOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Defensieve TL probe — TL apiary documenteert balans NIET expliciet op
// financialAccounts.info, dus we accepteren stilte (return null) ipv throw.
//
// TL veldnamen-validatie (juni 2026):
//   - GEEN bestaande callers in deze repo van financialAccounts.info — de
//     enige caller is deze helper. Validatie van responseshape moet
//     daarom defensief blijven (probeer meerdere candidate-velden).
//   - TL apiary publiek toont: data.id, data.iban, data.bic, data.bank,
//     data.summary; balance-velden zijn niet gegarandeerd aanwezig en
//     verschillen mogelijk per locale.
//   - Strategie: pak het eerste valide numerieke veld uit een ordered
//     prioriteit (specifiekste eerst); val anders terug op
//     legacy_current_balance van de bank_accounts row.
//   - Bij regressie of TL-shape-wijziging: log het hele response object
//     één keer in productie (DEBUG-flag), niet hier in de happy-path
//     om logs niet vol te zetten.
//
// TODO: zodra TL daadwerkelijk een actief financialAccounts sync heeft
//       (zie roadmap E2), kunnen we dit harderen door de exacte veldnaam
//       te kiezen uit een gebruiks-statistiek.
async function tlFetchBalance(tlAccountId) {
  if (!tlAccountId) return { balance: null, http: null, error: 'no_tl_id' };
  try {
    const r = await tlFetch('/financialAccounts.info', {
      method: 'POST',
      body: JSON.stringify({ id: tlAccountId }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { balance: null, http: r.status, error: txt.slice(0, 200) };
    }
    const json = await r.json().catch(() => null);
    const data = json && json.data ? json.data : null;
    if (!data) return { balance: null, http: r.status, error: 'empty_data' };
    // Defensief: meerdere candidate-velden afgrazen (ordered, specifiekste eerst).
    const candidates = [
      data?.current_balance?.amount,    // genest object met amount/currency
      data?.balance?.amount,            // alternatief genest object
      data.current_balance,             // top-level numeric
      data.balance,                     // top-level numeric
      data?.summary?.balance?.amount,   // genest in summary
      data?.summary?.balance,           // summary numeric
    ];
    for (const c of candidates) {
      const n = toNumberOrNull(c);
      if (n != null) return { balance: n, http: r.status };
    }
    return { balance: null, http: r.status, error: 'no_balance_field' };
  } catch (e) {
    console.error('[bank-balance] tlFetch exception:', e?.message);
    return { balance: null, http: null, error: e?.message || 'exception' };
  }
}

/**
 * Resolve actueel saldo voor een bank-account met lazy cache.
 *
 * @param {string} accountId   bank_accounts.id (uuid).
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  bypass cache.
 * @returns {Promise<{ balance: number|null, fetchedAt: string|null, fromCache: boolean,
 *                    source: 'cache'|'tl'|'legacy_current_balance', persisted: boolean }>}
 * @throws {BankBalanceError}
 */
export async function ensureBankBalance(accountId, opts = {}) {
  const { force = false } = opts || {};

  if (!accountId || typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
    throw new BankBalanceError('INVALID_INPUT', 'accountId (uuid) vereist');
  }

  // Lookup row.
  let row;
  try {
    // tl_account_id is een speculatief veld — bestaat nog niet in alle migraties.
    // We selecteren defensief alle balance-relateerde velden en pakken wat er is.
    const { data, error } = await supabaseAdmin
      .from('bank_accounts')
      .select('id, balance, balance_fetched_at, current_balance, iban, is_active, gocardless_account_id')
      .eq('id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[bank-balance] lookup error:', error.message);
      throw new BankBalanceError('LOOKUP_FAILED', 'Lookup faalde', error.message);
    }
    row = data;
  } catch (e) {
    if (e instanceof BankBalanceError) throw e;
    throw new BankBalanceError('LOOKUP_FAILED', 'Lookup exception', e?.message);
  }
  if (!row) throw new BankBalanceError('ACCOUNT_NOT_FOUND', 'Bank-account niet gevonden');

  // Cache-check.
  const ttlMs = getCacheTtlMs();
  const fetchedAtMs = row.balance_fetched_at ? new Date(row.balance_fetched_at).getTime() : 0;
  const cacheFresh = !force
    && row.balance != null
    && fetchedAtMs
    && (Date.now() - fetchedAtMs) < ttlMs;
  if (cacheFresh) {
    return {
      balance:   Number(row.balance),
      fetchedAt: row.balance_fetched_at,
      fromCache: true,
      source:    'cache',
      persisted: false,
    };
  }

  // Fresh fetch — TL eerst, dan legacy fallback.
  // Op dit moment hebben we GEEN tl_account_id kolom op bank_accounts; we kunnen
  // de TL-call alleen doen als we elders die ID hebben opgeslagen. Skip stil
  // wanneer onbeschikbaar — dit pad blijft toekomst-vaste plek voor de TL-sync.
  const tlAccountId = row.tl_account_id || null;
  const tl = await tlFetchBalance(tlAccountId);

  let chosenBalance = null;
  let chosenSource  = null;

  if (tl.balance != null) {
    chosenBalance = tl.balance;
    chosenSource  = 'tl';
  } else if (row.current_balance != null) {
    chosenBalance = Number(row.current_balance);
    chosenSource  = 'legacy_current_balance';
  } else if (row.balance != null) {
    // Geen verse data, maar we hebben wel een eerder gecachet bedrag — gebruik
    // dat liever dan een hard error, zodat dashboard-KPI's niet flikkeren.
    chosenBalance = Number(row.balance);
    chosenSource  = 'cache';
    return {
      balance:   chosenBalance,
      fetchedAt: row.balance_fetched_at || null,
      fromCache: true,
      source:    'cache',
      persisted: false,
    };
  } else {
    // Niets bruikbaars.
    if (tl.http && tl.http >= 500) {
      throw new BankBalanceError('TL_DOWN', `TL down (HTTP ${tl.http})`, tl.error);
    }
    throw new BankBalanceError('BALANCE_UNAVAILABLE', 'Geen saldo beschikbaar', tl.error || null);
  }

  // Persist (alleen TL of legacy_current_balance promotie).
  let persisted = false;
  const newFetchedAt = new Date().toISOString();
  try {
    const { error: updErr } = await supabaseAdmin
      .from('bank_accounts')
      .update({ balance: chosenBalance, balance_fetched_at: newFetchedAt })
      .eq('id', row.id);
    if (updErr) {
      console.error('[bank-balance] cache update fail:', updErr.message);
    } else {
      persisted = true;
    }
  } catch (e) {
    console.error('[bank-balance] cache update exception:', e?.message);
  }

  return {
    balance:   chosenBalance,
    fetchedAt: persisted ? newFetchedAt : null,
    fromCache: false,
    source:    chosenSource,
    persisted,
  };
}

/**
 * Aggregeer balans over alle actieve bank-accounts. Best-effort:
 * skipt per-account fouten en logt ze, zodat dashboard-KPI altijd een
 * werkbare som teruggeeft.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]
 * @returns {Promise<{ total: number, accountCount: number, oldestFetchedAt: string|null,
 *                    errors: Array<{ accountId: string, code: string }> }>}
 */
export async function aggregateActiveBankBalances(opts = {}) {
  const { force = false } = opts || {};
  const { data: accounts, error } = await supabaseAdmin
    .from('bank_accounts')
    .select('id')
    .eq('is_active', true);
  if (error) {
    console.error('[bank-balance] aggregate lookup error:', error.message);
    return { total: 0, accountCount: 0, oldestFetchedAt: null, errors: [{ accountId: null, code: 'LOOKUP_FAILED' }] };
  }
  const list = Array.isArray(accounts) ? accounts : [];
  const results = [];
  const errors = [];
  for (const acc of list) {
    try {
      const r = await ensureBankBalance(acc.id, { force });
      results.push(r);
    } catch (e) {
      errors.push({ accountId: acc.id, code: e?.code || 'UNKNOWN' });
    }
  }
  const total = results.reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
  const stamps = results.map(r => r.fetchedAt).filter(Boolean);
  const oldest = stamps.length ? stamps.sort()[0] : null;
  return {
    total,
    accountCount: results.length,
    oldestFetchedAt: oldest,
    errors,
  };
}
