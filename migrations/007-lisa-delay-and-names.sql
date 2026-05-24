-- 007-lisa-delay-and-names.sql
-- Lisa F10 — Menselijke response-delay (settings) + uitgebreide contact-naamvelden.
-- Idempotent. Uitvoeren in Supabase SQL Editor (één keer; herhaalbaar).
-- Vereist: lisa_settings (005) + lisa_conversations (003/005).

BEGIN;

-- ============================================
-- lisa_settings: response-delay configuratie
-- ============================================
ALTER TABLE lisa_settings
  -- Delay-modus: 'fixed' (vast) / 'random' (tussen min-max) / 'per_phase' (per fase)
  ADD COLUMN IF NOT EXISTS response_delay_mode text NOT NULL DEFAULT 'random'
    CHECK (response_delay_mode IN ('fixed', 'random', 'per_phase')),
  ADD COLUMN IF NOT EXISTS response_delay_fixed_seconds int NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS response_delay_min_seconds int NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS response_delay_max_seconds int NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS response_delay_per_phase jsonb NOT NULL
    DEFAULT '{"intro":30,"doel":60,"situatie":75,"band":60,"call":45}'::jsonb,
  ADD COLUMN IF NOT EXISTS typing_indicator_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN lisa_settings.response_delay_mode IS
  'fixed: vaste seconden / random: random tussen min-max / per_phase: per fase verschillend';
COMMENT ON COLUMN lisa_settings.response_delay_per_phase IS
  'JSONB object {phase: seconden}. Keys: intro/doel/situatie/band/call';
COMMENT ON COLUMN lisa_settings.typing_indicator_enabled IS
  'Stuur GHL typing-event tijdens de delay zodat de volger Lisa ziet typen.';

-- ============================================
-- lisa_conversations: extra naam-/IG-velden (contact_name + instagram_handle bestaan al uit 003)
-- ============================================
ALTER TABLE lisa_conversations
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS instagram_handle_full text,
  ADD COLUMN IF NOT EXISTS ig_sid text;

COMMENT ON COLUMN lisa_conversations.first_name IS
  'Voornaam uit GHL-contact (webhook first_name).';
COMMENT ON COLUMN lisa_conversations.ig_sid IS
  'Instagram Session ID uit GHL contact.attributionSource.igSid (voor IG deep-links).';

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT response_delay_mode, response_delay_fixed_seconds, response_delay_min_seconds,
--        response_delay_max_seconds, response_delay_per_phase, typing_indicator_enabled
--   FROM lisa_settings WHERE id = 1;
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='lisa_conversations'
--     AND column_name IN ('first_name','last_name','instagram_handle_full','ig_sid');
