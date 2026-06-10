// api/finance-bank-balance.js
// GET → actueel saldo van de bank-rekening.
// Permission: finance.bank.balance_view.
//
// Twee bronnen, selecteerbaar via ?source=...:
//   1) source=eboekhouden (DEFAULT, backward-compat) — live-call naar
//      /v1/ledger/{id}/balance van e-Boekhouden (Mantix Client.php
//      getLedgerBalance). Optionele correctie via EBH_BALANCE_OFFSET.
//   2) source=bank_accounts (NEW, opt-in via query of env-default
//      FINANCE_BANK_BALANCE_SOURCE=bank_accounts) — aggregate over actieve
//      bank_accounts via api/_lib/bank-balance.js (TL + legacy fallback,
//      15min lazy cache). Optioneel account=<uuid> voor een enkel account.
//
// Response shape (zelfde voor beide paden, voor backward-compat):
//   { balance_cents, eb_balance_cents?, offset_cents, as_of_date, source,
//     ledger_id?, account_count?, balance_fetched_at? }
//
// Bij fout: 502 met provider-response echo. Geen DB-fallback in
// e-Boekhouden-pad want saldo is inherent realtime. bank_accounts-pad
// gebruikt zijn eigen cache + persist-strategie via helper.

import { createUserClient } from './supabase.js';
import { ebFetch } from './_lib/eboekhouden-token.js';
import { requirePermission } from './_lib/requirePermission.js';
import { ensureBankBalance, aggregateActiveBankBalances, BankBalanceError } from './_lib/bank-balance.js';

const DEFAULT_BANK_LEDGER = 1010;
const VALID_SOURCES = ['eboekhouden', 'bank_accounts'];

function resolveSource(req) {
  const q = String(req.query?.source || '').trim().toLowerCase();
  if (VALID_SOURCES.includes(q)) return q;
  const env = String(process.env.FINANCE_BANK_BALANCE_SOURCE || '').trim().toLowerCase();
  if (VALID_SOURCES.includes(env)) return env;
  return 'eboekhouden';
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

  const source = resolveSource(req);
  const force  = String(req.query?.force || '').toLowerCase() === 'true';

  // ── Pad 2: bank_accounts (TL + legacy fallback, via _lib helper) ───────────
  if (source === 'bank_accounts') {
    const accountId = req.query?.account ? String(req.query.account) : null;
    try {
      if (accountId) {
        // Enkel account.
        const r = await ensureBankBalance(accountId, { force });
        const balCents = Math.round((Number(r.balance) || 0) * 100);
        return res.status(200).json({
          balance_cents:      balCents,
          offset_cents:       0,
          as_of_date:         (r.fetchedAt ? String(r.fetchedAt).slice(0, 10) : new Date().toISOString().slice(0, 10)),
          source:             'bank_accounts',
          account_count:      1,
          balance_fetched_at: r.fetchedAt,
          balance_source:     r.source,
          from_cache:         r.fromCache,
        });
      }
      // Aggregate over actieve accounts.
      const agg = await aggregateActiveBankBalances({ force });
      const balCents = Math.round((Number(agg.total) || 0) * 100);
      return res.status(200).json({
        balance_cents:      balCents,
        offset_cents:       0,
        as_of_date:         (agg.oldestFetchedAt ? String(agg.oldestFetchedAt).slice(0, 10) : new Date().toISOString().slice(0, 10)),
        source:             'bank_accounts',
        account_count:      agg.accountCount,
        balance_fetched_at: agg.oldestFetchedAt,
        errors:             agg.errors,
      });
    } catch (e) {
      if (e instanceof BankBalanceError) {
        const httpStatus = e.code === 'ACCOUNT_NOT_FOUND' ? 404
                         : e.code === 'INVALID_INPUT'     ? 400
                         : e.code === 'TL_DOWN'           ? 502
                         : 500;
        return res.status(httpStatus).json({ error: e.message, code: e.code, detail: e.detail });
      }
      console.error('[finance-bank-balance] bank_accounts exception:', e?.message);
      return res.status(500).json({ error: e?.message || 'Onbekende fout' });
    }
  }

  // ── Pad 1: e-Boekhouden (DEFAULT, backward-compat) ─────────────────────────
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
    const ebBalanceCents = Math.round(rawNum * 100);

    // Optionele correctie via env-var (integer cents). Default 0 = geen correctie.
    const offsetCents = Number.parseInt(process.env.EBH_BALANCE_OFFSET || '0', 10) || 0;
    const balanceCents = ebBalanceCents - offsetCents;

    const asOfDate = data.asOfDate || data.date || new Date().toISOString().slice(0, 10);

    return res.status(200).json({
      balance_cents:    balanceCents,
      eb_balance_cents: ebBalanceCents,
      offset_cents:     offsetCents,
      as_of_date:       asOfDate,
      source:           'eboekhouden',
      ledger_id:        ledgerId,
    });
  } catch (e) {
    console.error('[finance-bank-balance]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
