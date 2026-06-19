-- Migration: assessment_questions.type — voeg 'tel' toe aan de CHECK-constraint.
--
-- assessment_questions had: CHECK (type IN ('text','email','radio','scale_1_5','scale_1_10','open_text'))
-- We voegen 'tel' toe zodat admins een telefoonnummer-vraag kunnen configureren.
-- Strategie: drop named check-constraint + recreate met uitgebreide enum-set.

BEGIN;

ALTER TABLE public.assessment_questions
  DROP CONSTRAINT IF EXISTS assessment_questions_type_check;

ALTER TABLE public.assessment_questions
  ADD CONSTRAINT assessment_questions_type_check
  CHECK (type IN ('text','email','tel','radio','scale_1_5','scale_1_10','open_text'));

COMMIT;
