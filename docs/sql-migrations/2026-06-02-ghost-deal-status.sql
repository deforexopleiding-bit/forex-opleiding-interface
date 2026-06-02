-- ============================================================================
-- Ghost-deal status voor 'abonnement zonder offerte' (PUNT 1)
-- Datum: 2026-06-02
-- Branch: feature/subscriptions-big-upgrade
--
-- Standalone abonnementen krijgen een 'ghost' deal (voor consistentie: subs
-- hangen altijd onder een deal). Die deal heeft geen offerte → nieuwe
-- status-waarde 'no_quotation'. De CHECK-constraint moet die waarde toelaten,
-- anders faalt de insert. (Lesson learned: nieuwe enum-waardes => ALTER
-- constraint EERST.)
-- ============================================================================

BEGIN;

ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS deals_tl_quotation_status_check;
ALTER TABLE public.deals
  ADD CONSTRAINT deals_tl_quotation_status_check
  CHECK (tl_quotation_status IS NULL OR tl_quotation_status IN
    ('draft','sent','accepted','declined','expired','signed','no_quotation'));

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_tl_quotation_status_check;
--   ALTER TABLE public.deals ADD CONSTRAINT deals_tl_quotation_status_check
--     CHECK (tl_quotation_status IS NULL OR tl_quotation_status IN
--       ('draft','sent','accepted','declined','expired','signed'));
-- COMMIT;
