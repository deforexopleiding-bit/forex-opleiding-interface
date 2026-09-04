-- 2026-09-04 · follow_up_appointments.ghl_calendar_id
--
-- CONTEXT
-- Verbreding van de afspraak-reminders van alleen de opstartsessie-agenda naar
-- ALLE GHL-agenda's. We bewaren per afspraak de GHL-calendar-id, zodat de
-- reminder-cron kan scopen op "afkomstig uit een GHL-agenda-import"
-- (ghl_calendar_id IS NOT NULL) en rijen van andere flows (Lisa/leadsonderhoud)
-- buiten schot blijven.
--
-- Gevuld door: de poll (per-calendar), het one-off import-endpoint, en
-- create-appointment-from-lead (opstartsessie-boeking → GHL_CALENDAR_ID).
--
-- Raakt alleen public.follow_up_appointments (kolom + index). 0 incasso-writes.
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

BEGIN;

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS ghl_calendar_id text;

COMMENT ON COLUMN public.follow_up_appointments.ghl_calendar_id IS
  'GHL-calendar-id waar deze afspraak vandaan komt. NULL = niet uit een GHL-agenda-import (bv. Lisa/leadsonderhoud-flows). De afspraak-reminder-cron scoopt op NOT NULL.';

CREATE INDEX IF NOT EXISTS idx_fu_appointments_ghl_calendar
  ON public.follow_up_appointments (ghl_calendar_id)
  WHERE ghl_calendar_id IS NOT NULL;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='follow_up_appointments'
--      AND column_name='ghl_calendar_id';
--   Verwacht: 1 rij (text).
--
--   -- Na de eerste per-calendar poll/import:
--   SELECT ghl_calendar_id, count(*) FROM public.follow_up_appointments
--    WHERE status='scheduled' AND scheduled_at > now()
--    GROUP BY ghl_calendar_id ORDER BY 2 DESC;
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   DROP INDEX IF EXISTS public.idx_fu_appointments_ghl_calendar;
--   ALTER TABLE public.follow_up_appointments DROP COLUMN IF EXISTS ghl_calendar_id;
-- ============================================================================
