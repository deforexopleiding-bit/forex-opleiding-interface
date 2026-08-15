-- 2026-08-15-sanne-fase-2-0-foundation.sql
--
-- Sanne — autonome mail-agent, FASE 2.0 (foundation, shadow-mode).
--
-- Alles default UIT. Sanne rekent + logt na deploy, doet niks naar buiten.
-- Feature-flag rollout in latere fases (2.1 reactive suggest, 2.2 auto-draft,
-- 2.3 autonomous send).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / DO $$…$$
-- guards. Safe om meerdere keren te draaien.
--
-- Protected zone: raakt joost_config alleen als nieuwe rij (module='email').
-- Bestaande module='finance' rij blijft ongewijzigd (Joost).
--
-- Instructie: draai deze migratie in de Supabase SQL-editor als één blok.
-- Statements zijn onafhankelijk (geen state-doorgifte tussen DO-blokken).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) sanne_suggestions — log-tabel voor iedere Sanne-suggestie
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sanne_suggestions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id              uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  mailbox               text NOT NULL,
  detected_intent       text,
  confidence            numeric(3,2),
  draft_subject         text,
  draft_body_html       text,
  draft_body_text       text,
  status                text NOT NULL DEFAULT 'PROPOSED',
  autonomy_decision     jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_draft_id       uuid REFERENCES email_drafts(id) ON DELETE SET NULL,
  linked_reply_id       uuid REFERENCES email_replies(id) ON DELETE SET NULL,
  auto_triggered        boolean NOT NULL DEFAULT false,
  kb_articles_used      jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_used            jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  outcome_at            timestamptz,
  outcome_notes         text,
  CONSTRAINT sanne_suggestions_status_chk CHECK (status IN (
    'PROPOSED', 'DRAFT_SAVED', 'USED', 'EDITED', 'DISMISSED',
    'SENT_AUTONOMOUSLY',
    'BLOCKED_CONFIDENCE', 'BLOCKED_INTENT', 'BLOCKED_MANDATE',
    'BLOCKED_OFFICE_HOURS', 'BLOCKED_RATE_LIMIT', 'BLOCKED_NO_CUSTOMER',
    'BLOCKED_MODE', 'BLOCKED_OTHER',
    'FAILED_LLM', 'FAILED_INTERNAL'
  ))
);

-- Snelste query-paden: per email (dedup-check bij re-trigger) + per mailbox
-- (dashboard) + per status (open kaartjes).
CREATE UNIQUE INDEX IF NOT EXISTS sanne_suggestions_email_uniq
  ON sanne_suggestions (email_id);
CREATE INDEX IF NOT EXISTS sanne_suggestions_mailbox_created
  ON sanne_suggestions (mailbox, created_at DESC);
CREATE INDEX IF NOT EXISTS sanne_suggestions_status
  ON sanne_suggestions (status)
  WHERE status IN ('PROPOSED', 'DRAFT_SAVED');

-- RLS: alle authenticated users mogen lezen (dashboard). Schrijven alleen
-- via service-role (sync-hook + admin-UI via server-endpoint).
ALTER TABLE sanne_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sanne_suggestions_read_all ON sanne_suggestions;
CREATE POLICY sanne_suggestions_read_all ON sanne_suggestions
  FOR SELECT USING (auth.role() = 'authenticated');

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) sanne_skip_log — welke inbound is overgeslagen en waarom (debugging)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sanne_skip_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id       uuid REFERENCES email_messages(id) ON DELETE CASCADE,
  mailbox        text NOT NULL,
  from_address   text,
  skip_reason    text NOT NULL,
  skip_detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
  skipped_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sanne_skip_log_mailbox_ts
  ON sanne_skip_log (mailbox, skipped_at DESC);
CREATE INDEX IF NOT EXISTS sanne_skip_log_reason
  ON sanne_skip_log (skip_reason);

ALTER TABLE sanne_skip_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sanne_skip_log_read_all ON sanne_skip_log;
CREATE POLICY sanne_skip_log_read_all ON sanne_skip_log
  FOR SELECT USING (auth.role() = 'authenticated');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) kb_articles: applies_to jsonb (multi-agent-tagging)
-- ═══════════════════════════════════════════════════════════════════════════
-- Bestaande artikelen krijgen default ["simon"] (bewaakt bestaande Simon-KB-flow).
-- Nieuwe email-artikelen kunnen ["sanne"] of ["sanne","simone"] als applies_to
-- krijgen. Sanne leest kb_articles WHERE applies_to ? 'sanne'.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'kb_articles') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'kb_articles' AND column_name = 'applies_to'
    ) THEN
      ALTER TABLE kb_articles
        ADD COLUMN applies_to jsonb NOT NULL DEFAULT '["simon"]'::jsonb;
      CREATE INDEX IF NOT EXISTS kb_articles_applies_to
        ON kb_articles USING gin (applies_to);
    END IF;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) joost_config module='email' rij — Sanne-config (INSERT indien afwezig)
-- ═══════════════════════════════════════════════════════════════════════════
-- Herbruik van joost_config. Persona/prompt/knowledge_base/feature_flags/
-- autonomy_config allemaal in 1 rij per module — Sanne is 'email'.
INSERT INTO joost_config (
  module,
  persona_name,
  persona_tone,
  system_prompt_template,
  knowledge_base,
  model,
  temperature,
  context_message_count,
  is_enabled,
  feature_flags,
  autonomy_config
)
VALUES (
  'email',
  'Sanne',
  'vriendelijk, oplossingsgericht, zakelijk-warm - Nederlands',
  E'Je bent Sanne, de e-mail-medewerker van {{company_name}} (De Forex Opleiding NL B.V.).\n\n'
  E'Je taak: e-mails van klanten en prospects vriendelijk, kort en accuraat beantwoorden.\n\n'
  E'Regels:\n'
  E'- Schrijf in het Nederlands, tutoyeer, warm-professioneel\n'
  E'- Blijf beknopt: 3-6 zinnen tenzij de vraag echt uitleg vereist\n'
  E'- Gebruik search_kb() bij inhoudelijke vragen over onze diensten\n'
  E'- Gebruik lookup_customer() als je klant-context nodig hebt\n'
  E'- Bij klachten, juridische vragen, terugvorderingen, escalaties: markeer met detected_intent en laat een mens beantwoorden\n'
  E'- Bij financiele/betaal-vragen: markeer en laat over aan Joost (finance-agent)\n'
  E'- Bevestig nooit dingen die je niet in de KB of klantdata terug kunt vinden\n\n'
  E'E-mail context: van {{from_name}} <{{from_address}}> op {{received_at}}, onderwerp: {{subject}}',
  '{}'::jsonb,
  'claude-sonnet-4-6',
  0.3,
  10,
  true,
  jsonb_build_object(
    'sanne_decision_logs',    true,
    'sanne_reactive_suggest', false,
    'sanne_auto_draft_save',  false,
    'sanne_autonomous_send',  false
  ),
  jsonb_build_object(
    'mailbox_scope',   jsonb_build_array('info'),
    'skip_domains',    jsonb_build_array(
      'mollie.com', 'teamleader.eu', 'stripe.com',
      'github.com', 'vercel.com', 'supabase.io',
      'meta.com', 'facebook.com', 'google.com',
      'sendgrid.net', 'mailgun.org', 'amazonses.com'
    ),
    'blocked_intents', jsonb_build_array(
      'refund_request', 'legal', 'escalation',
      'complaint_severe', 'payment_dispute'
    ),
    'mandate', jsonb_build_object(
      'max_amount_mentioned_eur',   500,
      'office_hours_only',          true,
      'office_hours_start',         9,
      'office_hours_end',           17,
      'office_days',                jsonb_build_array(1,2,3,4,5),
      'max_sends_per_day',          20,
      'require_customer_link',      true,
      'min_confidence_reactive',    0.60,
      'min_confidence_auto_draft',  0.70,
      'min_confidence_autonomous',  0.85,
      'anti_loop_cooldown_seconds', 60
    )
  )
)
ON CONFLICT (module) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Verificatie (informatief — draai apart als je wilt checken)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT module, persona_name, is_enabled,
--        feature_flags -> 'sanne_decision_logs' AS decision_logs,
--        feature_flags -> 'sanne_reactive_suggest' AS reactive,
--        feature_flags -> 'sanne_auto_draft_save' AS auto_draft,
--        feature_flags -> 'sanne_autonomous_send' AS autonomous_send,
--        autonomy_config -> 'mailbox_scope' AS mailboxes
-- FROM joost_config
-- WHERE module = 'email';
--
-- SELECT count(*) FROM sanne_suggestions;   -- moet 0 zijn direct na migratie
-- SELECT count(*) FROM sanne_skip_log;      -- moet 0 zijn direct na migratie
