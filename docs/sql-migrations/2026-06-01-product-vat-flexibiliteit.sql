-- ============================================================================
-- Productregel BTW-flexibiliteit: prijs incl. of excl. BTW per product/regel
-- Datum: 2026-06-01
-- Branch: feature/offerte-verbeteringen-batch
-- ============================================================================

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS price_includes_vat boolean NOT NULL DEFAULT false;

ALTER TABLE public.deal_line_items
  ADD COLUMN IF NOT EXISTS price_includes_vat boolean NOT NULL DEFAULT false;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deal_line_items DROP COLUMN IF EXISTS price_includes_vat;
--   ALTER TABLE public.products DROP COLUMN IF EXISTS price_includes_vat;
-- COMMIT;
