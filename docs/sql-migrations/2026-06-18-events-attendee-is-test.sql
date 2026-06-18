-- Migration: is_test flag op event_attendees + event_automation_runs.
-- Voor de automation-tester MVP (api/events-automation-test.js).
--
-- NB: de tabelnamen zijn event_attendees + event_automation_runs (enkelvoud
--     event_, meervoud _runs). De automation-tester maakt rijen met
--     is_test=true zodat:
--       1. statistieken/lijsten ze kunnen wegfilteren;
--       2. de engine wait-stappen voor deze runs naar 15s versnelt;
--       3. cleanup-endpoint ze in één keer kan opruimen (FK CASCADE doet de rest).
--
-- Defaults op false → bestaande rijen blijven byte-identiek. Partial index
-- alleen op is_test=true zodat hij minimaal blijft (typisch < 1% van rijen).

BEGIN;

-- 1. event_attendees
ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_event_attendees_is_test
  ON public.event_attendees (is_test)
  WHERE is_test = true;

COMMENT ON COLUMN public.event_attendees.is_test IS
  'true voor synthetische test-rijen aangemaakt via /api/events-automation-test. '
  'Wordt in alle attendee-list/-count endpoints uitgefilterd. Cleanup via '
  '/api/events-test-attendees-cleanup (FK CASCADE pakt audit_log + tags + runs).';

-- 2. event_automation_runs
ALTER TABLE public.event_automation_runs
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_event_automation_runs_is_test
  ON public.event_automation_runs (is_test)
  WHERE is_test = true;

COMMENT ON COLUMN public.event_automation_runs.is_test IS
  'true voor runs die zijn aangemaakt door de automation-tester. Engine '
  'versnelt wait-stappen voor deze runs naar 15s ongeacht waitConfig. '
  'In de Run-historie WEL zichtbaar (gemarkeerd met rode TEST-pill).';

COMMIT;
