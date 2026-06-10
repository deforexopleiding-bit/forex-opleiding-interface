-- ============================================================================
-- Finance Mega-Restructure (10 juni 2026)
-- ============================================================================
-- Schema-uitbreidingen voor de Finance IA-restructure:
--
-- 1. bank_accounts.balance + balance_fetched_at
--    Lazy-cache pattern voor de Dashboard-KPI "Bank-balans" (15min TTL).
--    Pattern is identiek aan invoices.payment_url + payment_url_fetched_at
--    (zie Lesson learned 16 in CLAUDE.md). Voorkomt N+1 TL-calls bij elke
--    dashboard-render.
--
-- 2. (Geen extra tabellen) - Finance Settings, Wanbetalers nested + Dashboard
--    KPIs gebruiken bestaande tabellen (joost_config, whatsapp_meta_templates,
--    invoices, payment_arrangements, pending_actions, etc.).
--
-- Geen RLS-wijzigingen - bestaande policies op bank_accounts blijven actief.
-- ============================================================================

-- 1) bank_accounts: cache-kolommen voor live TL-balans
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS balance numeric(12,2),
  ADD COLUMN IF NOT EXISTS balance_fetched_at timestamptz;

COMMENT ON COLUMN bank_accounts.balance IS
  'Laatst-bekende balans uit TeamLeader (lazy-cache, TTL via env FINANCE_BANK_BALANCE_CACHE_MIN, default 15min).';
COMMENT ON COLUMN bank_accounts.balance_fetched_at IS
  'Timestamp van laatste TL-fetch. Cache-bypass via ?force=true in finance-bank-balance endpoint.';

-- Index voor snel "alle accounts met stale balans"-query (cron-warmup later)
CREATE INDEX IF NOT EXISTS idx_bank_accounts_balance_fetched_at
  ON bank_accounts(balance_fetched_at NULLS FIRST);
