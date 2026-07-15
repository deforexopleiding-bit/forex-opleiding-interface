-- 2026-07-15-belmomenten-een-bron-van-waarheid.sql
-- Belmomenten in de aanmaningsflow: 1 bron van waarheid.
--
-- Rangorde:
--   1) Terugbelafspraak (klant vroeg om terugbellen op datum X) -> gaat altijd voor
--   2) Workflow-belmoment (dag 15/17/21/36 uit #768) -> standaard
--   3) Geen van beide -> geen taak
--
-- WIJZIGINGEN:
--   1) dunning_call_log: nieuwe kolom callback_at timestamptz (nullable) voor
--      terugbelafspraken met datum (bij outcome='callback').
--   2) Backfill payload.kind op pending_actions.MANUAL_FOLLOWUP-rijen zodat
--      Acties gefilterd kan worden op soort taak (call / letter / joost / other).
--      Heuristiek op payload.title / payload.source; idempotent.
--   3) Documentatie: interval_days in app_settings.dunning_call_cadence blijft
--      staan voor backwards-compat maar wordt door de nieuwe code niet meer
--      gebruikt voor next_reminder_at (de terugbelafspraak of workflow-taak
--      is nu de bron).
--
-- SQL-strings apostrof-vrij (les uit #758). Tokenizer-check vóór oplevering.

BEGIN;

-- =============================================================================
-- 1) dunning_call_log.callback_at
-- =============================================================================
ALTER TABLE public.dunning_call_log
  ADD COLUMN IF NOT EXISTS callback_at timestamptz;

COMMENT ON COLUMN public.dunning_call_log.callback_at IS
  'Timestamp waarop klant graag teruggebeld wilt worden. Alleen ingevuld bij outcome=callback. Triggert automatisch een pending_action met scheduled_for=callback_at zodat de taak op de juiste dag in Open Acties verschijnt.';

CREATE INDEX IF NOT EXISTS idx_dunning_call_log_callback_at
  ON public.dunning_call_log (callback_at)
  WHERE callback_at IS NOT NULL;

-- =============================================================================
-- 2) Backfill pending_actions.payload.kind
-- =============================================================================
-- Filter/tab-veld voor Wanbetalers > Acties. Nieuwe workflow-taken en
-- callback-taken worden vanaf deze PR met kind ingevuld; deze backfill
-- ruimt de bestaande rijen op.
--
-- Heuristiek (idempotent: alleen zetten als kind nog leeg is):
--   payload.kind='call'   als action_type='MANUAL_FOLLOWUP' EN payload.title
--                         begint met 'Bel klant' (workflow-bel-taken uit #768).
--   payload.kind='letter' als title begint met 'Stuur WIK-14-dagenbrief' of
--                         'Stuur aangetekende brief'.
--   payload.kind='joost'  als payload.source='joost_total_cap' (cap-taak #764).
--   payload.kind='other'  als geen van bovenstaande matcht en action_type
--                         MANUAL_FOLLOWUP is (fallback zodat filter altijd werkt).

-- call
UPDATE public.pending_actions
SET payload = jsonb_set(payload, '{kind}', to_jsonb('call'::text), true),
    updated_at = now()
WHERE action_type = 'MANUAL_FOLLOWUP'
  AND (payload->>'kind') IS NULL
  AND (payload->>'title') LIKE 'Bel klant%';

-- letter
UPDATE public.pending_actions
SET payload = jsonb_set(payload, '{kind}', to_jsonb('letter'::text), true),
    updated_at = now()
WHERE action_type = 'MANUAL_FOLLOWUP'
  AND (payload->>'kind') IS NULL
  AND (
       (payload->>'title') LIKE 'Stuur WIK-14-dagenbrief%'
    OR (payload->>'title') LIKE 'Stuur aangetekende brief%'
  );

-- joost
UPDATE public.pending_actions
SET payload = jsonb_set(payload, '{kind}', to_jsonb('joost'::text), true),
    updated_at = now()
WHERE action_type = 'MANUAL_FOLLOWUP'
  AND (payload->>'kind') IS NULL
  AND (payload->>'source') = 'joost_total_cap';

-- fallback: other
UPDATE public.pending_actions
SET payload = jsonb_set(payload, '{kind}', to_jsonb('other'::text), true),
    updated_at = now()
WHERE action_type = 'MANUAL_FOLLOWUP'
  AND (payload->>'kind') IS NULL;

COMMIT;

-- =============================================================================
-- VERIFICATIE (handmatig)
-- =============================================================================
-- SELECT payload->>'kind' AS kind, COUNT(*)
-- FROM public.pending_actions
-- WHERE action_type = 'MANUAL_FOLLOWUP'
-- GROUP BY 1
-- ORDER BY 1;
-- Verwacht: rijen voor 'call' / 'letter' / 'joost' / 'other'. Geen NULLs meer.
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name='dunning_call_log' AND column_name='callback_at';
-- Verwacht: 1 rij.
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- BEGIN;
--   ALTER TABLE public.dunning_call_log DROP COLUMN IF EXISTS callback_at;
--   UPDATE public.pending_actions
--   SET payload = payload - 'kind'
--   WHERE action_type = 'MANUAL_FOLLOWUP' AND payload ? 'kind';
-- COMMIT;
