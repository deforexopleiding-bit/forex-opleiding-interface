-- ============================================================================
-- Bedrijfsentiteit-keuze: deals.tl_department_id + company_entities lookup
-- Datum: 2026-05-31
-- Branch: feature/quotation-substitution-and-department
--
-- Wizard-stap 0 laat Dave kiezen onder welke entiteit de offerte valt.
-- Dit bepaalt het TL department_id voor contact/deal/quotation creatie.
-- ============================================================================

BEGIN;

-- ── A. deals — gekozen TL-department ────────────────────────────────────────
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS tl_department_id text;

-- ── B. company_entities — statische lookup (zelfde IDs als TL departments) ──
CREATE TABLE IF NOT EXISTS public.company_entities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tl_department_id text UNIQUE NOT NULL,
  name             text NOT NULL,
  label            text NOT NULL,
  description      text,
  display_order    smallint DEFAULT 100,
  is_active        boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE public.company_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_entities_select ON public.company_entities;
DROP POLICY IF EXISTS company_entities_write ON public.company_entities;
CREATE POLICY company_entities_select ON public.company_entities
  FOR SELECT USING (auth.uid() IS NOT NULL);
-- Schrijven uitsluitend via service_role (RLS bypass), geen policy nodig.
CREATE POLICY company_entities_write ON public.company_entities
  FOR ALL USING (false) WITH CHECK (false);

-- ── C. Seed: 3 verkoop-entiteiten (NIET The Forex Education) ────────────────
INSERT INTO public.company_entities (tl_department_id, name, label, description, display_order) VALUES
  ('09d67371-6947-03f6-bd5e-410dd8636344', 'online',   'De Forex Opleiding (Online)',  'Hoofdentiteit voor online cursussen',          10),
  ('0da396bf-1074-0425-ac5c-fa1141b41cb1', 'fysiek',   'De Forex Opleiding (Fysiek)',  'Fysieke cursussen op locatie',                 20),
  ('9adca043-0ebc-09da-a45e-f21798841cb2', 'retentie', 'De Forex Opleiding (Retentie)', 'Retentie + upsells bestaande klanten',        30)
ON CONFLICT (tl_department_id) DO UPDATE
  SET name = EXCLUDED.name, label = EXCLUDED.label,
      description = EXCLUDED.description, display_order = EXCLUDED.display_order;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   DROP TABLE IF EXISTS public.company_entities;
--   ALTER TABLE public.deals DROP COLUMN IF EXISTS tl_department_id;
-- COMMIT;
