-- ============================================================================
-- WhatsApp Module Config — Module->Phone Number ID mapping
-- Datum: 2026-06-08
-- Branch: feat/whatsapp-module-mapping-admin
--
-- Doel:
--   Introduceert een DB-backed registry waarmee admins per module (finance,
--   sales, support, ...) kunnen kiezen welke Meta WABA-phone-line (phone_number_id)
--   gebruikt wordt voor uitgaande WhatsApp Cloud API berichten. Tot dusver
--   was er enkel 1 env-var META_WHATSAPP_PHONE_NUMBER_ID (single line).
--
--   Daarnaast: registreer per inbound conversation welke WABA-lijn het bericht
--   binnenkreeg (phone_number_id) zodat antwoord-routing en multi-line-overzicht
--   later mogelijk worden.
--
-- Idempotent: BEGIN/COMMIT, IF NOT EXISTS / ON CONFLICT.
-- Veilig om opnieuw te draaien.
--
-- ── Verifie-queries na uitvoeren ────────────────────────────────────────────
-- SELECT module, phone_number_id, display_label, is_active
--   FROM whatsapp_module_config ORDER BY module;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='whatsapp_conversations' AND column_name='phone_number_id';
-- SELECT polname, polcmd FROM pg_policies WHERE tablename='whatsapp_module_config';
-- ============================================================================

BEGIN;

-- ── A. whatsapp_module_config (module -> phone_number_id mapping) ───────────
CREATE TABLE IF NOT EXISTS public.whatsapp_module_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module              text NOT NULL UNIQUE,
  phone_number_id     text NOT NULL,
  display_label       text NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_module_config IS
  'Mapping van interne module-naam (finance, sales, ...) naar Meta WABA phone_number_id voor outbound WhatsApp Cloud API berichten.';
COMMENT ON COLUMN public.whatsapp_module_config.module IS
  'Interne module-key (lowercase, snake-case). Bv. finance, sales, support.';
COMMENT ON COLUMN public.whatsapp_module_config.phone_number_id IS
  'Meta WABA phone_number_id (string van cijfers, exact zoals door Meta uitgegeven).';
COMMENT ON COLUMN public.whatsapp_module_config.display_label IS
  'Human-readable label voor admin-UI, bv. "Finance" of "Sales-team NL".';

CREATE INDEX IF NOT EXISTS idx_wa_module_active
  ON public.whatsapp_module_config (module)
  WHERE is_active = true;

-- ── B. whatsapp_conversations: track ontvangende WABA-lijn ──────────────────
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS phone_number_id text;

COMMENT ON COLUMN public.whatsapp_conversations.phone_number_id IS
  'Meta WABA phone_number_id van de lijn waarop dit gesprek binnenkwam. NULL voor legacy rijen.';

CREATE INDEX IF NOT EXISTS idx_wa_conv_phone_number_id
  ON public.whatsapp_conversations (phone_number_id);

-- ── C. updated_at trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_module_config_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_whatsapp_module_config_updated_at
  ON public.whatsapp_module_config;
CREATE TRIGGER trg_whatsapp_module_config_updated_at
  BEFORE UPDATE ON public.whatsapp_module_config
  FOR EACH ROW
  EXECUTE FUNCTION public.whatsapp_module_config_set_updated_at();

-- ── D. RLS ─────────────────────────────────────────────────────────────────
-- Read: authenticated users (UI moet kunnen lezen voor admin-overzicht).
-- Write: alleen service-role (geen INSERT/UPDATE/DELETE policy = blocked
-- voor authenticated; admin-mutaties gaan via server-side endpoint met
-- service-role key + verifyAdmin gate).
ALTER TABLE public.whatsapp_module_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_module_config_read_authenticated
  ON public.whatsapp_module_config;
CREATE POLICY whatsapp_module_config_read_authenticated
  ON public.whatsapp_module_config
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS whatsapp_module_config_no_write
  ON public.whatsapp_module_config;
CREATE POLICY whatsapp_module_config_no_write
  ON public.whatsapp_module_config
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- ── E. Seed: finance -> productie phone_number_id ──────────────────────────
INSERT INTO public.whatsapp_module_config
  (module, phone_number_id, display_label, is_active)
VALUES
  ('finance', '1178453785351177', 'Finance', true)
ON CONFLICT (module) DO NOTHING;

COMMIT;
