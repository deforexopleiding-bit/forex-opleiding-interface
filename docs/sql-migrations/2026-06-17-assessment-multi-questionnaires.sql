-- Migratie: assessment_questionnaires + per-vragenlijst drempels (FEATURE C)
-- Datum: 17 juni 2026
--
-- Doel:
--   Meerdere benoemde vragenlijsten ondersteunen met exact één 'actief'. De
--   bestaande vragen in assessment_questions worden in een 'default'-rij
--   verpakt + actief gemarkeerd → publieke flow blijft byte-identiek werken.
--
--   Drempels (gevorderd_threshold / motivatie_floor / low_mid_threshold) zijn
--   per-vragenlijst zodat verschillende quizzes andere routing kunnen hebben
--   zonder een env-var-rebuild. assessment-scoring.js valt terug op env-vars
--   en defaults als geen vragenlijst meegegeven wordt (backward-compat).
--
-- Status van deze migratie:
--   Stap 1 — alleen SCHEMA + RLS (deze SQL).
--   Stap 2 — codewijzigingen (PR-Cbackend): nieuwe endpoints +
--           assessment-questions / -submit / scoring.js aanpassingen.
--   Stap 3 — frontend (PR-Cfrontend): sub-tab Vragen + Puntensysteem in
--           Instellingen → Vragenlijst.
--
-- VOORWAARDEN:
-- - ADMIN_ROLES helper has_any_role(text[]) bestaat (zelfde pattern als
--   event_followups).
-- - assessment_questions + assessment_responses bestaan (Blok 2 PR 1).
-- - public.set_updated_at() trigger-functie bestaat.
--
-- IDEMPOTENT: DROP+CREATE voor triggers/policies; IF NOT EXISTS voor
-- tabellen/kolommen/indexen.

BEGIN;

-- =============================================================================
-- 1. assessment_questionnaires
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.assessment_questionnaires (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     text NOT NULL UNIQUE,
  name                     text NOT NULL,
  is_active                boolean NOT NULL DEFAULT false,
  -- Drempels (Voorstel 2 — per-vragenlijst):
  gevorderd_threshold      integer NOT NULL DEFAULT 7,
  motivatie_floor          integer NOT NULL DEFAULT 5,
  low_mid_threshold        integer NOT NULL DEFAULT 4,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.assessment_questionnaires IS
  'Benoemde vragenlijsten. Exact één rij heeft is_active=true (partial unique index). Publieke flow serveert de actieve vragen-set.';
COMMENT ON COLUMN public.assessment_questionnaires.gevorderd_threshold IS
  'Skill-score drempel voor routing_result=gevorderd. Default 7. Fallback in scoring-lib op env ASSESSMENT_GEVORDERD_THRESHOLD.';
COMMENT ON COLUMN public.assessment_questionnaires.motivatie_floor IS
  'Minimum motivatie-score (1-10). Onder de floor capt de routing naar basis. Default 5.';
COMMENT ON COLUMN public.assessment_questionnaires.low_mid_threshold IS
  'Skill-score grens basis-low ↔ basis-mid copy-tier. Default 4.';

-- Partial unique index — exact 1 actieve vragenlijst
CREATE UNIQUE INDEX IF NOT EXISTS assessment_questionnaires_one_active
  ON public.assessment_questionnaires (is_active) WHERE is_active = true;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_assessment_questionnaires_updated_at
  ON public.assessment_questionnaires;
CREATE TRIGGER trg_assessment_questionnaires_updated_at
  BEFORE UPDATE ON public.assessment_questionnaires
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 2. Default-rij die bestaande vragen wikkelt + meteen actief markeert
-- =============================================================================

INSERT INTO public.assessment_questionnaires (slug, name, is_active)
VALUES ('default', 'Standaard vragenlijst', true)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- 3. FK + backfill op assessment_questions
-- =============================================================================

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS questionnaire_id uuid
    REFERENCES public.assessment_questionnaires(id) ON DELETE CASCADE;

-- Backfill: alle bestaande vragen → default-vragenlijst.
UPDATE public.assessment_questions
SET questionnaire_id = (
  SELECT id FROM public.assessment_questionnaires WHERE slug = 'default' LIMIT 1
)
WHERE questionnaire_id IS NULL;

-- NOT NULL afdwingen (pas NA backfill).
ALTER TABLE public.assessment_questions
  ALTER COLUMN questionnaire_id SET NOT NULL;

-- Index voor "actieve vragen per vragenlijst"
CREATE INDEX IF NOT EXISTS idx_assessment_questions_questionnaire_active_order
  ON public.assessment_questions (questionnaire_id, active, order_index);

-- =============================================================================
-- 4. FK + backfill op assessment_responses
--    Bewaart welke vragenlijst gold op het moment van submit zodat een
--    latere wijziging van de actieve vragenlijst de historische response
--    niet "naar de verkeerde scoring laat verwijzen".
-- =============================================================================

ALTER TABLE public.assessment_responses
  ADD COLUMN IF NOT EXISTS questionnaire_id uuid
    REFERENCES public.assessment_questionnaires(id) ON DELETE SET NULL;

UPDATE public.assessment_responses
SET questionnaire_id = (
  SELECT id FROM public.assessment_questionnaires WHERE slug = 'default' LIMIT 1
)
WHERE questionnaire_id IS NULL;

-- BEWUST GEEN NOT NULL — als de vragenlijst later verwijderd wordt blijft
-- de response leesbaar (SET NULL via FK). Backfill dekt historie wel.

CREATE INDEX IF NOT EXISTS idx_assessment_responses_questionnaire
  ON public.assessment_responses (questionnaire_id);

-- =============================================================================
-- 5. RLS — pattern uit event_followups / event_attendee_comms_log
-- =============================================================================

ALTER TABLE public.assessment_questionnaires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ADMIN_ROLES all (ALL)"
  ON public.assessment_questionnaires;
CREATE POLICY "ADMIN_ROLES all (ALL)"
  ON public.assessment_questionnaires
  FOR ALL TO authenticated
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- Note: publieke flow leest via supabaseAdmin (server-role, RLS bypass) —
-- geen public SELECT policy nodig. assessment-questions sanitized weergave
-- via api/assessment-questions.js blijft het enige publieke pad.

COMMIT;
