-- ============================================================================
-- Wizard 1 redesign: deal → offerte (quotation) flow
-- Datum: 2026-05-31
-- Branch: feature/wizard-offerte-flow
--
-- - deals: TL-quotation tracking-kolommen (los van bestaande tl_deal_id/
--   tl_push_status die voor de subscription-push in Wizard 2 blijven).
-- - deal_line_items: persisteert de offerte-regels (producten) zodat
--   pushQuotationToTl ze als grouped_lines naar TL kan sturen.
-- ============================================================================

BEGIN;

-- ── A. deals — quotation tracking ───────────────────────────────────────────
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS tl_quotation_id        text,
  ADD COLUMN IF NOT EXISTS tl_quotation_status    text DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS tl_quotation_sent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS tl_quotation_signed_at timestamptz;

ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS deals_tl_quotation_status_check;
ALTER TABLE public.deals
  ADD CONSTRAINT deals_tl_quotation_status_check
  CHECK (tl_quotation_status IS NULL OR tl_quotation_status IN
    ('draft','sent','signed','declined','expired'));

-- ── B. deal_line_items — offerte-regels (producten) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.deal_line_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES public.products(id) ON DELETE SET NULL,
  product_name    text NOT NULL,
  quantity        numeric(10,2) NOT NULL DEFAULT 1,
  unit_price      numeric(10,2) NOT NULL DEFAULT 0,
  vat_percentage  smallint NOT NULL DEFAULT 21 CHECK (vat_percentage IN (0, 9, 21)),
  position        smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deal_line_items_deal ON public.deal_line_items (deal_id);

-- ── C. RLS — authenticated-read, service_role-write ─────────────────────────
ALTER TABLE public.deal_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_line_items_select ON public.deal_line_items;
DROP POLICY IF EXISTS deal_line_items_insert ON public.deal_line_items;
DROP POLICY IF EXISTS deal_line_items_update ON public.deal_line_items;
DROP POLICY IF EXISTS deal_line_items_delete ON public.deal_line_items;
CREATE POLICY deal_line_items_select ON public.deal_line_items FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY deal_line_items_insert ON public.deal_line_items FOR INSERT WITH CHECK (false);
CREATE POLICY deal_line_items_update ON public.deal_line_items FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY deal_line_items_delete ON public.deal_line_items FOR DELETE USING (false);

COMMIT;

-- ROLLBACK
-- BEGIN;
--   DROP TABLE IF EXISTS public.deal_line_items;
--   ALTER TABLE public.deals
--     DROP CONSTRAINT IF EXISTS deals_tl_quotation_status_check,
--     DROP COLUMN IF EXISTS tl_quotation_signed_at,
--     DROP COLUMN IF EXISTS tl_quotation_sent_at,
--     DROP COLUMN IF EXISTS tl_quotation_status,
--     DROP COLUMN IF EXISTS tl_quotation_id;
-- COMMIT;
