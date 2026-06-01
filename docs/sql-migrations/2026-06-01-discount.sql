-- ============================================================================
-- Korting op deal-niveau (percentage over subtotaal excl. BTW)
-- Datum: 2026-06-01
-- Branch: feature/korting-en-architectuur
-- ============================================================================

BEGIN;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS discount_percentage numeric(5,2) NOT NULL DEFAULT 0
    CHECK (discount_percentage >= 0 AND discount_percentage <= 100);

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deals DROP COLUMN IF EXISTS discount_percentage;
-- COMMIT;
