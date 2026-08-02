-- ============================================================================
-- 2026-08-02 — dunning_workflow_runs: reden-velden voor handmatige pauze
--
-- ACHTERGROND
--   pause-by-customer.js + run-control.js action='pause' schrijven vandaag
--   ALLEEN status='paused' zonder enig reden-veld. Result: 12 "wees-runs" die
--   niet te onderscheiden zijn van engine-pauzes (paused_by_conversation_id /
--   paused_by_arrangement_id blijven NULL). Structurele fix: 3 nieuwe kolommen
--   die de manual-pause-endpoints vullen en die resume weer wist.
--
-- ADDITIEVE MIGRATIE
--   - IF NOT EXISTS overal → idempotent, veilig om meerdere keren te draaien
--   - Kolommen nullable → bestaande rijen blijven geldig zonder backfill
--   - FK naar auth.users voor paused_by_manual_user_id, met ON DELETE SET NULL
--     zodat het verwijderen van een user de run niet stukmaakt
--   - GEEN kolommen gewijzigd/verwijderd, GEEN indexen op oude data
--   - Enkele partial index voor snelle "handmatig gepauzeerd?"-lookup
--
-- ROLLBACK
--   ALTER TABLE public.dunning_workflow_runs
--     DROP COLUMN IF EXISTS paused_by_manual_user_id,
--     DROP COLUMN IF EXISTS paused_manual_reason,
--     DROP COLUMN IF EXISTS paused_at;
--
-- INTERACTIE MET BESTAANDE PAUZE-VELDEN
--   - paused_by_conversation_id  (inbox-reply)      → onveranderd
--   - paused_by_arrangement_id   (breach)           → onveranderd
--   - paused_by_manual_user_id   (nieuw, handmatig) → deze migratie
--   Semantiek: bij een echte pauze is precies EEN van deze drie NOT NULL.
--   Bij resume via run-control worden alle drie gewist (in dezelfde UPDATE).
-- ============================================================================

BEGIN;

ALTER TABLE public.dunning_workflow_runs
  ADD COLUMN IF NOT EXISTS paused_by_manual_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paused_manual_reason     TEXT,
  ADD COLUMN IF NOT EXISTS paused_at                TIMESTAMPTZ;

COMMENT ON COLUMN public.dunning_workflow_runs.paused_by_manual_user_id IS
  'User-id die de run handmatig pauzeerde via UI (pause-by-customer of run-control). NULL als de pauze door de engine kwam (paused_by_conversation_id / paused_by_arrangement_id in plaats).';

COMMENT ON COLUMN public.dunning_workflow_runs.paused_manual_reason IS
  'Vrije-tekst reden bij handmatige pauze (max 300 chars, afgekapt in de endpoints).';

COMMENT ON COLUMN public.dunning_workflow_runs.paused_at IS
  'Timestamp van het pauze-moment. Voor UI-weergave "Handmatig gepauzeerd op ...". Wordt gewist bij resume.';

-- Partial index — alleen voor rijen die daadwerkelijk handmatig gepauzeerd
-- zijn. Dit maakt de "toon me alle handmatige pauzes"-query goedkoop zonder
-- de generieke run-scan te belasten.
CREATE INDEX IF NOT EXISTS idx_dunning_workflow_runs_paused_by_manual_user_id
  ON public.dunning_workflow_runs (paused_by_manual_user_id)
  WHERE paused_by_manual_user_id IS NOT NULL;

-- Sanity-check: bevestig dat kolommen aanwezig zijn en NULL-baar zijn.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'dunning_workflow_runs'
  AND column_name IN ('paused_by_manual_user_id', 'paused_manual_reason', 'paused_at')
ORDER BY column_name;

COMMIT;
