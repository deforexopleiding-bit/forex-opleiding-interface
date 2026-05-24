-- 006-lisa-followup-system.sql
-- Lisa F7 — Configureerbaar follow-up systeem: sequence-config, stop-detectie, per-conv pauze.
-- Idempotent. Uitvoeren in Supabase SQL Editor (één keer; herhaalbaar).
-- Vereist: lisa_* tabellen uit migratie 003 (+ 005).
--
-- NB: lisa_config.followup_enabled en lisa_conversations.followup_paused bestaan al sinds
-- migratie 003 — de ADD COLUMN IF NOT EXISTS hieronder zijn dan no-ops (bewust, voor zekerheid).

BEGIN;

-- ============================================
-- lisa_config: follow-up sequence configuratie
-- ============================================
-- followup_sequence = jsonb array van stappen, bv.:
-- [
--   { "step": 1, "delay_hours": 24, "template": "Hey {naam}, nog interesse?",
--     "conditions": { "phase_in": ["intro","doel"], "phase_not_in": ["call","qualified","disqualified"] },
--     "use_ai": false }
-- ]
ALTER TABLE lisa_config
  ADD COLUMN IF NOT EXISTS followup_sequence jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS followup_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS stop_keywords jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS followup_ai_threshold_chars int DEFAULT 200;

COMMENT ON COLUMN lisa_config.followup_sequence IS
  'JSONB array van follow-up stappen: [{step, delay_hours, template, conditions, use_ai}]';
COMMENT ON COLUMN lisa_config.stop_keywords IS
  'Extra stop-keywords (lowercase). Hardcoded fallback altijd actief.';
COMMENT ON COLUMN lisa_config.followup_ai_threshold_chars IS
  'Templates onder deze lengte: letterlijk verstuurd. Boven: AI-generatie met template als guidance.';

-- ============================================
-- lisa_followups: velden voor reguliere (sequence) follow-ups
-- ============================================
ALTER TABLE lisa_followups
  ADD COLUMN IF NOT EXISTS is_regular_followup boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_at_schedule text,
  ADD COLUMN IF NOT EXISTS conditions_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS used_ai boolean DEFAULT false;

COMMENT ON COLUMN lisa_followups.is_regular_followup IS
  'True voor sequence follow-ups (1-5 stappen), false voor delayed responses.';
COMMENT ON COLUMN lisa_followups.template_at_schedule IS
  'Snapshot van template bij schedule-moment. Voor audit als config later wijzigt.';
COMMENT ON COLUMN lisa_followups.conditions_snapshot IS
  'Snapshot van condities die golden bij schedule. Voor cron-evaluatie en audit.';

-- ============================================
-- lisa_conversations: per-conversatie follow-up pauze + stop-detectie
-- ============================================
ALTER TABLE lisa_conversations
  ADD COLUMN IF NOT EXISTS followup_paused boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS followup_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS followup_paused_reason text,
  ADD COLUMN IF NOT EXISTS stop_detected_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_detected_keyword text;

CREATE INDEX IF NOT EXISTS idx_lisa_conv_followup_paused
  ON lisa_conversations(followup_paused) WHERE followup_paused = true;

COMMENT ON COLUMN lisa_conversations.stop_detected_keyword IS
  'Welk stop-keyword detecteerde de afmelding. Hardcoded fallback (in code, niet DB): '
  'stop, geen interesse, niet meer, ophouden, vermoeiend, kapt ermee, laat me met rust, '
  'mag je verwijderen, niet geinteresseerd, niet geïnteresseerd, later misschien (cold). '
  'Uitbreidbaar via lisa_config.stop_keywords.';

-- ============================================
-- View: openstaande follow-ups (admin-overzicht, read-only)
-- ============================================
CREATE OR REPLACE VIEW lisa_pending_followups AS
SELECT
  fu.id,
  fu.conversation_id,
  fu.followup_step,
  fu.scheduled_for,
  fu.is_delayed_response,
  fu.is_regular_followup,
  fu.template_at_schedule,
  c.ghl_contact_id,
  c.phase,
  c.followup_paused,
  c.stop_detected_at
FROM lisa_followups fu
JOIN lisa_conversations c ON c.id = fu.conversation_id
WHERE fu.status = 'scheduled'
  AND c.followup_paused = false
  AND c.stop_detected_at IS NULL
ORDER BY fu.scheduled_for ASC;

COMMENT ON VIEW lisa_pending_followups IS
  'Read-only overzicht van follow-ups die nog verzonden moeten worden '
  '(geen gepauzeerde conversaties, geen stop-gedetecteerde).';

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_config' AND column_name LIKE 'followup%' OR column_name='stop_keywords';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_followups'
--     AND column_name IN ('is_regular_followup','template_at_schedule','conditions_snapshot','used_ai');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_conversations'
--     AND (column_name LIKE 'followup%' OR column_name LIKE 'stop_detected%');
-- SELECT * FROM lisa_pending_followups LIMIT 5;
