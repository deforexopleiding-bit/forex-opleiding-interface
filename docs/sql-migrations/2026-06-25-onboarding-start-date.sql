-- ============================================================================
-- Onboarding — start_date kolom voor "gratis gap"-periode.
-- Datum: 2026-06-25
-- Branch: feat/onboarding-startdate-enddate
--
-- Doel:
--   onboardings.start_date houdt de (eventueel toekomstige) startdatum van
--   de cursus bij. Bij Bubble-provisioning bepaalt deze waarde de
--   einddatum: end = max(now, start_date) + duur_maanden. Toegang
--   (membership_state_date_date) blijft 'nu' — klant krijgt de gap
--   tussen aanmelden en startdatum gratis bovenop de volle looptijd.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- Geen wijziging aan bestaande data; bestaande onboardings krijgen NULL.
-- NULL = identiek aan oud gedrag (basis = now).
-- ============================================================================

BEGIN;

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS start_date date;

COMMENT ON COLUMN public.onboardings.start_date IS
  'Cursus-startdatum (uit de offerte; door admin aanpasbaar bij aanmelden). '
  'Wordt door api/_lib/onboarding-provision.js gebruikt om de Bubble-einddatum '
  'te berekenen: end = max(now, start_date) + duur_maanden. Toegang start '
  'altijd direct (membership_state_date_date = now). NULL = identiek aan oud '
  'gedrag (basis = now).';

COMMIT;

-- Verificatie:
--   SELECT id, start_date, created_at FROM public.onboardings
--   WHERE start_date IS NOT NULL ORDER BY created_at DESC LIMIT 5;
--
-- ROLLBACK:
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS start_date;
