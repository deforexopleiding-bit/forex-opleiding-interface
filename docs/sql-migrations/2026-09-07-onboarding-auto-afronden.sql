-- 2026-09-07 — onboarding automatisch afronden op de eerste afgeronde sessie
-- DRAAIEN OP: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- DE REGEL (Maxim, 7 september 2026): de VROEGSTE AFGERONDE sessie van een
-- student in het LMS sluit diens onboarding automatisch af. Geen soort-
-- onderscheid: geen kennismakingsgesprek, geen Alpha/Delta — elke
-- coachingsessie telt.
--
-- Was de eerste sessie een no-show, dan sluit er niets; dan komt er een
-- signaal met een EIGEN type, want daar moet iemand kort op zitten om te
-- voorkomen dat het een wanbetaler wordt.
--
-- ⚠ BLOKKEREND. api/cron/onboarding-eerste-sessie-afronden.js noemt de drie
-- nieuwe kolommen bij naam in zijn UPDATE. Draait deze migratie niet, dan
-- faalt elke afsluitpoging met een column-error. Draai 'm vóór of direct na
-- de merge.

BEGIN;

-- 1) WAAROM een onboarding is afgerond, niet alleen DAT hij afgerond is.
--    Een 'afgerond' zonder aanwijsbare oorzaak is precies het schermsoort
--    dat dit project al twee keer een halve dag heeft gekost.
ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS auto_afgerond_sessie_id text,
  ADD COLUMN IF NOT EXISTS auto_afgerond_sessie_op timestamptz,
  ADD COLUMN IF NOT EXISTS auto_afgerond_op        timestamptz;

COMMENT ON COLUMN public.onboardings.auto_afgerond_sessie_id IS
  'hlms_sessie.id (dfo-lms) die deze onboarding automatisch afsloot. Geen FK: andere databank. Gevuld = nooit meer automatisch afsluiten, ook niet na handmatig heropenen.';
COMMENT ON COLUMN public.onboardings.auto_afgerond_sessie_op IS
  'start_tijd van die sessie.';
COMMENT ON COLUMN public.onboardings.auto_afgerond_op IS
  'Moment waarop de cron de onboarding afsloot.';

-- 2) Eigen signaaltype voor een gemiste EERSTE call. Spiegel van migratie 018.
--    Bewust GEEN tweede signaal naast het gewone: er staat een unique index
--    op student_signals.session_id, en twee meldingen voor één gebeurtenis
--    laten de mentor ook twee keer rinkelen. Eén signaal, ander type.
ALTER TABLE public.student_signals
  DROP CONSTRAINT IF EXISTS student_signals_type_check;

ALTER TABLE public.student_signals
  ADD CONSTRAINT student_signals_type_check CHECK (type IN (
    'eerste_call', 'reageert_niet', 'niet_bereikbaar',
    'geen_reactie_bellen', 'anders', 'no_show', 'eerste_call_no_show'));

COMMIT;

-- Controle:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'onboardings' AND column_name LIKE 'auto_afgerond%';
--
-- Rollback (handmatig, defensief):
--   ALTER TABLE public.onboardings
--     DROP COLUMN IF EXISTS auto_afgerond_sessie_id,
--     DROP COLUMN IF EXISTS auto_afgerond_sessie_op,
--     DROP COLUMN IF EXISTS auto_afgerond_op;
--   ALTER TABLE public.student_signals DROP CONSTRAINT IF EXISTS student_signals_type_check;
--   ALTER TABLE public.student_signals ADD CONSTRAINT student_signals_type_check CHECK (type IN (
--     'eerste_call','reageert_niet','niet_bereikbaar','geen_reactie_bellen','anders','no_show'));
