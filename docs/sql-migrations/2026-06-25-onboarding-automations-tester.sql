-- ============================================================================
-- Onboarding-automations Fase 3b — tester foundation (is_test discriminator).
-- Datum: 2026-06-25
-- Branch: feat/onboarding-automations-fase3b-tester
--
-- Mirror van events-tester pattern:
--   event_attendees.is_test          → onboardings.is_test
--   event_automation_runs.is_test    → onboarding_automation_runs.is_test
-- + nieuw: customers.is_test (de events-tester schreef NOOIT in customers
--   omdat attendees losstaan; onboardings hangen aan een customer-rij dus
--   we hebben de marker ook DAAR nodig).
--
-- Default false zodat bestaande rijen NIET als test gelden. Engine gebruikt
-- run.is_test om wait-stappen te versnellen naar TEST_WAIT_MS (15s).
-- onboardings-admin-list.js filtert is_test=true uit de echte lijst.
--
-- Idempotent: IF NOT EXISTS-guard.
-- ============================================================================

BEGIN;

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE public.onboarding_automation_runs
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.onboardings.is_test IS
  'Markeert test-onboardings vanuit de automation-tester. true = niet tonen in '
  'normale admin-lijsten; engine accelereert wait-stappen.';
COMMENT ON COLUMN public.customers.is_test IS
  'Markeert synthetische test-klanten (aangemaakt door automation-tester). '
  'true = uitsluiten van customer-lijsten + sync-pipelines.';
COMMENT ON COLUMN public.onboarding_automation_runs.is_test IS
  'Markeert test-runs. true = engine versnelt wait-stappen naar 15s.';

-- Partial index voor de is_test=true minderheid; helpt cleanup-queries
-- ("toon alle test-rijen") zonder volledige scan.
CREATE INDEX IF NOT EXISTS idx_onboardings_is_test
  ON public.onboardings (is_test)
  WHERE is_test = true;

CREATE INDEX IF NOT EXISTS idx_customers_is_test
  ON public.customers (is_test)
  WHERE is_test = true;

CREATE INDEX IF NOT EXISTS idx_onb_auto_runs_is_test
  ON public.onboarding_automation_runs (is_test)
  WHERE is_test = true;

COMMIT;

-- ROLLBACK:
--   ALTER TABLE public.onboardings                 DROP COLUMN IF EXISTS is_test;
--   ALTER TABLE public.customers                   DROP COLUMN IF EXISTS is_test;
--   ALTER TABLE public.onboarding_automation_runs  DROP COLUMN IF EXISTS is_test;
--   DROP INDEX IF EXISTS public.idx_onboardings_is_test;
--   DROP INDEX IF EXISTS public.idx_customers_is_test;
--   DROP INDEX IF EXISTS public.idx_onb_auto_runs_is_test;
