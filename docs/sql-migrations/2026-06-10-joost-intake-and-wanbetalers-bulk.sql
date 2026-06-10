-- =====================================================================
-- 2026-06-10 Joost intake-email flow + wanbetalers bulk-start prep
-- =====================================================================
--
-- Purpose:
--   1) Voeg feature-flag `e2_autonomous_intake` toe aan finance-module
--      joost_config (default false, opt-in). Hiermee kan de E1.1
--      auto-suggest pipeline een intake-email vraag stellen wanneer
--      een nieuwe conversation zonder gekoppelde klant binnenkomt.
--   2) Breid joost_conversation_state uit met `intake_status` +
--      `intake_asked_at` zodat we per-conversation kunnen tracken of
--      Joost al om een mail heeft gevraagd, of de klant gematched is,
--      of de poging is gefaald (geen match in customers / geen reply).
--
-- Wanbetalers bulk-start workflow: GEEN schema-wijziging nodig per
-- recon. Het endpoint `api/wanbetalers-bulk-start-workflow.js` gebruikt
-- bestaande tabellen `dunning_workflow_runs` + `dunning_log` met
-- payload-veld `trigger='manual_bulk'`. Audit gaat via bestaande
-- audit_log shape.
--
-- Idempotent: alle statements gebruiken IF NOT EXISTS / NOT (?) guards
-- zodat re-run veilig is.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) joost_config: feature-flag e2_autonomous_intake voor finance module
-- ---------------------------------------------------------------------
-- We voegen de flag alleen toe als hij nog niet bestaat. De `?`-operator
-- checkt of een top-level jsonb-key aanwezig is in feature_flags.
UPDATE joost_config
   SET feature_flags = COALESCE(feature_flags, '{}'::jsonb)
                     || jsonb_build_object('e2_autonomous_intake', false)
 WHERE module = 'finance'
   AND NOT (COALESCE(feature_flags, '{}'::jsonb) ? 'e2_autonomous_intake');

-- ---------------------------------------------------------------------
-- 2) joost_conversation_state: intake_status + intake_asked_at
-- ---------------------------------------------------------------------
-- intake_status enum-set:
--   * 'asked'              -> Joost heeft mail-vraag gestuurd, wacht
--   * 'matched'            -> klant gevonden via email-lookup en gekoppeld
--   * 'failed_no_match'    -> mail ontvangen maar 0 of >1 hits in customers
--   * 'failed_no_response' -> geen reply binnen reasonable window (cron)
-- NULL = nog geen intake-flow getriggerd (default).
ALTER TABLE joost_conversation_state
  ADD COLUMN IF NOT EXISTS intake_status text DEFAULT NULL
    CHECK (
      intake_status IN ('asked', 'matched', 'failed_no_match', 'failed_no_response')
      OR intake_status IS NULL
    );

ALTER TABLE joost_conversation_state
  ADD COLUMN IF NOT EXISTS intake_asked_at timestamptz;

COMMIT;

-- =====================================================================
-- Verify-queries (handmatig na deploy):
--
--   SELECT module, feature_flags->'e2_autonomous_intake' AS intake_flag
--     FROM joost_config WHERE module = 'finance';
--
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'joost_conversation_state'
--      AND column_name IN ('intake_status', 'intake_asked_at');
-- =====================================================================
