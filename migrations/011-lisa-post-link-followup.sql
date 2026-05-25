-- 011-lisa-post-link-followup.sql
-- Lisa F13 — Post-link follow-ups: na het sturen van de agenda-link 3 AI-checks (4u/24u/3d)
-- om bevestiging te krijgen, met smart-stop bij booking/reactie. Parallel aan de bestaande
-- follow-up-sequence. Idempotent. Uitvoeren in Supabase SQL Editor.

BEGIN;

-- lisa_followups: post-link vlag + stap
ALTER TABLE lisa_followups
  ADD COLUMN IF NOT EXISTS is_post_link_followup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS post_link_step int;

COMMENT ON COLUMN lisa_followups.is_post_link_followup IS
  'True voor follow-ups die booking-bevestiging vragen ná de agenda-link (3 stappen: 4u/24u/3d).';
COMMENT ON COLUMN lisa_followups.post_link_step IS 'Stapnummer binnen de post-link sequence (1/2/3).';

CREATE INDEX IF NOT EXISTS idx_lisa_followups_post_link
  ON lisa_followups(scheduled_for) WHERE is_post_link_followup = true AND status = 'scheduled';

-- lisa_settings: post-link delay-config
ALTER TABLE lisa_settings
  ADD COLUMN IF NOT EXISTS post_link_followup_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS post_link_step1_hours int NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS post_link_step2_hours int NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS post_link_step3_hours int NOT NULL DEFAULT 72;

COMMENT ON COLUMN lisa_settings.post_link_followup_enabled IS 'Master-toggle voor het post-link follow-up systeem.';

-- lisa_conversations: post-link state
ALTER TABLE lisa_conversations
  ADD COLUMN IF NOT EXISTS agenda_link_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS post_link_followups_scheduled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lisa_conversations.agenda_link_sent_at IS 'Wanneer Lisa voor het eerst de agenda-link stuurde.';
COMMENT ON COLUMN lisa_conversations.post_link_followups_scheduled IS 'Voorkomt dubbele scheduling van post-link follow-ups.';

-- lisa_messages: spiegelvlag voor stats
ALTER TABLE lisa_messages
  ADD COLUMN IF NOT EXISTS is_post_link_followup boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lisa_messages.is_post_link_followup IS 'True als dit out-bericht een post-link follow-up is (stats).';

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_followups' AND column_name IN ('is_post_link_followup','post_link_step');
-- SELECT post_link_followup_enabled, post_link_step1_hours, post_link_step2_hours, post_link_step3_hours
--   FROM lisa_settings WHERE id=1;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_conversations' AND column_name IN ('agenda_link_sent_at','post_link_followups_scheduled');
