-- =============================================================================
-- Joost AI — E1.2 task-linking + intent-detection prompt
-- Datum: 2026-06-10
-- Branch: feat/joost-e12-intent-to-task
--
-- Doel:
--   E1.2-laag bovenop E1.0/E1.1 foundation. Twee veranderingen:
--
--   1. Schema-uitbreiding op joost_suggestions:
--        - linked_task_id          uuid (-> pending_actions.id) ON DELETE SET NULL
--        - linked_arrangement_id   uuid (-> payment_arrangements.id) ON DELETE SET NULL
--      Twee nieuwe status-waarden:
--        - USED_TASK_CREATED         : suggestie leidde tot aanmaak verify-payment
--                                      task (pending_actions row, MANUAL_VERIFY_PAYMENT).
--        - USED_ARRANGEMENT_OPENED   : suggestie leidde tot openen arrangement-wizard
--                                      met pre-fill (payment_arrangements voorstel).
--      Partial indexes op de FK-kolommen voor "welke suggesties hebben een task/arr"
--      queries en latere eval-metrics.
--
--   2. Prompt-update op joost_config.module='finance':
--        - Voegt INTENT-DETECTIE-sectie toe aan system_prompt_template (append).
--        - Definieert 6 intent-categorieen + confidence-score-eis.
--      Eenmalig append: idempotent maakt deze update via NOT LIKE-guard, zodat
--      een tweede run niet dubbel appended.
--
--   Schema-mutaties zijn idempotent (IF NOT EXISTS / DROP+ADD CHECK).
--   Veilig om opnieuw te draaien.
--
-- -- Verifie-queries na uitvoeren --------------------------------------------
-- SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name='joost_suggestions'
--     AND column_name IN ('linked_task_id','linked_arrangement_id');
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname='joost_suggestions_status_check';
-- SELECT module, length(system_prompt_template) AS prompt_len,
--        system_prompt_template ILIKE '%INTENT-DETECTIE%' AS has_intent_block
--   FROM joost_config WHERE module='finance';
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. Schema: joost_suggestions FK-kolommen + status-uitbreiding
-- ===========================================================================

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS linked_task_id uuid
    REFERENCES public.pending_actions(id) ON DELETE SET NULL;

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS linked_arrangement_id uuid
    REFERENCES public.payment_arrangements(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.joost_suggestions.linked_task_id IS
  'Optionele FK naar de pending_actions row die uit deze suggestie is voortgekomen (bv. MANUAL_VERIFY_PAYMENT na klant-claimt-betaald flow). NULL als suggestie geen task heeft opgeleverd.';
COMMENT ON COLUMN public.joost_suggestions.linked_arrangement_id IS
  'Optionele FK naar de payment_arrangements row die uit deze suggestie is voortgekomen (bv. via arrangement-wizard na arrangement_request intent). NULL als suggestie geen arrangement heeft opgeleverd.';

-- Status enum uitbreiden via DROP+ADD CHECK (idempotent)
ALTER TABLE public.joost_suggestions
  DROP CONSTRAINT IF EXISTS joost_suggestions_status_check;

ALTER TABLE public.joost_suggestions
  ADD CONSTRAINT joost_suggestions_status_check
  CHECK (status IN (
    'PROPOSED',
    'USED_AS_IS',
    'USED_EDITED',
    'IGNORED',
    'DISMISSED',
    'USED_TASK_CREATED',
    'USED_ARRANGEMENT_OPENED'
  ));

COMMENT ON COLUMN public.joost_suggestions.status IS
  'PROPOSED -> USED_AS_IS (1-op-1 verstuurd) / USED_EDITED (aangepast verstuurd) / IGNORED (genegeerd) / DISMISSED (weggeklikt) / USED_TASK_CREATED (verify-payment task uit suggestie) / USED_ARRANGEMENT_OPENED (arrangement-wizard geopend uit suggestie).';

-- Partial indexes voor analytics + eval
CREATE INDEX IF NOT EXISTS idx_joost_sugg_linked_task
  ON public.joost_suggestions (linked_task_id)
  WHERE linked_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_joost_sugg_linked_arr
  ON public.joost_suggestions (linked_arrangement_id)
  WHERE linked_arrangement_id IS NOT NULL;

-- ===========================================================================
-- 2. Prompt-update: INTENT-DETECTIE-sectie appenden op finance-config
-- ===========================================================================
-- Guard: append alleen als de sectie er nog niet in zit. Maakt re-run veilig.
UPDATE public.joost_config
SET system_prompt_template = system_prompt_template ||
  E'\n\nINTENT-DETECTIE:\n' ||
  E'- verify_payment: klant zegt al betaald te hebben (ik heb gisteren overgemaakt, het staat al klaar)\n' ||
  E'- arrangement_request: klant vraagt om uitstel/regeling (kan in delen?, kan ik later betalen?, lukt me niet ineens)\n' ||
  E'- escalation_needed: klant is boos, dreigt met jurist, of conversatie is vastgelopen\n' ||
  E'- payment_promise: klant zegt binnenkort te betalen (ik betaal vandaag/morgen)\n' ||
  E'- general_question: vraag over factuur/product/cursus zonder betalingsclaim\n' ||
  E'- other: iets anders\n' ||
  E'\n' ||
  E'Geef ALTIJD een confidence-score (0.0-1.0) voor je intent-detectie.'
WHERE module = 'finance'
  AND system_prompt_template NOT LIKE '%INTENT-DETECTIE:%';

COMMIT;
