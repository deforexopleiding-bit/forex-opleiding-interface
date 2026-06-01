-- ============================================================================
-- Trajecten: bundels van producten met varianten (bv 'Membership > Premium 36mnd')
-- Datum: 2026-06-01
-- Branch: feature/trajecten-en-8-fixes
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.trajects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  display_order smallint DEFAULT 100,
  is_active     boolean DEFAULT true,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.traject_variants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traject_id              uuid NOT NULL REFERENCES public.trajects(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  description             text,
  default_duration_months integer,
  display_order           smallint DEFAULT 100,
  is_default              boolean DEFAULT false,
  is_active               boolean DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_traject_variants_traject ON public.traject_variants (traject_id);

CREATE TABLE IF NOT EXISTS public.traject_variant_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id  uuid NOT NULL REFERENCES public.traject_variants(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity    numeric(10,2) DEFAULT 1,
  sort_order  smallint DEFAULT 100
);
CREATE INDEX IF NOT EXISTS idx_tvp_variant ON public.traject_variant_products (variant_id);

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS traject_variant_id uuid REFERENCES public.traject_variants(id) ON DELETE SET NULL;

-- ── RLS — authenticated-read, service_role-write ────────────────────────────
DO $$
DECLARE
  t text;
  tabs text[] := ARRAY['trajects', 'traject_variants', 'traject_variant_products'];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (auth.uid() IS NOT NULL)', t, t);
    EXECUTE format('CREATE POLICY %I_write ON public.%I FOR ALL USING (false) WITH CHECK (false)', t, t);
  END LOOP;
END$$;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deals DROP COLUMN IF EXISTS traject_variant_id;
--   DROP TABLE IF EXISTS public.traject_variant_products;
--   DROP TABLE IF EXISTS public.traject_variants;
--   DROP TABLE IF EXISTS public.trajects;
-- COMMIT;
