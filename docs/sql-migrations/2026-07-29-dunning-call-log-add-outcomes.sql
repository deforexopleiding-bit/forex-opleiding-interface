-- ============================================================================
-- 2026-07-29 — dunning_call_log.outcome CHECK uitbreiden met 'disputed' + 'info_sent'
--
-- ACHTERGROND: acties-tab v1 introduceert 2 nieuwe bel-uitkomsten:
--   * 'disputed'  — klant betwist factuur tijdens gesprek → koppelt aan
--                   de nieuwe 'dispuut'-pipeline-stage (mark-disputed).
--   * 'info_sent' — klant vroeg om factuurkopie → koppelt aan de invoice-
--                   send-flow + automatische MANUAL_FOLLOWUP over N dagen.
--
-- Bestaande outcomes blijven staan; alleen de whitelist wordt breder.
-- DROP + ADD is de kanonieke manier om een CHECK-constraint te wijzigen
-- (PostgreSQL heeft geen "ALTER CHECK"). Idempotent via DO-block: als
-- de constraint al deze outcomes bevat, doen we niets.
--
-- Non-breaking: bestaande rijen blijven geldig (hun outcome-values zaten
-- al in de oude whitelist en zitten ook in de nieuwe). De frontend
-- (finance.html CALL_OUTCOMES) + endpoint (dunning-call-log-create.js
-- VALID_OUTCOMES) worden in dezelfde PR uitgebreid.
--
-- DRAAI-ORDER: deze migratie MOET draaien VÓÓR de code-deploy die de
-- nieuwe outcomes inserteert — anders faalt de insert met 23514
-- (check-violation). Idempotent, veilig om vroeg te draaien.
-- ============================================================================

BEGIN;

  DO $$
  DECLARE
    constraint_name text;
  BEGIN
    -- Vind de bestaande CHECK-constraint op outcome (naam is auto-gegenereerd).
    SELECT conname INTO constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'dunning_call_log'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%outcome%'
    LIMIT 1;

    IF constraint_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.dunning_call_log DROP CONSTRAINT %I', constraint_name);
    END IF;

    ALTER TABLE public.dunning_call_log
      ADD CONSTRAINT dunning_call_log_outcome_check
      CHECK (outcome IN (
        'no_answer','voicemail','callback','payment_promise','payment_plan',
        'refused','wrong_number','paid_during_call',
        'disputed','info_sent'
      ));
  END $$;

  COMMENT ON COLUMN public.dunning_call_log.outcome IS
    'Uitkomst-enum. Sinds acties-tab v1: disputed (koppelt aan pipeline stage dispuut) en info_sent (koppelt aan invoice-send + auto-followup). Bestaande outcomes ongewijzigd.';

  NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- BEGIN;
--   -- Verwijder eerst rijen met de nieuwe outcomes anders schendt de oude CHECK.
--   DELETE FROM public.dunning_call_log WHERE outcome IN ('disputed','info_sent');
--   ALTER TABLE public.dunning_call_log DROP CONSTRAINT dunning_call_log_outcome_check;
--   ALTER TABLE public.dunning_call_log
--     ADD CONSTRAINT dunning_call_log_outcome_check
--     CHECK (outcome IN (
--       'no_answer','voicemail','callback','payment_promise','payment_plan',
--       'refused','wrong_number','paid_during_call'
--     ));
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
