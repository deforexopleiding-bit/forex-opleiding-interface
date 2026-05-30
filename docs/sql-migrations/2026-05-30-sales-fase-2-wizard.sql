-- ============================================================================
-- Sales Fase 2: productcatalogus + wizard-drafts + Teamleader OAuth
-- Datum: 2026-05-30
-- Branch: feature/sales-fase-2-wizard
--
-- 3 nieuwe tabellen + uitbreidingen op deals + indexes op customers + RLS.
-- ============================================================================

BEGIN;

-- ── A. products — catalogus die Dave gebruikt in wizard ─────────────────────
CREATE TABLE IF NOT EXISTS public.products (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  description               text,
  vat_percentage            smallint NOT NULL CHECK (vat_percentage IN (0, 9, 21)),
  default_price             numeric(10,2),
  default_duration_months   integer,
  category                  text,
  tl_product_id             text,
  is_active                 boolean NOT NULL DEFAULT true,
  archived_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_active   ON public.products (is_active);
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products (category);

-- ── B. sales_wizard_drafts — auto-save per user ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_wizard_drafts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  draft_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_step    smallint NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_wizard_drafts_user ON public.sales_wizard_drafts (user_id);

-- ── C. teamleader_oauth_tokens — 1 actieve token (latest wins) ──────────────
CREATE TABLE IF NOT EXISTS public.teamleader_oauth_tokens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token             text NOT NULL,
  refresh_token            text NOT NULL,
  expires_at               timestamptz NOT NULL,
  token_type               text NOT NULL DEFAULT 'Bearer',
  scope                    text,
  authorized_by_user_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  authorized_at            timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tl_tokens_expires ON public.teamleader_oauth_tokens (expires_at);

-- ── D. KOLOM-UITBREIDING deals (TL-push status) ─────────────────────────────
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS source_lead_id uuid REFERENCES public.lead_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tl_deal_id text,
  ADD COLUMN IF NOT EXISTS tl_pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS tl_push_status text DEFAULT 'not_pushed',
  ADD COLUMN IF NOT EXISTS tl_push_error text;
-- CHECK constraint apart, defensive (oude rijen kunnen NULL hebben).
ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS deals_tl_push_status_check;
ALTER TABLE public.deals
  ADD CONSTRAINT deals_tl_push_status_check
  CHECK (tl_push_status IS NULL OR tl_push_status IN ('pending','synced','failed','not_pushed'));

-- ── E. INDEXES op customers voor duplicate-check performance ────────────────
CREATE INDEX IF NOT EXISTS idx_customers_email ON public.customers (lower(email));
CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers (phone);

-- ── F. RLS — authenticated-read, service_role-write ─────────────────────────
DO $$
DECLARE
  t text;
  tabs text[] := ARRAY['products', 'sales_wizard_drafts', 'teamleader_oauth_tokens'];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON public.%I', t, t);
    -- SELECT: alle authenticated users. Drafts: alleen eigen rij.
    IF t = 'sales_wizard_drafts' THEN
      EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (user_id = auth.uid())', t, t);
    ELSIF t = 'teamleader_oauth_tokens' THEN
      -- OAuth-tokens zijn gevoelig: alleen via service_role.
      EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (false)', t, t);
    ELSE
      EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (auth.uid() IS NOT NULL)', t, t);
    END IF;
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (false)', t, t);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (false) WITH CHECK (false)', t, t);
    EXECUTE format('CREATE POLICY %I_delete ON public.%I FOR DELETE USING (false)', t, t);
  END LOOP;
END$$;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deals
--     DROP CONSTRAINT IF EXISTS deals_tl_push_status_check,
--     DROP COLUMN IF EXISTS tl_push_error,
--     DROP COLUMN IF EXISTS tl_push_status,
--     DROP COLUMN IF EXISTS tl_pushed_at,
--     DROP COLUMN IF EXISTS tl_deal_id,
--     DROP COLUMN IF EXISTS source_lead_id;
--   DROP INDEX IF EXISTS public.idx_customers_email;
--   DROP INDEX IF EXISTS public.idx_customers_phone;
--   DROP TABLE IF EXISTS public.teamleader_oauth_tokens;
--   DROP TABLE IF EXISTS public.sales_wizard_drafts;
--   DROP TABLE IF EXISTS public.products;
-- COMMIT;
