-- 2026-08-10 — Per-klant LMS-provisioning-vinkje op onboardings
--
-- Vervangt de globale env-schakelaar (LMS_PROVISION_ENABLED) door een
-- per-onboarding boolean die de operator per klant aan/uit zet in de
-- aanmeld-modal. Additief, fail-soft, standaard UIT: bestaande rijen en
-- nieuwe aanmeldingen zonder expliciete keuze krijgen false → dan verandert
-- er niets aan de bestaande Bubble-flow.
--
-- De code leest deze kolom in onboarding-provision.js: het LMS-blok draait
-- ALLEEN wanneer onboarding.lms_provision === true. De select is defensief —
-- als deze migratie nog niet gedraaid is, valt het LMS-deel gewoon fail-soft
-- weg (geen crash), maar de feature werkt pas ná deze migratie.
--
-- Idempotent (IF NOT EXISTS): meermaals draaien is veilig.

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS lms_provision boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.onboardings.lms_provision IS
  'Per-klant schakelaar: ook een account in het nieuwe LMS aanmaken naast Bubble. Standaard false.';

-- ── CONTROLE ACHTERAF (read-only) ───────────────────────────────────────────
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'onboardings'
--     AND column_name = 'lms_provision';

-- ============================================================================
-- ROLLBACK (kolom verwijderen)
-- ============================================================================
-- ALTER TABLE public.onboardings DROP COLUMN IF EXISTS lms_provision;
