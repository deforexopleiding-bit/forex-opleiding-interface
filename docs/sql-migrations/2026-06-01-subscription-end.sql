-- ============================================================================
-- Einddatum abonnement op klant (kolom voor Klanten-tab; gevuld via Wizard 2)
-- Datum: 2026-06-01
-- Branch: feature/klanten-cleanup-en-type-verkoop
-- ============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS subscription_end_date date;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.customers DROP COLUMN IF EXISTS subscription_end_date;
-- COMMIT;
