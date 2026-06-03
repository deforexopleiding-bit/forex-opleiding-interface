-- ============================================================================
-- TL-import tracking (Issue 3 voorbereiding)
-- Datum: 2026-06-03 · Branch: feature/tl-integration
--
-- Timestamp om te traceren wanneer een klant/abonnement uit Teamleader is
-- geïmporteerd (bulk-import endpoint volgt). Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS imported_from_tl_at timestamptz;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS imported_from_tl_at timestamptz;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS imported_from_tl_at;
--   ALTER TABLE public.customers DROP COLUMN IF EXISTS imported_from_tl_at;
-- COMMIT;
