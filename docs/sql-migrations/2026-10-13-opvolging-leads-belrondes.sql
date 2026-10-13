-- ============================================================================
-- Opvolging · Leads bellen — belrondes en uitkomstlogboek
-- 13 oktober 2026
--
-- Puur toevoegend, niets bestaands verandert. Idempotent.
--
-- 1. opvolging_taken.volgende_poging_at — een zelfgekozen moment voor de
--    volgende poging ('probeer vanavond opnieuw'). NULL = de belcadans beslist
--    op basis van de belpogingen (api/_lib/opvolging-leads-pot.js belPlan()).
-- 2. opvolging_taken.uitkomst_log — wat Dave na een call aanklikte (geen
--    gehoor, voicemail, gesproken, foutief nummer), terugbelafspraken,
--    afrondingen. Voedt het logboek in Leads bellen en de startdag van een
--    terugbelafspraak.
--
-- ⚠ BLOKKEREND voor de PR 'Leads bellen: belrondes': opvolging-taak-update
--   schrijft deze kolommen bij naam. Eerst draaien, dan mergen.
--
-- TERUGDRAAIEN:
--   ALTER TABLE public.opvolging_taken DROP COLUMN IF EXISTS volgende_poging_at,
--     DROP COLUMN IF EXISTS uitkomst_log;
-- ============================================================================

ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS volgende_poging_at timestamptz NULL;
ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS uitkomst_log jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.opvolging_taken.volgende_poging_at IS
  'Leads bellen: zelfgekozen moment voor de volgende poging. NULL = belcadans uit de pogingen.';
COMMENT ON COLUMN public.opvolging_taken.uitkomst_log IS
  'Leads bellen: [{op, soort, tekst, due?, wanneer?}] — uitkomsten na calls, terugbelafspraken, afrondingen.';

-- Nakijken:
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--  WHERE table_name = 'opvolging_taken' AND column_name IN ('volgende_poging_at','uitkomst_log');
