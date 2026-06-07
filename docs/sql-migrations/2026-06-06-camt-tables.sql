-- ============================================================================
-- Finance Fase 3 — CAMT.053 bank-import
-- Datum: 2026-06-06
-- Branch: feat/finance-3-camt-bank-import
--
-- Twee tabellen voor ISO 20022 CAMT.053 bank-statements + transacties.
-- Vervangt de e-Boekhouden bank-spiegel (die blijft staan voor backward
-- compat; UI biedt beide tabs naast elkaar tijdens overgang).
--
-- Idempotent (CREATE IF NOT EXISTS + unique-index voor dedupe).
-- ============================================================================

BEGIN;

-- Een CAMT-bestand = één statement-periode per IBAN.
CREATE TABLE IF NOT EXISTS public.camt_statements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name                text NOT NULL,
  account_iban             text NOT NULL,
  opening_balance_cents    bigint,
  closing_balance_cents    bigint,
  statement_from           date,
  statement_to             date,
  num_entries              int NOT NULL DEFAULT 0,
  uploaded_at              timestamptz NOT NULL DEFAULT now(),
  uploaded_by_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Eén transactie per bank-entry. entry_reference (AcctSvcrRef in CAMT) is
-- bank-unique en dient als dedupe-anchor bij re-upload van overlappende
-- periodes.
CREATE TABLE IF NOT EXISTS public.camt_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id        uuid NOT NULL REFERENCES public.camt_statements(id) ON DELETE CASCADE,
  account_iban        text NOT NULL,
  booking_date        date NOT NULL,
  value_date          date,
  amount_cents        bigint NOT NULL,                     -- signed: + = credit (in), - = debit (uit)
  currency            text NOT NULL DEFAULT 'EUR',
  description         text,
  counterparty_name   text,
  counterparty_iban   text,
  end_to_end_id       text,                                -- vaak factuurnummer/ref
  transaction_code    text,                                -- bank-specifieke type-code
  entry_reference     text,                                -- AcctSvcrRef — dedupe-anchor
  raw_xml             text,                                -- debug + audit
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Dedupe via partial unique index (entry_reference kan NULL zijn als bank het
-- niet vult; in dat geval geen dedupe-bescherming — caller weet dat re-upload
-- van zo'n statement duplicates kan geven).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_camt_tx_entry_ref
  ON public.camt_transactions (entry_reference)
  WHERE entry_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_camt_tx_booking_date_desc
  ON public.camt_transactions (booking_date DESC);
CREATE INDEX IF NOT EXISTS idx_camt_tx_account
  ON public.camt_transactions (account_iban);
CREATE INDEX IF NOT EXISTS idx_camt_tx_end_to_end
  ON public.camt_transactions (end_to_end_id)
  WHERE end_to_end_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_camt_tx_statement
  ON public.camt_transactions (statement_id);

-- RLS: authenticated-read (consistent met finance-fase-1 pattern), writes
-- alleen via service-role (upload-endpoint draait met supabaseAdmin).
ALTER TABLE public.camt_statements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camt_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS camt_statements_select   ON public.camt_statements;
DROP POLICY IF EXISTS camt_statements_insert   ON public.camt_statements;
DROP POLICY IF EXISTS camt_statements_update   ON public.camt_statements;
DROP POLICY IF EXISTS camt_statements_delete   ON public.camt_statements;
DROP POLICY IF EXISTS camt_transactions_select ON public.camt_transactions;
DROP POLICY IF EXISTS camt_transactions_insert ON public.camt_transactions;
DROP POLICY IF EXISTS camt_transactions_update ON public.camt_transactions;
DROP POLICY IF EXISTS camt_transactions_delete ON public.camt_transactions;

CREATE POLICY camt_statements_select   ON public.camt_statements   FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY camt_statements_insert   ON public.camt_statements   FOR INSERT WITH CHECK (false);
CREATE POLICY camt_statements_update   ON public.camt_statements   FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY camt_statements_delete   ON public.camt_statements   FOR DELETE USING (false);
CREATE POLICY camt_transactions_select ON public.camt_transactions FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY camt_transactions_insert ON public.camt_transactions FOR INSERT WITH CHECK (false);
CREATE POLICY camt_transactions_update ON public.camt_transactions FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY camt_transactions_delete ON public.camt_transactions FOR DELETE USING (false);

COMMIT;

-- ============================================================================
-- Verificatie (read-only):
--   SELECT count(*) FROM camt_statements;             -- 0 direct na migratie
--   SELECT count(*) FROM camt_transactions;           -- 0
--   SELECT * FROM pg_policies WHERE tablename LIKE 'camt_%';   -- 8 policies
-- ============================================================================
