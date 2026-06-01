-- ============================================================================
-- Optionele betalingsvoorwaarden op de offerte (Wizard 1 stap 4)
-- Datum: 2026-05-31
-- Branch: feature/quotation-payment-terms
--
-- Alle velden nullable/optioneel. Gebruikt voor:
--  - genereren van een leesbare TL quotation/deal-titel
--  - hergebruik als startwaarden in Wizard 2 (subscription-creatie)
-- ============================================================================

BEGIN;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS payment_start_date         date,
  ADD COLUMN IF NOT EXISTS payment_downpayment_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS payment_downpayment_date   date,
  ADD COLUMN IF NOT EXISTS payment_term_count         smallint,
  ADD COLUMN IF NOT EXISTS payment_term_start_date    date,
  ADD COLUMN IF NOT EXISTS payment_term_amount        numeric(10,2);

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deals
--     DROP COLUMN IF EXISTS payment_term_amount,
--     DROP COLUMN IF EXISTS payment_term_start_date,
--     DROP COLUMN IF EXISTS payment_term_count,
--     DROP COLUMN IF EXISTS payment_downpayment_date,
--     DROP COLUMN IF EXISTS payment_downpayment_amount,
--     DROP COLUMN IF EXISTS payment_start_date;
-- COMMIT;
