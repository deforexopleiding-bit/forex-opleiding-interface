-- 2026-09-05 — dfo-lms onboarding-koppeling, LMS-KANT
-- DRAAIEN OP: dfo-lms (absicpdidnoblirngiia)  — NIET op het CRM-project.
--
-- Knoopt de draad aan de tweede kant vast: vanuit een studentrij is nu
-- terug te vinden bij welke CRM-onboarding hij hoort.
--
-- De unieke index is het tweede vangnet voor idempotentie. Samen met de
-- bestaande hlms_student_email_uidx op lower(email) zijn nu BEIDE matchassen
-- op databankniveau afgedwongen: twee gelijktijdige aanmaakpogingen kunnen
-- nooit twee studentrijen opleveren. De verliezer krijgt 23505 en de code
-- behandelt dat als "bestond al" (zie api/_lib/dfo-lms-student.js).
--
-- LET OP voor wie hier later ON CONFLICT op wil gebruiken: een PARTIAL unique
-- index kan in PostgREST/supabase-js GEEN arbiter zijn voor upsert. Daarom
-- hanteert de code bewust zoeken-dan-schrijven met een 23505-vangst.
--
-- Status per 2026-09-05: gedraaid ("Success. No rows returned").

ALTER TABLE public.hlms_student ADD COLUMN IF NOT EXISTS crm_onboarding_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS hlms_student_crm_onboarding_uidx
  ON public.hlms_student (crm_onboarding_id)
  WHERE crm_onboarding_id IS NOT NULL;

COMMENT ON COLUMN public.hlms_student.crm_onboarding_id IS
  'onboardings.id uit het CRM (forex-command-center). Geen FK: andere databank. Uniek waar niet leeg.';

-- Controle:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'hlms_student' AND indexname = 'hlms_student_crm_onboarding_uidx';
