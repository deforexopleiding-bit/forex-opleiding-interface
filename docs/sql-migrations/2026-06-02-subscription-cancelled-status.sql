-- ============================================================================
-- Subscriptions status: voeg 'cancelled' toe aan de CHECK-constraint
-- Datum: 2026-06-02
-- Branch: fix/subscription-cancelled-status
--
-- PROBLEEM (live test): api/sales-subscription-delete.js schrijft
-- status='cancelled', maar de constraint stond alleen active/paused/completed
-- toe → HTTP 500 (subscriptions_status_check violation).
-- FIX: 'cancelled' toevoegen aan de toegestane waarden. Geen code-wijziging.
-- ============================================================================

BEGIN;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status = ANY (ARRAY['active','paused','completed','cancelled']));

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
--   ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check
--     CHECK (status = ANY (ARRAY['active','paused','completed']));
-- COMMIT;
