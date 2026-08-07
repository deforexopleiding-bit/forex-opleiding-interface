-- 2026-08-07 — dunning_briefs: cyclus-sleutel (run_id) + dedup-index
--
-- Doel: de auto-generatie van de WIK-brief (engine-haak op de dag-17-WhatsApp)
-- mag per dunning-cyclus MAXIMAAL ÉÉN brief aanmaken. We koppelen elke
-- auto-brief aan de dunning-run die 'm triggerde en dwingen uniciteit af.
--
-- ADDITIEF: 1 nullable kolom + 1 partial-unique index. Bestaande (handmatige)
-- brieven houden run_id = NULL en blijven onbeperkt — de partial-unique index
-- geldt alleen WHERE run_id IS NOT NULL. Geen bestaande data aangetast.
--
-- Volgorde:
--   1. Draai deze migratie (1 ALTER + 1 CREATE UNIQUE INDEX).
--   2. Deploy code (incasso-pre-brief-core schrijft run_id; engine-haak leest 'm).
--   3. Draai daarna 2026-08-07-dunning-auto-brief-step-flag.sql om de haak te
--      activeren op de geverifieerde dag-17-WhatsApp-stap.

BEGIN;

ALTER TABLE public.dunning_briefs
  ADD COLUMN IF NOT EXISTS run_id uuid NULL
    REFERENCES public.dunning_workflow_runs(id) ON DELETE SET NULL;

-- Dedup: hoogstens één brief per dunning-run (auto-generatie). Race-vast:
-- twee gelijktijdige cron-ticks → de 2e insert krijgt 23505 en de core
-- behandelt dat als benigne duplicaat (DUPLICATE_RUN_BRIEF, storage opgeruimd).
-- Partial (WHERE run_id IS NOT NULL): handmatige brieven (run_id NULL) vallen
-- er buiten en blijven onbeperkt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dunning_briefs_one_per_run
  ON public.dunning_briefs (run_id)
  WHERE run_id IS NOT NULL;

COMMENT ON COLUMN public.dunning_briefs.run_id IS
  'dunning_workflow_runs.id die de auto-generatie triggerde (cyclus-sleutel).
   NULL bij handmatig gegenereerde brieven. Uniek per run via
   idx_dunning_briefs_one_per_run (partial, WHERE run_id IS NOT NULL).';

COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- ============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS public.idx_dunning_briefs_one_per_run;
--   ALTER TABLE public.dunning_briefs DROP COLUMN IF EXISTS run_id;
-- COMMIT;
