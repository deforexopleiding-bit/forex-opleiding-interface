-- =============================================================================
-- Joost AI E1.1 auto-suggest + F3 escalation foundation
-- Datum: 2026-06-10
-- Branch: feat/joost-e11-autoSuggest-and-f3-escalation
--
-- Doel:
--   Voorbereidende DB-laag voor twee parallelle features die in komende PR's
--   landen:
--
--   1. E1.1 auto-suggest (Joost):
--        Wanneer een inbound klantbericht binnenkomt via inbox-webhook EN
--        de conversatie hangt aan een finance-mailbox EN er staat geen recente
--        PROPOSED-suggestie open, dan triggert de webhook fire-and-forget een
--        Joost-suggestie. Om in analytics + UI onderscheid te kunnen maken
--        tussen automatische en handmatige suggesties wordt een nieuwe boolean
--        kolom `auto_triggered` op joost_suggestions toegevoegd. Default false
--        zodat bestaande rijen (en handmatige Vraag Joost klikken) ongewijzigd
--        blijven.
--
--   2. F3 MANUAL_ESCALATION (taken):
--        Nieuwe action_type voor pending_actions waarmee een escalatie als
--        eigenstandige taak in Open Acties verschijnt. GEEN schema-wijziging
--        op pending_actions nodig: action_type is per ontwerp vrije tekst
--        (zie 2026-06-09-payment-arrangements-d1.sql regel 106-107), severity
--        en escalation_text landen in payload jsonb, en invoice_id mag NULL
--        zijn (klant-brede escalatie). Deze migratie documenteert die keuze
--        expliciet zodat een lezer van de migratie-historie de F3-rationale
--        terugvindt zonder code te grep'en.
--
--   Schema-mutatie is idempotent (ADD COLUMN IF NOT EXISTS). Veilig om
--   opnieuw te draaien.
--
-- -- Verifie-queries na uitvoeren --------------------------------------------
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_name='joost_suggestions'
--     AND column_name='auto_triggered';
-- SELECT count(*) AS auto_count
--   FROM joost_suggestions WHERE auto_triggered = true;
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. joost_suggestions.auto_triggered (E1.1 auto-suggest discriminator)
-- ===========================================================================

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS auto_triggered boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.joost_suggestions.auto_triggered IS
  'true wanneer Joost-suggestie automatisch is gegenereerd door webhook (E1.1), false bij handmatige Vraag Joost knop.';

-- ===========================================================================
-- 2. F3 MANUAL_ESCALATION (geen schema-wijziging, alleen documentatie)
-- ===========================================================================
-- pending_actions.action_type is vrije tekst (zie 2026-06-09-payment-arrangements-d1.sql
-- regel 106-107). MANUAL_ESCALATION wordt in deze branch toegevoegd aan de
-- registry in api/_lib/task-types.js + krijgt eigen create-endpoint
-- (api/tasks-create-escalation.js) + frontend filter-pill in
-- modules/open-acties.html. Severity (low/medium/high) en escalation_text
-- landen in pending_actions.payload jsonb. invoice_id mag NULL zijn voor
-- klant-brede escalaties die niet aan 1 factuur hangen.

COMMIT;
