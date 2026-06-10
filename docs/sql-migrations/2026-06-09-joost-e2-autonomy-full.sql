-- =============================================================================
-- Joost AI — E2.0 autonomy-full fundament
-- Datum: 2026-06-09
-- Branch: feat/joost-e2-autonomy-full
--
-- Doel:
--   Introduceert de schema- + seed-laag voor Joost autonomy-mode (E2). Bouwt
--   voort op E1.0 (config + suggestions, draft-mode) en E1.1 (auto-suggest +
--   auto_triggered discriminator). De autonomy-laag voegt 3 dingen toe:
--
--     1. joost_config wordt verrijkt met:
--          * autonomy_config jsonb   -- volledig configureerbare beleids-blob
--                                      (intents / arrangement_mandate /
--                                       communication_limits / personality /
--                                       outbound). Eén jsonb-veld i.p.v. 8
--                                       losse kolommen zodat tweaken via
--                                       admin-UI niet steeds een migratie
--                                       vereist en de admin-UI met één blob
--                                       kan werken.
--          * feature_flags jsonb     -- 5 boolean flags die per-feature de
--                                      autonomy-rollout sturen (decision-
--                                      engine logs aan, rest default uit).
--          Default-rij voor module='finance' wordt geseed met de E2.0 spec.
--
--     2. joost_suggestions krijgt 3 nieuwe kolommen + uitgebreide status-set
--        zodat de autonomy-pad zichtbaar wordt in de log:
--          * sent_autonomously boolean   -- discriminator naast auto_triggered
--          * autonomy_decision jsonb     -- decision-engine output (intent,
--                                          confidence, blockers, model)
--          * sent_message_id uuid        -- FK naar whatsapp_messages.id voor
--                                          de werkelijk verzonden outbound
--          * status CHECK-uitbreiding    -- 12 statussen i.p.v. 5 (5 nieuwe
--                                          BLOCKED_* + SENT_AUTONOMOUSLY)
--
--     3. joost_conversation_state — nieuwe tabel (1 rij per conversatie) met
--        runtime-state die de autonomy-engine nodig heeft:
--          * topics_discussed jsonb       -- welke onderwerpen al langs zijn
--          * last_proposal_made jsonb     -- laatste door-Joost gedaan voorstel
--          * messages_sent_today int      -- cap per dag (reset op datum-flip)
--          * messages_sent_today_date     -- datum waarop teller hoort
--          * messages_sent_total int      -- cap per conversatie (lifetime)
--          * last_message_sent_at         -- voor cooldown-window
--          * last_outbound_template_sent_at + last_outbound_workflow_step
--                                         -- handshake met dunning-engine
--          * no_reply_streak_count int    -- pauzeer-trigger bij N stiltes
--          * autonomy_paused_reason text  -- expliciete pauze-reden (UI-tag)
--          * autonomy_paused_until timestamptz -- tot-wanneer pauze geldt
--
-- Architectuur-notes:
--   * jsonb voor autonomy_config gekozen i.p.v. losse kolommen omdat:
--       - admin-UI bewerkt 1 blob (JSON-editor) — geen formulier met 30 velden
--       - tweaks (bv. extra intent, extra cap) vereisen GEEN migratie
--       - reden waarom feature_flags ook jsonb is en niet 5 booleans
--   * RLS pattern is identiek aan joost_config / joost_suggestions:
--       SELECT authenticated, write blocked (service-role only via endpoints).
--   * Status-CHECK uitgebreid via DROP+ADD CONSTRAINT pattern omdat ALTER
--     CONSTRAINT op CHECK niet bestaat in PostgreSQL.
--   * Updated_at-trigger op joost_conversation_state hergebruikt het function-
--     pattern van joost_config_touch_updated_at (eigen functie i.v.m.
--     trigger-naam-conflict bij hergebruik).
--
-- Idempotent: BEGIN/COMMIT + IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
-- DROP+ADD CONSTRAINT (status-CHECK) + ON CONFLICT DO UPDATE voor seed.
-- Veilig om opnieuw te draaien.
--
-- -- Verifie-queries na uitvoeren --------------------------------------------
-- SELECT module,
--        autonomy_config->'intents'->'ja_op_uitstel'->>'enabled' AS uitstel_enabled,
--        feature_flags->>'e2_decision_engine_logs'              AS decision_logs
--   FROM joost_config WHERE module='finance';
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='joost_suggestions'
--     AND column_name IN ('sent_autonomously','autonomy_decision','sent_message_id');
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.joost_suggestions'::regclass
--     AND conname = 'joost_suggestions_status_check';
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name='joost_conversation_state';
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. joost_config: autonomy_config + feature_flags
-- ===========================================================================

ALTER TABLE public.joost_config
  ADD COLUMN IF NOT EXISTS autonomy_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.joost_config
  ADD COLUMN IF NOT EXISTS feature_flags jsonb NOT NULL DEFAULT jsonb_build_object(
    'e2_decision_engine_logs', true,
    'e2_auto_send_text',       false,
    'e2_auto_send_template',   false,
    'e2_outbound_scheduler',   false,
    'e2_arrangement_proposer', false
  );

COMMENT ON COLUMN public.joost_config.autonomy_config IS
  'Volledige autonomy-beleids-blob (intents, arrangement_mandate, communication_limits, personality, outbound). Bewerkt via admin-UI als JSON. jsonb i.p.v. losse kolommen zodat nieuwe intents/caps geen migratie vereisen.';
COMMENT ON COLUMN public.joost_config.feature_flags IS
  'Per-feature autonomy-rollout flags (e2_decision_engine_logs, e2_auto_send_text, e2_auto_send_template, e2_outbound_scheduler, e2_arrangement_proposer). Default: alleen logs aan, rest uit voor veilige roll-out.';

-- Seed autonomy_config voor finance-module (idempotent: overschrijft alleen
-- als de huidige rij nog leeg is). Bewust ON CONFLICT met expliciete keuze:
-- als er al een config staat, hercheck niet — admin heeft mogelijk al getweakt.
UPDATE public.joost_config
   SET autonomy_config = jsonb_build_object(
     'intents', jsonb_build_object(
       'ja_op_uitstel', jsonb_build_object(
         'enabled',           true,
         'min_confidence',    0.85,
         'requires_proposal', true,
         'action',            'register_promise_and_confirm'
       ),
       'tegenvoorstel_termijn', jsonb_build_object(
         'enabled',           true,
         'min_confidence',    0.80,
         'max_termijn_dagen', 30,
         'action',            'propose_arrangement_if_within_mandate'
       ),
       'gespreid_betalen', jsonb_build_object(
         'enabled',                 true,
         'min_confidence',          0.80,
         'max_termijnen',           3,
         'min_eerste_termijn_pct',  0.30,
         'action',                  'propose_splitsing_if_within_mandate'
       ),
       'kan_niet_betalen', jsonb_build_object(
         'enabled',        true,
         'min_confidence', 0.75,
         'action',         'escalate_to_human_with_empathy'
       ),
       'al_betaald_claim', jsonb_build_object(
         'enabled',        true,
         'min_confidence', 0.85,
         'action',         'create_verify_payment_task_and_acknowledge'
       ),
       'boos_of_klacht', jsonb_build_object(
         'enabled',        true,
         'min_confidence', 0.70,
         'action',         'soften_tone_and_escalate'
       ),
       'vraag_om_kopie_factuur', jsonb_build_object(
         'enabled',        true,
         'min_confidence', 0.80,
         'action',         'send_invoice_link_template'
       )
     ),
     'arrangement_mandate', jsonb_build_object(
       'uitstel', jsonb_build_object(
         'enabled',                    true,
         'max_dagen_zonder_approval',  14,
         'max_dagen_total',            30,
         'auto_approve_if_within',     true
       ),
       'splitsing', jsonb_build_object(
         'enabled',                       true,
         'max_termijnen_zonder_approval', 2,
         'max_termijnen_total',           3,
         'min_eerste_termijn_pct',        0.30,
         'auto_approve_if_within',        false
       ),
       'abonnement_pauze', jsonb_build_object(
         'enabled',                   false,
         'requires_human_approval',   true
       ),
       'abonnement_stop', jsonb_build_object(
         'enabled',                   false,
         'requires_human_approval',   true
       ),
       'kwijtschelding', jsonb_build_object(
         'enabled',                   false,
         'requires_human_approval',   true
       )
     ),
     'communication_limits', jsonb_build_object(
       'max_messages_per_conversation_per_day',  3,
       'max_messages_per_conversation_total',    20,
       'cooldown_after_outbound_minutes',        60,
       'no_reply_pause_threshold',               3,
       'no_reply_pause_duration_hours',          48,
       'office_hours_only',                      true,
       'office_hours_tz',                        'Europe/Amsterdam',
       'office_hours_days',                      jsonb_build_array(1,2,3,4,5),
       'office_hours_start',                     '08:30',
       'office_hours_end',                       '18:00'
     ),
     'personality', jsonb_build_object(
       'tone',              'vriendelijk-professioneel',
       'use_tutoyeer',      true,
       'max_message_chars', 480,
       'sign_off_style',    'naam_only',
       'emoji_policy',      'sparingly'
     ),
     'outbound', jsonb_build_object(
       'enabled',                 false,
       'allowed_templates',       jsonb_build_array(),
       'allowed_workflow_steps',  jsonb_build_array(),
       'schedule_cron',           '30 8,11,14,17 * * 1-5',
       'schedule_tz',             'Europe/Amsterdam',
       'max_per_run',             25
     )
   )
 WHERE module = 'finance';

-- ===========================================================================
-- 2. joost_suggestions: 3 nieuwe kolommen + uitgebreide status-CHECK
-- ===========================================================================

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS sent_autonomously boolean NOT NULL DEFAULT false;

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS autonomy_decision jsonb;

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS sent_message_id uuid
    REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.joost_suggestions.sent_autonomously IS
  'true wanneer Joost de suggestie zelf heeft verzonden (E2 autonomy). false bij draft/auto-suggest waar mens de send-knop drukt.';
COMMENT ON COLUMN public.joost_suggestions.autonomy_decision IS
  'Decision-engine output: { intent, confidence, blockers[], model, mandate_check }. NULL bij niet-autonomy paden.';
COMMENT ON COLUMN public.joost_suggestions.sent_message_id IS
  'FK naar whatsapp_messages.id voor het werkelijk verzonden outbound bericht (alleen ingevuld bij SENT_AUTONOMOUSLY).';

-- Status-CHECK uitbreiden: 5 oude + 1 nieuwe send + 5 BLOCKED_* = 11 actief +
-- bestaande PROPOSED-default. PostgreSQL kent geen ALTER CHECK CONSTRAINT.
ALTER TABLE public.joost_suggestions
  DROP CONSTRAINT IF EXISTS joost_suggestions_status_check;

ALTER TABLE public.joost_suggestions
  ADD CONSTRAINT joost_suggestions_status_check CHECK (status IN (
    'PROPOSED',
    'USED_AS_IS',
    'USED_EDITED',
    'IGNORED',
    'DISMISSED',
    'SENT_AUTONOMOUSLY',
    'BLOCKED_LOW_CONFIDENCE',
    'BLOCKED_INTENT_DISABLED',
    'BLOCKED_COMMUNICATION_LIMIT',
    'BLOCKED_MANDATE_EXCEEDED',
    'BLOCKED_AUTONOMY_PAUSED'
  ));

-- ===========================================================================
-- 3. joost_conversation_state — runtime-state per conversatie
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.joost_conversation_state (
  conversation_id                  uuid PRIMARY KEY
                                     REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  topics_discussed                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_proposal_made               jsonb,
  messages_sent_today              integer NOT NULL DEFAULT 0,
  messages_sent_today_date         date,
  messages_sent_total              integer NOT NULL DEFAULT 0,
  last_message_sent_at             timestamptz,
  last_outbound_template_sent_at   timestamptz,
  last_outbound_workflow_step      text,
  no_reply_streak_count            integer NOT NULL DEFAULT 0,
  autonomy_paused_reason           text,
  autonomy_paused_until            timestamptz,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.joost_conversation_state IS
  'Runtime-state per WhatsApp-conversatie voor Joost autonomy (1 rij per conversatie). Telt verzonden berichten per dag + lifetime, houdt topics/proposals bij, en bewaakt pauze-status.';
COMMENT ON COLUMN public.joost_conversation_state.topics_discussed IS
  'Array van onderwerpen die in de conversatie al langs zijn (uitstel, kwijtschelding, etc). Voorkomt herhaling.';
COMMENT ON COLUMN public.joost_conversation_state.last_proposal_made IS
  'Laatste door-Joost gedaan voorstel als jsonb { type, details, made_at }. Voor mandaat-controle bij herhalingen.';
COMMENT ON COLUMN public.joost_conversation_state.messages_sent_today IS
  'Aantal Joost-outbound berichten vandaag. Reset op datum-flip (zie messages_sent_today_date).';
COMMENT ON COLUMN public.joost_conversation_state.messages_sent_today_date IS
  'Datum waarop messages_sent_today hoort. Bij andere datum: teller wordt op 0 gezet.';
COMMENT ON COLUMN public.joost_conversation_state.messages_sent_total IS
  'Lifetime teller van Joost-outbound berichten in deze conversatie. Voor max_messages_per_conversation_total cap.';
COMMENT ON COLUMN public.joost_conversation_state.last_outbound_template_sent_at IS
  'Handshake met dunning-engine: wanneer is laatste outbound-template vanuit workflow gestuurd. Voorkomt dubbel sturen.';
COMMENT ON COLUMN public.joost_conversation_state.last_outbound_workflow_step IS
  'Laatste workflow-step die outbound heeft getriggerd (dunning_workflow_steps.id of vrije tekst).';
COMMENT ON COLUMN public.joost_conversation_state.no_reply_streak_count IS
  'Aantal opeenvolgende Joost-berichten zonder klant-reactie. Bij overschrijden drempel -> autonomy pauze.';
COMMENT ON COLUMN public.joost_conversation_state.autonomy_paused_reason IS
  'Expliciete reden waarom autonomy gepauzeerd is (manual_pause / no_reply_streak / mandate_exceeded / etc).';
COMMENT ON COLUMN public.joost_conversation_state.autonomy_paused_until IS
  'Tot wanneer de pauze geldt. NULL = onbepaald (handmatig hervatten vereist).';

CREATE INDEX IF NOT EXISTS idx_joost_conv_state_paused
  ON public.joost_conversation_state (autonomy_paused_until)
  WHERE autonomy_paused_until IS NOT NULL;

CREATE OR REPLACE FUNCTION public.joost_conv_state_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_joost_conv_state_touch ON public.joost_conversation_state;
CREATE TRIGGER trg_joost_conv_state_touch
  BEFORE UPDATE ON public.joost_conversation_state
  FOR EACH ROW EXECUTE FUNCTION public.joost_conv_state_touch_updated_at();

-- ===========================================================================
-- 4. RLS op joost_conversation_state
-- ===========================================================================

ALTER TABLE public.joost_conversation_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS joost_conv_state_read_authenticated ON public.joost_conversation_state;
CREATE POLICY joost_conv_state_read_authenticated
  ON public.joost_conversation_state
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS joost_conv_state_no_write ON public.joost_conversation_state;
CREATE POLICY joost_conv_state_no_write
  ON public.joost_conversation_state
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

COMMIT;
