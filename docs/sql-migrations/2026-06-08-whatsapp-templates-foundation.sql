-- ============================================================================
-- WhatsApp Templates Foundation (Module C1)
-- Datum: 2026-06-08
-- Branch: feat/whatsapp-templates-c1-foundation
--
-- Doel:
--   Fundament voor het WhatsApp Templates beheer:
--     1) business_account_id kolom op whatsapp_module_config (multi-WABA ready
--        + sync-target per module).
--     2) whatsapp_meta_templates: lokaal beheerde Meta WhatsApp Cloud API
--        templates (UTILITY/MARKETING/AUTHENTICATION) met submit/approve
--        flow naar Meta.
--     3) whatsapp_quick_replies: vrije quick-replies (eigen tekst, geen Meta
--        approval) per WABA, voor snelle reactie in Inbox.
--
-- RLS:
--   Read: alle authenticated users (UI moet kunnen lezen).
--   Write: alleen service-role (geen INSERT/UPDATE/DELETE policy voor
--   authenticated; admin-mutaties gaan via server-side endpoint met
--   verifyAdmin + service-role key).
--
-- Idempotent: BEGIN/COMMIT, IF NOT EXISTS / DROP ... IF EXISTS.
-- Veilig om opnieuw te draaien.
--
-- ── Verifie-queries na uitvoeren ────────────────────────────────────────────
-- SELECT module, phone_number_id, business_account_id, display_label
--   FROM whatsapp_module_config ORDER BY module;
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('whatsapp_meta_templates','whatsapp_quick_replies');
-- SELECT polname, polcmd FROM pg_policies
--   WHERE tablename IN ('whatsapp_meta_templates','whatsapp_quick_replies');
-- ============================================================================

BEGIN;

-- ── A. business_account_id op whatsapp_module_config ───────────────────────
ALTER TABLE public.whatsapp_module_config
  ADD COLUMN IF NOT EXISTS business_account_id text;

COMMENT ON COLUMN public.whatsapp_module_config.business_account_id IS
  'Meta WABA Business Account ID (de account waar phone_number_id onder valt). Maakt multi-WABA setup mogelijk; voor single-WABA setups gelijk aan META_WHATSAPP_BUSINESS_ACCOUNT_ID env.';

CREATE INDEX IF NOT EXISTS idx_wa_module_business_account
  ON public.whatsapp_module_config (business_account_id)
  WHERE business_account_id IS NOT NULL;

-- Backfill finance-row met productie WABA-id.
UPDATE public.whatsapp_module_config
   SET business_account_id = '990429800401598'
 WHERE module = 'finance'
   AND business_account_id IS NULL;

-- ── B. whatsapp_meta_templates ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_meta_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_account_id text NOT NULL,
  meta_template_id    text,
  name                text NOT NULL,
  language            text NOT NULL DEFAULT 'nl',
  category            text NOT NULL DEFAULT 'UTILITY'
    CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
  header_type         text DEFAULT 'NONE'
    CHECK (header_type IN ('NONE','TEXT','IMAGE','VIDEO','DOCUMENT')),
  header_content      jsonb,
  body_text           text NOT NULL,
  body_examples       jsonb,
  footer_text         text,
  buttons             jsonb,
  status              text NOT NULL DEFAULT 'LOCAL'
    CHECK (status IN ('LOCAL','SUBMITTED','APPROVED','REJECTED','PAUSED','DISABLED')),
  rejection_reason    text,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  last_synced_at      timestamptz,
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_account_id, name, language)
);

COMMENT ON TABLE public.whatsapp_meta_templates IS
  'Lokaal beheerde Meta WhatsApp Cloud API templates. Submit/approve flow naar Meta; status reflecteert Meta-status na sync.';
COMMENT ON COLUMN public.whatsapp_meta_templates.business_account_id IS
  'Meta WABA Business Account ID waaronder deze template valt.';
COMMENT ON COLUMN public.whatsapp_meta_templates.meta_template_id IS
  'Meta-zijde template ID (na succesvolle SUBMIT). NULL voor LOCAL-status.';
COMMENT ON COLUMN public.whatsapp_meta_templates.name IS
  'Template-naam (lowercase, snake_case, max 512 chars per Meta-spec).';
COMMENT ON COLUMN public.whatsapp_meta_templates.language IS
  'BCP-47 language code (nl, en_US, etc.).';
COMMENT ON COLUMN public.whatsapp_meta_templates.body_examples IS
  'JSON-array met voorbeeldwaarden voor placeholders ({{1}}, {{2}}, ...) — vereist door Meta bij templates met variabelen.';
COMMENT ON COLUMN public.whatsapp_meta_templates.buttons IS
  'JSON-array met button-definities (QUICK_REPLY / URL / PHONE_NUMBER per Meta-spec).';

CREATE INDEX IF NOT EXISTS idx_wa_meta_tmpl_waba
  ON public.whatsapp_meta_templates (business_account_id, status);

-- ── C. whatsapp_quick_replies ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_quick_replies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_account_id text NOT NULL,
  title               text NOT NULL,
  body_text           text NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_quick_replies IS
  'Vrije quick-replies per WABA voor snelle reactie in Inbox. Geen Meta-approval; tekst wordt 1-op-1 als free-form bericht verstuurd binnen 24u-venster.';
COMMENT ON COLUMN public.whatsapp_quick_replies.title IS
  'Korte titel voor de quick-reply (zichtbaar in Inbox UI bij selecteren).';
COMMENT ON COLUMN public.whatsapp_quick_replies.sort_order IS
  'Volgorde in de UI lijst (lager = bovenaan).';

CREATE INDEX IF NOT EXISTS idx_wa_qr_waba_active
  ON public.whatsapp_quick_replies (business_account_id, is_active, sort_order);

-- ── D. updated_at triggers ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_meta_templates_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_whatsapp_meta_templates_updated_at
  ON public.whatsapp_meta_templates;
CREATE TRIGGER trg_whatsapp_meta_templates_updated_at
  BEFORE UPDATE ON public.whatsapp_meta_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.whatsapp_meta_templates_set_updated_at();

CREATE OR REPLACE FUNCTION public.whatsapp_quick_replies_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_whatsapp_quick_replies_updated_at
  ON public.whatsapp_quick_replies;
CREATE TRIGGER trg_whatsapp_quick_replies_updated_at
  BEFORE UPDATE ON public.whatsapp_quick_replies
  FOR EACH ROW
  EXECUTE FUNCTION public.whatsapp_quick_replies_set_updated_at();

-- ── E. RLS: whatsapp_meta_templates ────────────────────────────────────────
ALTER TABLE public.whatsapp_meta_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_meta_templates_read_authenticated
  ON public.whatsapp_meta_templates;
CREATE POLICY whatsapp_meta_templates_read_authenticated
  ON public.whatsapp_meta_templates
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS whatsapp_meta_templates_no_write
  ON public.whatsapp_meta_templates;
CREATE POLICY whatsapp_meta_templates_no_write
  ON public.whatsapp_meta_templates
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- ── F. RLS: whatsapp_quick_replies ─────────────────────────────────────────
ALTER TABLE public.whatsapp_quick_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_quick_replies_read_authenticated
  ON public.whatsapp_quick_replies;
CREATE POLICY whatsapp_quick_replies_read_authenticated
  ON public.whatsapp_quick_replies
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS whatsapp_quick_replies_no_write
  ON public.whatsapp_quick_replies;
CREATE POLICY whatsapp_quick_replies_no_write
  ON public.whatsapp_quick_replies
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

COMMIT;
