-- 005-lisa-live-mode.sql
-- Lisa F5 — Live mode + delayed messages (buiten kantooruren vooraf genereren).
-- Idempotent. Uitvoeren in Supabase SQL Editor (één keer; herhaalbaar).
-- Vereist: public.is_super_admin() uit migratie 002; lisa_* tabellen uit migratie 003.
--
-- LET OP (env): zet LISA_WEBHOOK_SECRET in Vercel → Settings → Environment Variables
-- (genereer met bv. `openssl rand -hex 32`). Wordt gebruikt door de GHL-webhook (latere F5-stap).

BEGIN;

-- ============================================
-- TABEL: lisa_settings (runtime settings, NIET versioned — singleton id=1)
-- Cross-version: blijft bij config-rollback intact.
-- ============================================
CREATE TABLE IF NOT EXISTS lisa_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Live mode
  live_mode_enabled boolean NOT NULL DEFAULT false,
  live_mode_changed_at timestamptz,
  live_mode_changed_by uuid REFERENCES profiles(id),

  -- Kantooruren
  office_hours_start time NOT NULL DEFAULT '07:00',
  office_hours_end time NOT NULL DEFAULT '23:30',
  office_hours_timezone text NOT NULL DEFAULT 'Europe/Amsterdam',

  -- GHL integratie metadata
  ghl_webhook_active boolean NOT NULL DEFAULT false,
  ghl_webhook_last_received_at timestamptz,
  ghl_webhook_last_error text,
  ghl_webhook_total_received int NOT NULL DEFAULT 0,

  -- Tellers
  live_messages_sent_total int NOT NULL DEFAULT 0,
  live_messages_received_total int NOT NULL DEFAULT 0,
  delayed_messages_pending int NOT NULL DEFAULT 0,

  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lisa_settings IS
  'Singleton runtime settings voor Lisa. Cross-version: blijft bij rollback intact. Slechts 1 row (id=1).';

-- Seed: default singleton (idempotent)
INSERT INTO lisa_settings (id)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM lisa_settings);

-- Trigger: auto updated_at + registreer live_mode wissel
CREATE OR REPLACE FUNCTION lisa_settings_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  IF TG_OP = 'UPDATE' AND OLD.live_mode_enabled IS DISTINCT FROM NEW.live_mode_enabled THEN
    NEW.live_mode_changed_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lisa_settings_updated ON lisa_settings;
CREATE TRIGGER trg_lisa_settings_updated
  BEFORE UPDATE ON lisa_settings
  FOR EACH ROW EXECUTE FUNCTION lisa_settings_update_timestamp();

-- ============================================
-- ALTER: lisa_followups — delayed messages
-- ============================================
ALTER TABLE lisa_followups
  ADD COLUMN IF NOT EXISTS is_delayed_response boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pre_generated_response text,
  ADD COLUMN IF NOT EXISTS pre_generated_at timestamptz;

COMMENT ON COLUMN lisa_followups.is_delayed_response IS
  'Delayed: AI-antwoord vooraf gegenereerd buiten kantooruren, verstuurd bij start kantooruren.';
COMMENT ON COLUMN lisa_followups.pre_generated_response IS
  'AI-gegenereerd antwoord (klaar om te versturen) voor delayed messages.';

-- ============================================
-- ALTER: lisa_conversations — live tracking
-- ============================================
ALTER TABLE lisa_conversations
  ADD COLUMN IF NOT EXISTS ghl_location_id text,
  ADD COLUMN IF NOT EXISTS first_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS qualified_at timestamptz,
  ADD COLUMN IF NOT EXISTS call_booked_at timestamptz,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'instagram'
    CHECK (source IN ('instagram','whatsapp','sandbox','manual'));

CREATE INDEX IF NOT EXISTS idx_lisa_conv_source ON lisa_conversations(source);

-- ============================================
-- RLS policies (lisa_settings)
-- ============================================
ALTER TABLE lisa_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth read lisa_settings" ON lisa_settings;
CREATE POLICY "auth read lisa_settings" ON lisa_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "super admin write lisa_settings" ON lisa_settings;
CREATE POLICY "super admin write lisa_settings" ON lisa_settings
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT * FROM lisa_settings;  -- 1 row, live_mode_enabled = false
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_followups'
--     AND column_name IN ('is_delayed_response','pre_generated_response','pre_generated_at');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_conversations'
--     AND column_name IN ('ghl_location_id','first_message_at','qualified_at','call_booked_at','source');
