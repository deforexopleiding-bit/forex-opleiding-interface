-- 2026-07-15-workflow-steps-fk-set-null.sql
-- Fix: workflow niet meer op te slaan zodra er logs zijn.
--
-- PROBLEEM: dunning_log.step_id en dunning_workflow_runs.current_step_id
-- verwijzen naar dunning_workflow_steps.id met default NO ACTION (=RESTRICT).
-- api/finance-dunning-workflows-upsert.js doet bij PATCH een DELETE+INSERT
-- op de steps -> zodra er 1 run is met logs, faalt de DELETE:
--   "update or delete on table dunning_workflow_steps violates foreign key
--    constraint dunning_log_step_id_fkey on table dunning_log"
--
-- FIX: FK's naar ON DELETE SET NULL. Audit-trail (dunning_log rijen) blijft
-- volledig behouden -- alleen de step_id-referentie wordt NULL als de step
-- écht verdwijnt. Voor dunning_workflow_runs.current_step_id: bij een
-- actieve run zou een verwijderde step de state onduidelijk maken, maar dat
-- was met NO ACTION al niet veiliger (de DELETE faalde gewoon, wat de root
-- cause van deze bug is).
--
-- Deze migratie is EEN HELFT van de fix. De backend (upsert) wordt in
-- dezelfde PR omgebouwd naar diff-based: bestaande step-id's worden
-- behouden bij tekst-wijzigingen zodat log-referenties GELDIG blijven.
-- SET NULL is dan het vangnet voor echt-verwijderde steps.

BEGIN;

-- dunning_log.step_id -> SET NULL
ALTER TABLE public.dunning_log
  DROP CONSTRAINT IF EXISTS dunning_log_step_id_fkey;

ALTER TABLE public.dunning_log
  ADD CONSTRAINT dunning_log_step_id_fkey
    FOREIGN KEY (step_id)
    REFERENCES public.dunning_workflow_steps(id)
    ON DELETE SET NULL;

-- dunning_workflow_runs.current_step_id -> SET NULL
ALTER TABLE public.dunning_workflow_runs
  DROP CONSTRAINT IF EXISTS dunning_workflow_runs_current_step_id_fkey;

ALTER TABLE public.dunning_workflow_runs
  ADD CONSTRAINT dunning_workflow_runs_current_step_id_fkey
    FOREIGN KEY (current_step_id)
    REFERENCES public.dunning_workflow_steps(id)
    ON DELETE SET NULL;

COMMIT;

-- =============================================================================
-- VERIFICATIE
-- =============================================================================
-- SELECT conname, confdeltype
-- FROM pg_constraint
-- WHERE conname IN ('dunning_log_step_id_fkey', 'dunning_workflow_runs_current_step_id_fkey');
-- confdeltype='n' betekent SET NULL (was 'a' = NO ACTION).
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- BEGIN;
--   ALTER TABLE public.dunning_log
--     DROP CONSTRAINT IF EXISTS dunning_log_step_id_fkey;
--   ALTER TABLE public.dunning_log
--     ADD CONSTRAINT dunning_log_step_id_fkey
--       FOREIGN KEY (step_id) REFERENCES public.dunning_workflow_steps(id);
--   ALTER TABLE public.dunning_workflow_runs
--     DROP CONSTRAINT IF EXISTS dunning_workflow_runs_current_step_id_fkey;
--   ALTER TABLE public.dunning_workflow_runs
--     ADD CONSTRAINT dunning_workflow_runs_current_step_id_fkey
--       FOREIGN KEY (current_step_id) REFERENCES public.dunning_workflow_steps(id);
-- COMMIT;
