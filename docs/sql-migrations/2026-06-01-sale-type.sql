-- ============================================================================
-- Type verkoop (BTW-regeling) op deal-niveau
-- Datum: 2026-06-01
-- Branch: feature/klanten-cleanup-en-type-verkoop
-- ============================================================================

BEGIN;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS sale_type text NOT NULL DEFAULT 'domestic'
    CHECK (sale_type IN ('domestic', 'intracommunautair', 'outside_eu'));

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deals DROP COLUMN IF EXISTS sale_type;
-- COMMIT;
