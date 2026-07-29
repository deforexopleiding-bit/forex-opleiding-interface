-- ============================================================================
-- 2026-07-29 — Retry + needs_attention op dunning_workflow_runs
--
-- ACHTERGROND: advanceActiveRuns had geen retry en geen escalatie bij een
-- gefaalde step. Bij whatsapp_send_failed (of soortgelijke fail-status
-- van de executor) schoof de pointer gewoon door naar de volgende step —
-- klant miste die aanmaning en niemand zag het. Bij de dag7-drift ontplofte
-- dit: ~6 weken lang faalden alle dag7 WA-sends stil.
--
-- DEZE MIGRATIE: 4 kolommen op dunning_workflow_runs voor:
--   1) retry-teller per huidige step (reset bij step-advance / cleared bij success)
--   2) escalatie-vlag "needs_attention" (mens moet kijken)
--   3) audit: wanneer + waarom laatste fail
--
-- Idempotent (IF NOT EXISTS). Non-breaking: NOT NULL DEFAULT laat bestaande
-- rijen gewoon op 0 / false landen. Selectie-query in advanceActiveRuns
-- wordt in dezelfde PR uitgebreid met .eq('needs_attention', false).
--
-- Bij DRAAI-ORDER: eerst deze migratie, dan de code-deploy (die de kolommen
-- gebruikt), dan de aparte reset-migratie (2026-07-29-dunning-hung-runs-
-- reset.sql) om bestaande vastgelopen runs los te maken.
-- ============================================================================

BEGIN;

ALTER TABLE public.dunning_workflow_runs
  ADD COLUMN IF NOT EXISTS step_failure_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_attention       boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_failure_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_reason   text;

COMMENT ON COLUMN public.dunning_workflow_runs.step_failure_count IS
  'Aantal opeenvolgende mislukte pogingen op current_step_id. Wordt gereset naar 0 zodra een step succesvol advanced OF needs_attention wordt geclearded bij een auto-recovery.';
COMMENT ON COLUMN public.dunning_workflow_runs.needs_attention IS
  'True als de step MAX_RETRIES (3) keer faalde. Cron slaat de run over totdat een mens ingrijpt (of tot een auto-recovery via een geslaagde send de vlag wist).';
COMMENT ON COLUMN public.dunning_workflow_runs.last_failure_at IS
  'Timestamp van de laatste step-failure. Voor UI-weergave "vastgelopen sinds X dagen".';
COMMENT ON COLUMN public.dunning_workflow_runs.last_failure_reason IS
  'Human-readable string: "<log_event>[:<meta_code>]", bv. "whatsapp_send_failed:132000". Voor UI-tooltip + audit.';

-- Index voor de selectie-query in advanceActiveRuns én voor de pipeline-list
-- join. Composite: engine filtert eerst status, dan needs_attention.
CREATE INDEX IF NOT EXISTS idx_dunning_runs_active_attention
  ON public.dunning_workflow_runs (status, needs_attention, next_action_at)
  WHERE status = 'active';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK (indien nodig):
-- BEGIN;
-- DROP INDEX IF EXISTS idx_dunning_runs_active_attention;
-- ALTER TABLE public.dunning_workflow_runs
--   DROP COLUMN IF EXISTS last_failure_reason,
--   DROP COLUMN IF EXISTS last_failure_at,
--   DROP COLUMN IF EXISTS needs_attention,
--   DROP COLUMN IF EXISTS step_failure_count;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
