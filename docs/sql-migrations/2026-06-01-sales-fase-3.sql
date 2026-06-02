-- ============================================================================
-- Sales Fase 3: onboarding + mentor + 1e call op klant
-- Datum: 2026-06-01
-- Branch: feature/sales-fase-3
-- ============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS onboarding_status        text NOT NULL DEFAULT 'not_sent'
    CHECK (onboarding_status IN ('not_sent','sent','completed')),
  ADD COLUMN IF NOT EXISTS onboarding_sent_at       timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_token         text UNIQUE,
  ADD COLUMN IF NOT EXISTS mentor_user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_call_at            timestamptz;

CREATE INDEX IF NOT EXISTS idx_customers_onboarding_status ON public.customers (onboarding_status);

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.customers
--     DROP COLUMN IF EXISTS first_call_at,
--     DROP COLUMN IF EXISTS mentor_user_id,
--     DROP COLUMN IF EXISTS onboarding_token,
--     DROP COLUMN IF EXISTS onboarding_completed_at,
--     DROP COLUMN IF EXISTS onboarding_sent_at,
--     DROP COLUMN IF EXISTS onboarding_status;
-- COMMIT;
