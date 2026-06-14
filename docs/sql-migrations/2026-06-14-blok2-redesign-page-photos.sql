-- =============================================================================
-- Events Blok 2 redesign - PR 1: page-paginatie + event-foto's
-- Datum: 2026-06-14  | Branch: feat/blok2-redesign-page-photos
-- Doel: datafundament voor de multi-step assessment-redesign.
--   1. assessment_questions.page             -> 1-based stap-/paginanummer
--      Backfill: bestaande secties worden in volgorde stappen (page 1..N).
--   2. events.image_url                       -> per-event foto (optie B)
--   3. event_niveau_options.default_image_url -> niveau-fallback foto
-- Idempotent (IF NOT EXISTS + deterministische, herhaalbare backfill).
-- RLS: geen nieuwe policies (kolommen erven tabel-RLS).
-- =============================================================================
BEGIN;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS page integer NOT NULL DEFAULT 1;
ALTER TABLE public.assessment_questions
  DROP CONSTRAINT IF EXISTS assessment_questions_page_positive;
ALTER TABLE public.assessment_questions
  ADD CONSTRAINT assessment_questions_page_positive CHECK (page >= 1);

WITH sec AS (
  SELECT section, MIN(order_index) AS sec_min
  FROM public.assessment_questions
  GROUP BY section
), ranked AS (
  SELECT section, DENSE_RANK() OVER (ORDER BY sec_min ASC, section ASC) AS pg
  FROM sec
)
UPDATE public.assessment_questions q
SET page = r.pg
FROM ranked r
WHERE q.section = r.section;

CREATE INDEX IF NOT EXISTS idx_assessment_questions_active_page_order
  ON public.assessment_questions (active, page, order_index);

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS image_url text;

ALTER TABLE public.event_niveau_options
  ADD COLUMN IF NOT EXISTS default_image_url text;

COMMIT;
