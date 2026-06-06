-- ============================================================================
-- Finance Fase 3 — Bank-transactions table + sync_state-rij
-- Datum: 2026-06-06
-- Branch: feat/finance-3-bank-overview
--
-- Read-only spiegel van e-Boekhouden mutaties (type 4 + 5, gefilterd op
-- bank-grootboek). Hourly cron-poll vult deze tabel. v1: GEEN match-engine,
-- GEEN auto-TL-cascade — pure bankoverzicht.
--
-- Idempotent (CREATE IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eb_mutation_id      bigint UNIQUE NOT NULL,             -- e-Boekhouden mutation ID
  ledger_id           integer NOT NULL,                   -- e-Boekhouden grootboek (1010 = ING)
  mutation_type       smallint NOT NULL,                  -- 3|4|5|6 (we syncen 4+5 in v1)
  transaction_date    date NOT NULL,
  amount_cents        bigint NOT NULL,                    -- signed: positief = in, negatief = uit
  currency            text NOT NULL DEFAULT 'EUR',
  description         text,
  counterparty_name   text,                               -- verifiëren of REST veld returnt
  counterparty_iban   text,                               -- idem
  invoice_number      text,                               -- gevuld als e-Boekhouden zelf koppelde
  raw_payload         jsonb,                              -- volledige TL-response voor debug/audit
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Indexes voor UI-query's (date-desc sort, per-ledger filter, per-factuur lookup).
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date_desc
  ON public.bank_transactions (transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_ledger
  ON public.bank_transactions (ledger_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_invoice_number
  ON public.bank_transactions (invoice_number)
  WHERE invoice_number IS NOT NULL;

-- updated_at-trigger (consistent met sync_state + andere finance-tabellen).
CREATE OR REPLACE FUNCTION public.bank_transactions_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_bank_transactions_touch ON public.bank_transactions;
CREATE TRIGGER trg_bank_transactions_touch
  BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.bank_transactions_touch_updated_at();

-- RLS: service-role-only (cron + endpoints draaien via supabaseAdmin).
-- Authenticated-read sluit aan op de bestaande pattern (finance-fase-1) zodat de
-- UI gewoon via apiFetch kan lezen na permission-check op de API-laag.
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_transactions_select ON public.bank_transactions;
CREATE POLICY bank_transactions_select ON public.bank_transactions
  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS bank_transactions_insert ON public.bank_transactions;
CREATE POLICY bank_transactions_insert ON public.bank_transactions
  FOR INSERT WITH CHECK (false);
DROP POLICY IF EXISTS bank_transactions_update ON public.bank_transactions;
CREATE POLICY bank_transactions_update ON public.bank_transactions
  FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS bank_transactions_delete ON public.bank_transactions;
CREATE POLICY bank_transactions_delete ON public.bank_transactions
  FOR DELETE USING (false);

-- sync_state-rij voor de cron-cursor. PK is TEXT, geen schema-wijziging nodig.
-- Seed-cursor 2025-01-01: eerste runs vullen alle historische bank-mutaties.
INSERT INTO public.sync_state (resource, last_updated_since)
VALUES ('bank_transactions', '2025-01-01T00:00:00+00:00')
ON CONFLICT (resource) DO NOTHING;

COMMIT;

-- ============================================================================
-- Verificatie (read-only, na uitvoer):
--   SELECT count(*) FROM bank_transactions;            -- 0 direct na migratie
--   SELECT resource, last_updated_since FROM sync_state
--   WHERE resource = 'bank_transactions';              -- 2025-01-01 cursor
--   SELECT * FROM pg_policies WHERE tablename = 'bank_transactions';  -- 4 policies
-- ============================================================================
