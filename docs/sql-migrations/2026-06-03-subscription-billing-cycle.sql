-- ============================================================================
-- subscriptions.billing_cycle (TL-import: bewaar factuurfrequentie)
-- Datum: 2026-06-03 · Branch: feature/tl-integration
--
-- Tekstuele factuurcyclus uit TL (per_month / per_quarter / per_6_months /
-- per_year / per_2_months / per_N_months). Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle text;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS billing_cycle;
-- COMMIT;
