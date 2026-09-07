-- 2026-09-05 — dfo-lms onboarding-koppeling, CRM-KANT
-- DRAAIEN OP: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- Fase 1: bij het starten van een onboarding wordt een studentrij aangemaakt
-- in het NIEUWE LMS (dfo-lms, tabel hlms_student). Deze kolommen houden die
-- koppeling bij, in hetzelfde patroon als bubble_provisioned /
-- bubble_provisioned_at / bubble_provision_error.
--
-- NAAMGEVING — LEES DIT VOOR JE IETS HERNOEMT.
-- Er bestaat al een kolom onboardings.lms_provision. Die hoort NIET bij dit
-- werk: dat is de trial-site voor leads (7-daagse / mini-cursus), met de
-- lms_gebruikers / lms_toegang / lms_producten-tabellen in DIT project en een
-- koppeling naar dfo-website. Zie api/_lib/lms-provisioning.js.
-- Alles wat bij het nieuwe LMS hoort krijgt daarom de prefix dfo_lms_.
--
-- Status per 2026-09-05: gedraaid ("Success. No rows returned").

ALTER TABLE public.onboardings ADD COLUMN IF NOT EXISTS dfo_lms_student_id uuid;
ALTER TABLE public.onboardings ADD COLUMN IF NOT EXISTS dfo_lms_provisioned boolean NOT NULL DEFAULT false;
ALTER TABLE public.onboardings ADD COLUMN IF NOT EXISTS dfo_lms_provisioned_at timestamptz;
ALTER TABLE public.onboardings ADD COLUMN IF NOT EXISTS dfo_lms_provision_error text;

COMMENT ON COLUMN public.onboardings.dfo_lms_student_id IS
  'hlms_student.id in het dfo-lms-project (absicpdidnoblirngiia). Geen FK: andere databank.';
COMMENT ON COLUMN public.onboardings.dfo_lms_provisioned IS
  'true zodra de studentrij in dfo-lms bestaat en gekoppeld is. Niets te maken met lms_provision (trial-site).';
COMMENT ON COLUMN public.onboardings.dfo_lms_provision_error IS
  'Laatste foutmelding van de dfo-lms-koppeling. NULL bij succes. Bevat nooit wachtwoorden of sleutels.';

-- Controle:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'onboardings' AND column_name LIKE 'dfo_lms%';
--
-- Terugdraaien (alleen als de koppeling helemaal van tafel gaat):
--   ALTER TABLE public.onboardings
--     DROP COLUMN IF EXISTS dfo_lms_student_id,
--     DROP COLUMN IF EXISTS dfo_lms_provisioned,
--     DROP COLUMN IF EXISTS dfo_lms_provisioned_at,
--     DROP COLUMN IF EXISTS dfo_lms_provision_error;
