-- 003-lisa-tables.sql
-- Lisa AI Appointmentsetter — complete DB foundation
-- Spec: docs/lisa-appointmentsetter.md
-- Idempotent. Uitvoeren in Supabase SQL Editor (één keer; herhaalbaar).
-- Vereist: public.is_super_admin() uit migratie 002.

BEGIN;

-- ============================================
-- TABEL 1: lisa_config (trainings-tool config, versioned)
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL,
  is_active boolean NOT NULL DEFAULT false,

  -- Persona
  persona_name text NOT NULL DEFAULT 'Lisa',
  persona_age text,
  persona_background text,
  persona_tone text DEFAULT 'vriendelijk en professioneel',
  persona_writing_style text,
  emoji_usage text DEFAULT 'spaarzaam', -- 'nooit'/'spaarzaam'/'normaal'/'veel'

  -- Do's & Don'ts (arrays van strings)
  dos jsonb DEFAULT '[]'::jsonb,
  donts jsonb DEFAULT '[]'::jsonb,

  -- Fase prompts (per fase: system prompt + transition criteria)
  phase_intro jsonb DEFAULT '{}'::jsonb,
  phase_doel jsonb DEFAULT '{}'::jsonb,
  phase_situatie jsonb DEFAULT '{}'::jsonb,
  phase_band jsonb DEFAULT '{}'::jsonb,
  phase_call jsonb DEFAULT '{}'::jsonb,

  -- Few-shot voorbeelden (good + bad)
  examples_good jsonb DEFAULT '[]'::jsonb,
  examples_bad jsonb DEFAULT '[]'::jsonb,

  -- Knowledge Base (Lisa-specifiek)
  kb_products text,
  kb_pricing text,
  kb_usps text,
  kb_faq jsonb DEFAULT '[]'::jsonb,
  kb_use_general_kb boolean DEFAULT true, -- ook bestaande KB module gebruiken?

  -- Follow-up configuratie
  followup_enabled boolean DEFAULT true,
  followup_steps jsonb DEFAULT '[]'::jsonb, -- [{hours_after:24, template:"..."}, {hours_after:72, ...}]
  followup_max_count int DEFAULT 4,
  followup_active_hours_start time DEFAULT '07:00',
  followup_active_hours_end time DEFAULT '23:30',

  -- Kwalificatie criteria
  qualification_criteria jsonb DEFAULT '{}'::jsonb,
  red_flags jsonb DEFAULT '[]'::jsonb,

  -- Guardrails (always applied, NIET configureerbaar in MVP)
  guardrails_text text,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),
  notes text -- "wat is in deze versie veranderd"
);

CREATE INDEX IF NOT EXISTS idx_lisa_config_active
  ON lisa_config(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_lisa_config_version
  ON lisa_config(version DESC);

-- Trigger: bij is_active=true zetten, deactiveer alle anderen
CREATE OR REPLACE FUNCTION enforce_single_active_lisa_config()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_active = true THEN
    UPDATE lisa_config SET is_active = false
      WHERE id != NEW.id AND is_active = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lisa_config_single_active ON lisa_config;
CREATE TRIGGER trg_lisa_config_single_active
  BEFORE INSERT OR UPDATE ON lisa_config
  FOR EACH ROW EXECUTE FUNCTION enforce_single_active_lisa_config();

COMMENT ON TABLE lisa_config IS
  'Versioned config voor Lisa AI. Snapshot-based, 1 active version. Rollback via SET is_active=true op andere versie.';

-- ============================================
-- TABEL 2: lisa_conversations
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_contact_id text UNIQUE,
  ghl_conversation_id text,
  instagram_handle text,
  contact_name text,
  phase text NOT NULL DEFAULT 'intro'
    CHECK (phase IN ('intro','doel','situatie','band','call','qualified','disqualified','done','cold')),
  qualified boolean NOT NULL DEFAULT false,
  call_booked boolean NOT NULL DEFAULT false,
  disqualified_reason text,
  human_takeover boolean NOT NULL DEFAULT false,
  assigned_human uuid REFERENCES profiles(id),
  is_sandbox boolean NOT NULL DEFAULT false, -- sandbox vs live
  config_version_used uuid REFERENCES lisa_config(id),

  -- Follow-up tracking
  followup_count int NOT NULL DEFAULT 0,
  followup_paused boolean NOT NULL DEFAULT false,
  last_followup_at timestamptz,
  followup_stop_reason text, -- 'user_said_stop'/'max_reached'/'disqualified'/'qualified'
  next_followup_due_at timestamptz, -- voor cron pickup

  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  last_ai_message_at timestamptz,
  last_user_message_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_lisa_conv_ghl_contact ON lisa_conversations(ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_lisa_conv_phase ON lisa_conversations(phase);
CREATE INDEX IF NOT EXISTS idx_lisa_conv_last_message ON lisa_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_lisa_conv_followup_due ON lisa_conversations(next_followup_due_at)
  WHERE next_followup_due_at IS NOT NULL AND followup_paused = false;
CREATE INDEX IF NOT EXISTS idx_lisa_conv_sandbox ON lisa_conversations(is_sandbox);

COMMENT ON TABLE lisa_conversations IS
  'Conversaties met IG volgers (live) of sandbox-test conversaties';

-- ============================================
-- TABEL 3: lisa_messages
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES lisa_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  content text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  ai_generated boolean NOT NULL DEFAULT true,
  human_override boolean NOT NULL DEFAULT false,
  is_followup boolean NOT NULL DEFAULT false, -- markeer als follow-up bericht
  followup_step int, -- 1-5 als follow-up
  ghl_message_id text,

  -- AI metadata
  config_version_id uuid REFERENCES lisa_config(id),
  model_used text, -- 'claude-sonnet-4-...'
  tokens_used int,
  generation_time_ms int,
  detected_phase text -- welke fase Lisa dacht dat we in waren
);

CREATE INDEX IF NOT EXISTS idx_lisa_msg_conv
  ON lisa_messages(conversation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_lisa_msg_ghl
  ON lisa_messages(ghl_message_id) WHERE ghl_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lisa_msg_followup
  ON lisa_messages(is_followup) WHERE is_followup = true;

-- Trigger: update conversatie last_message_at + last_user/ai
CREATE OR REPLACE FUNCTION update_lisa_conv_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE lisa_conversations
  SET last_message_at = NEW.sent_at,
      last_ai_message_at = CASE
        WHEN NEW.direction = 'out' AND NEW.ai_generated
        THEN NEW.sent_at ELSE last_ai_message_at END,
      last_user_message_at = CASE
        WHEN NEW.direction = 'in'
        THEN NEW.sent_at ELSE last_user_message_at END
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lisa_msg_update_conv ON lisa_messages;
CREATE TRIGGER trg_lisa_msg_update_conv
  AFTER INSERT ON lisa_messages
  FOR EACH ROW EXECUTE FUNCTION update_lisa_conv_timestamps();

COMMENT ON TABLE lisa_messages IS 'Berichten-historie incl AI metadata';

-- ============================================
-- TABEL 4: lisa_qualification
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_qualification (
  conversation_id uuid PRIMARY KEY REFERENCES lisa_conversations(id) ON DELETE CASCADE,
  doel text,
  tijd_beschikbaar text,
  ervaring text,
  budget_indicatie text,
  werkstatus text,
  realistische_verwachting boolean,
  red_flags jsonb DEFAULT '[]'::jsonb,
  notities text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_lisa_qual_timestamp()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lisa_qual_updated ON lisa_qualification;
CREATE TRIGGER trg_lisa_qual_updated BEFORE UPDATE ON lisa_qualification
  FOR EACH ROW EXECUTE FUNCTION update_lisa_qual_timestamp();

-- ============================================
-- TABEL 5: lisa_feedback (real-time + achteraf)
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES lisa_messages(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES lisa_conversations(id) ON DELETE CASCADE,
  feedback_type text NOT NULL CHECK (feedback_type IN ('message','conversation')),
  rating text NOT NULL CHECK (rating IN ('good','bad','neutral')),
  reason text, -- "te formeel" / "perfecte timing" / etc
  suggested_response text, -- als 'bad', wat had Lisa moeten zeggen?
  use_as_example boolean DEFAULT false, -- markeer als good/bad voorbeeld in config
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lisa_feedback_msg
  ON lisa_feedback(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lisa_feedback_conv
  ON lisa_feedback(conversation_id);
CREATE INDEX IF NOT EXISTS idx_lisa_feedback_examples
  ON lisa_feedback(use_as_example) WHERE use_as_example = true;

COMMENT ON TABLE lisa_feedback IS
  'Feedback per bericht of conversatie. Markeerbaar als training example.';

-- ============================================
-- TABEL 6: lisa_followups (scheduled queue)
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES lisa_conversations(id) ON DELETE CASCADE,
  followup_step int NOT NULL, -- 1, 2, 3, 4, 5
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','sent','cancelled','skipped')),
  cancelled_reason text,
  template_used text,
  message_id uuid REFERENCES lisa_messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lisa_followups_scheduled
  ON lisa_followups(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_lisa_followups_conv
  ON lisa_followups(conversation_id);

COMMENT ON TABLE lisa_followups IS 'Geplande follow-up berichten queue (door cron opgepakt)';

-- ============================================
-- TABEL 7: lisa_stats (per dag)
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_stats (
  datum date PRIMARY KEY,
  conversaties_gestart int NOT NULL DEFAULT 0,
  conversaties_actief int NOT NULL DEFAULT 0,
  calls_geboekt int NOT NULL DEFAULT 0,
  gequalificeerd int NOT NULL DEFAULT 0,
  gediskwalificeerd int NOT NULL DEFAULT 0,
  no_response int NOT NULL DEFAULT 0,
  followups_verstuurd int NOT NULL DEFAULT 0,
  feedback_good_count int NOT NULL DEFAULT 0,
  feedback_bad_count int NOT NULL DEFAULT 0,
  tokens_used_total int NOT NULL DEFAULT 0,
  fase_distributie jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lisa_stats IS 'Dagelijkse statistieken';

-- ============================================
-- RLS Policies
-- ============================================
ALTER TABLE lisa_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE lisa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lisa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE lisa_qualification ENABLE ROW LEVEL SECURITY;
ALTER TABLE lisa_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE lisa_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE lisa_stats ENABLE ROW LEVEL SECURITY;

-- READ: alle authenticated users
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'lisa_config','lisa_conversations','lisa_messages',
    'lisa_qualification','lisa_feedback','lisa_followups','lisa_stats'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth read %1$s" ON %1$s', t);
    EXECUTE format('CREATE POLICY "auth read %1$s" ON %1$s FOR SELECT TO authenticated USING (true)', t);
  END LOOP;
END $$;

-- WRITE: super_admin only (service role bypasst RLS automatisch)
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'lisa_config','lisa_conversations','lisa_messages',
    'lisa_qualification','lisa_feedback','lisa_followups','lisa_stats'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS "super admin write %1$s" ON %1$s', t);
    EXECUTE format('CREATE POLICY "super admin write %1$s" ON %1$s FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())', t);
  END LOOP;
END $$;

-- ============================================
-- Seed: lege v1 config (placeholder, te vullen via UI)
-- Idempotent: alleen invoegen als er nog géén config bestaat
-- (geen ON CONFLICT — er is geen unique op version, dus dat zou dupliceren).
-- ============================================
INSERT INTO lisa_config (
  version, is_active, persona_name, persona_age, persona_tone,
  guardrails_text, notes
)
SELECT
  1, true, 'Lisa', '25-30', 'vriendelijk en professioneel',
  'Geen rendementen/garanties/druktactieken. Geen specifieke prijzen tenzij expliciet gevraagd.',
  'Initial seed v1. Te vullen via trainings-tool.'
WHERE NOT EXISTS (SELECT 1 FROM lisa_config);

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT COUNT(*) FROM information_schema.tables
--   WHERE table_name LIKE 'lisa_%';  -- moet 7 zijn
-- SELECT COUNT(*) FROM pg_trigger
--   WHERE tgname LIKE 'trg_lisa_%';  -- moet 3 zijn (config single-active, msg→conv, qual updated)
-- SELECT version, is_active FROM lisa_config;  -- moet 1 row, version=1
-- SELECT COUNT(*) FROM pg_policies WHERE tablename LIKE 'lisa_%';  -- 14 (2 per tabel)
