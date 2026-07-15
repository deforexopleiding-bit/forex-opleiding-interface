-- 2026-07-14-arrangement-workflow-hooks.sql
-- Fase 2b — Betaalafspraken sluiten de cirkel:
--   1) dunning_workflow_runs.paused_by_arrangement_id — link naar de afspraak
--      die de aanmanings-run pauzeerde. Zo weet resume_dunning welke runs bij
--      welk arrangement horen, en kunnen we gericht hervatten/afsluiten.
--   2) payment_arrangements.breach_handled_at — timestamp na de eerste keer
--      dat de engine een workflow gestart heeft voor VERBROKEN van dit
--      arrangement. Voorkomt dat de engine 7 dagen achter elkaar dezelfde
--      workflow start; nieuwe TOEZEGGINGEN krijgen hun eigen breach_handled_at.
--   3) step_type CHECK uitbreiden met 'resume_dunning' — nieuwe workflow-step
--      die de door dit arrangement gepauzeerde runs weer op 'active' zet.
--   4) Seed voorbeeld-workflow "Betaalafspraak verbroken" (is_active=false).
--
-- Idempotent, met pre-flight guards. Bestaande rijen worden NIET aangepast.
-- Zelfde stijl als 2026-07-14-arrangement-toezegging.sql (#756).

BEGIN;

-- ===========================================================================
-- 1. dunning_workflow_runs.paused_by_arrangement_id
-- ===========================================================================
-- FK naar payment_arrangements(id) ON DELETE SET NULL: als een arrangement
-- wordt verwijderd (zeer zeldzaam — normaal cancel/nagekomen), verliest de
-- run alleen de koppeling, maar blijft zelf bestaan.
ALTER TABLE public.dunning_workflow_runs
  ADD COLUMN IF NOT EXISTS paused_by_arrangement_id uuid
    REFERENCES public.payment_arrangements(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.dunning_workflow_runs.paused_by_arrangement_id IS
  'Als NIET NULL: deze run staat op paused omdat de gekoppelde afspraak actief is. Wordt geset door dunning-arrangement-hooks.js zodra een arrangement naar ACTIEF gaat, en gereset (of run afgesloten) zodra de afspraak NAGEKOMEN/GEANNULEERD is of de resume_dunning-step draait.';

CREATE INDEX IF NOT EXISTS idx_dunning_runs_paused_by_arrangement
  ON public.dunning_workflow_runs (paused_by_arrangement_id)
  WHERE paused_by_arrangement_id IS NOT NULL;

-- ===========================================================================
-- 2. payment_arrangements.breach_handled_at
-- ===========================================================================
ALTER TABLE public.payment_arrangements
  ADD COLUMN IF NOT EXISTS breach_handled_at timestamptz;

COMMENT ON COLUMN public.payment_arrangements.breach_handled_at IS
  'Timestamp waarop de dunning-engine een workflow-run heeft gestart voor de VERBROKEN-transitie van dit specifieke arrangement. NULL = nog niet afgehandeld. De engine gebruikt IS NULL als dedup-guard: 1x per arrangement, niet 1x per klant (nieuwe TOEZEGGING krijgt een nieuwe rij en dus opnieuw NULL).';

CREATE INDEX IF NOT EXISTS idx_payment_arrangements_breach_unhandled
  ON public.payment_arrangements (status, breach_handled_at)
  WHERE status = 'VERBROKEN' AND breach_handled_at IS NULL;

-- ===========================================================================
-- 3. step_type CHECK uitbreiden met 'resume_dunning'
-- ===========================================================================
-- Pre-flight: geen rijen met onbekende step_type-waarden vóór ADD CONSTRAINT.
DO $$
DECLARE
  unknown_count integer;
BEGIN
  SELECT count(*) INTO unknown_count
  FROM public.dunning_workflow_steps
  WHERE step_type NOT IN ('email','whatsapp','wait','task','stop','resume_dunning');
  IF unknown_count > 0 THEN
    RAISE EXCEPTION
      'dunning_workflow_steps bevat % rijen met onbekende step_type. Los eerst op vóór deze migratie draait.',
      unknown_count;
  END IF;
END$$;

ALTER TABLE public.dunning_workflow_steps
  DROP CONSTRAINT IF EXISTS dunning_workflow_steps_step_type_check;

ALTER TABLE public.dunning_workflow_steps
  ADD CONSTRAINT dunning_workflow_steps_step_type_check
  CHECK (step_type IN ('email','whatsapp','wait','task','stop','resume_dunning'));

COMMENT ON COLUMN public.dunning_workflow_steps.step_type IS
  'Type step. resume_dunning zet de door het triggerende arrangement gepauzeerde runs van dezelfde klant weer op active (workflow-driven ontpauzeer-actie na een verbroken betaalafspraak).';

-- ===========================================================================
-- 4. Seed: voorbeeld-workflow "Betaalafspraak verbroken" (is_active=false)
-- ===========================================================================
-- STAAT UIT tot Jeffrey 'em zelf aanzet via de Workflows-UI. Volledige
-- ON CONFLICT/NOT EXISTS-guards zodat herhaald draaien geen dubbele rijen
-- maakt.
INSERT INTO public.dunning_workflows
  (name, description, trigger_conditions, is_active, priority)
SELECT
  'Betaalafspraak verbroken',
  'Voorbeeld-workflow: klant is de betaalafspraak niet nagekomen. Standaard: maak een taak (bel de klant na) + hervat de aanmaan-workflow. Staat standaard uit.',
  jsonb_build_object(
    'arrangement_breached', true,
    'min_total_amount', 0
  ),
  false,
  40  -- iets hoger dan dag-7-duwtje (50) zodat 'ie sneller vuurt in dezelfde tick
WHERE NOT EXISTS (
  SELECT 1 FROM public.dunning_workflows WHERE name = 'Betaalafspraak verbroken'
);

-- Step 1: task — bel de klant na
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT
  wf.id,
  1,
  'task',
  jsonb_build_object(
    'title', 'Klant kwam betaalafspraak niet na — bel na',
    'description', 'De klant heeft de gemaakte betaalafspraak niet nagekomen op de afgesproken datum. Bel de klant en maak een nieuwe afspraak of route naar incasso.',
    'assignee_role', 'manager'
  )
FROM public.dunning_workflows wf
WHERE wf.name = 'Betaalafspraak verbroken'
  AND NOT EXISTS (
    SELECT 1 FROM public.dunning_workflow_steps s
     WHERE s.workflow_id = wf.id AND s.step_order = 1
  );

-- Step 2: resume_dunning — de gepauzeerde aanmaan-runs weer op active
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT
  wf.id,
  2,
  'resume_dunning',
  '{}'::jsonb
FROM public.dunning_workflows wf
WHERE wf.name = 'Betaalafspraak verbroken'
  AND NOT EXISTS (
    SELECT 1 FROM public.dunning_workflow_steps s
     WHERE s.workflow_id = wf.id AND s.step_order = 2
  );

COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- ============================================================================
-- BEGIN;
--   -- 4. seed-rijen weg
--   DELETE FROM public.dunning_workflow_steps
--    WHERE workflow_id IN (
--      SELECT id FROM public.dunning_workflows WHERE name = 'Betaalafspraak verbroken'
--    );
--   DELETE FROM public.dunning_workflows WHERE name = 'Betaalafspraak verbroken';
--
--   -- 3. resume_dunning-step-rijen verplicht eerst weg (CHECK zou anders vast zitten)
--   DELETE FROM public.dunning_workflow_steps WHERE step_type = 'resume_dunning';
--   ALTER TABLE public.dunning_workflow_steps DROP CONSTRAINT IF EXISTS dunning_workflow_steps_step_type_check;
--   ALTER TABLE public.dunning_workflow_steps
--     ADD CONSTRAINT dunning_workflow_steps_step_type_check
--     CHECK (step_type IN ('email','whatsapp','wait','task','stop'));
--
--   -- 2. breach_handled_at kolom weg
--   DROP INDEX IF EXISTS idx_payment_arrangements_breach_unhandled;
--   ALTER TABLE public.payment_arrangements DROP COLUMN IF EXISTS breach_handled_at;
--
--   -- 1. paused_by_arrangement_id kolom weg
--   DROP INDEX IF EXISTS idx_dunning_runs_paused_by_arrangement;
--   ALTER TABLE public.dunning_workflow_runs DROP COLUMN IF EXISTS paused_by_arrangement_id;
-- COMMIT;
