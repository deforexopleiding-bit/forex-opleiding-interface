-- =============================================================================
-- 2026-07-06 — Handmatige trajecten: vrijval-dag per traject
--
-- Voegt release_day (1..31) toe aan mentor_cash_trajects. De dagelijkse
-- cron (nieuwe schedule: 0 6 * * *) geeft per traject max 1 termijn vrij
-- zodra de vrijval-datum bereikt is:
--   releaseDate = start_month + (N-1) maanden, dag = min(release_day,
--                                                       laatste dag van die maand)
--
-- Randgeval: release_day 31 in feb → 28/29 feb. Default 1 zodat bestaande
-- rijen geldig blijven en (bij deze migratie) meteen vrijval-datum = 1e vd maand.
-- =============================================================================

BEGIN;

ALTER TABLE public.mentor_cash_trajects
  ADD COLUMN IF NOT EXISTS release_day int NOT NULL DEFAULT 1;

ALTER TABLE public.mentor_cash_trajects
  DROP CONSTRAINT IF EXISTS mentor_cash_trajects_release_day_check;
ALTER TABLE public.mentor_cash_trajects
  ADD CONSTRAINT mentor_cash_trajects_release_day_check
  CHECK (release_day BETWEEN 1 AND 31);

COMMENT ON COLUMN public.mentor_cash_trajects.release_day IS
  'Dag van de maand (1-31) waarop een termijn-bonus vrijvalt. release_day 31 in kortere maanden wordt geclamped naar de laatste dag van die maand.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK
-- ALTER TABLE public.mentor_cash_trajects DROP CONSTRAINT IF EXISTS mentor_cash_trajects_release_day_check;
-- ALTER TABLE public.mentor_cash_trajects DROP COLUMN IF EXISTS release_day;
