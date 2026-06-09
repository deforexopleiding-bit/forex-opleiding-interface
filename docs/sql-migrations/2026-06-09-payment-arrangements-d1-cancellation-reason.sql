-- 2026-06-09-payment-arrangements-d1-cancellation-reason.sql
-- Voegt payment_arrangements.cancellation_reason kolom toe (D1 blocker G).
--
-- Achtergrond:
-- arrangements-cancel.js schreef oorspronkelijk naar payment_arrangements.reject_reason,
-- maar die kolom bestaat niet op de deployed tabel — alleen pending_actions.rejection_reason
-- bestaat. Een arrangement-annulering is semantisch geen approval-reject (die zit op
-- pending_actions), maar een handmatige cancel van een lifecycle-rij. Daarom een eigen
-- kolom met spec-conforme naam: cancellation_reason.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Geen index nodig (kolom is alleen weergave).

BEGIN;

ALTER TABLE public.payment_arrangements
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

COMMENT ON COLUMN public.payment_arrangements.cancellation_reason IS
  'Handmatige reden waarom de afspraak is geannuleerd. Apart van pending_actions.rejection_reason (per-actie afwijzing in de approval-flow).';

COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window gebruiken)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.payment_arrangements DROP COLUMN IF EXISTS cancellation_reason;
-- COMMIT;
