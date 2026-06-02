-- ============================================================================
-- Subscription uitstellen (postpone) + audit-baseline
-- Datum: 2026-06-02
-- Branch: feature/subscriptions-big-upgrade
--
-- Houdt het origineel + cumulatieve uitstel bij zodat een uitgesteld
-- abonnement auditeerbaar blijft (hoeveel maanden, vanaf welke baseline).
-- original_* worden 1x gezet bij de eerste keer uitstellen (snapshot).
-- ============================================================================

BEGIN;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS postponed_months    smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_start_date date,
  ADD COLUMN IF NOT EXISTS original_end_date   date;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.subscriptions
--     DROP COLUMN IF EXISTS original_end_date,
--     DROP COLUMN IF EXISTS original_start_date,
--     DROP COLUMN IF EXISTS postponed_months;
-- COMMIT;
