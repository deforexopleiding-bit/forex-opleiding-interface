-- ============================================================================
-- Wizard 2 (subscription invoeren): velden voor subscriptions + deal first_call
-- Datum: 2026-06-01
-- Branch: feature/wizard-2-subscription
-- ============================================================================

BEGIN;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS first_call_at timestamptz;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS description      text,
  ADD COLUMN IF NOT EXISTS end_date         date,
  ADD COLUMN IF NOT EXISTS tl_department_id text;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.subscriptions
--     DROP COLUMN IF EXISTS tl_department_id,
--     DROP COLUMN IF EXISTS end_date,
--     DROP COLUMN IF EXISTS description;
--   -- deals.first_call_at: bestond mogelijk al, niet droppen.
-- COMMIT;
