-- ============================================================================
-- Finance Fase 2A — Facturen read-only TL-spiegel (mini-migratie)
-- Datum: 2026-06-04
-- Additief op de bestaande `invoices`-tabel (PR #40, 2026-05-30 fundament).
-- Idempotent: veilig meermaals te draaien.
--
-- Toepassen: Supabase SQL Editor (productie) — consistent met eerdere manuele
-- migraties. Daarna verifieer-queries onderaan draaien.
-- ============================================================================

-- 1) Entiteit/department-kolom op invoices (welke TL-department de factuur uitgaf).
--    Koppelt op company_entities.tl_department_id (Online/Fysiek/Retentie).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tl_department_id text;

-- 1b) TL subscription-id op invoices (factuur draagt subscription.id mee) — voor
--     latere factuur↔abonnement-reconciliatie (Fase 2B). Nu enkel meegeschreven.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tl_subscription_id text;

-- 2) Idempotente sync-sleutel: unieke TL-factuur-id waar aanwezig.
--    Handmatige facturen (2B) hebben tl_invoice_id NULL → vallen buiten de index.
--    NB: partial unique index kan NIET als ON CONFLICT-arbiter dienen in
--    PostgREST/supabase-js (lesson 20 mei) — de sync gebruikt daarom een
--    expliciet SELECT → UPDATE/INSERT 2-staps-patroon op tl_invoice_id.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tl_invoice_id_key
  ON public.invoices (tl_invoice_id)
  WHERE tl_invoice_id IS NOT NULL;

-- 3) Filter-index op department (lijst-/KPI-queries filteren hierop).
CREATE INDEX IF NOT EXISTS idx_invoices_tl_department
  ON public.invoices (tl_department_id);

-- BEWUST NIET: geen extra unique op invoice_number. De bestaande composite
-- uq_invoices_number_year (invoice_number, jaar) blijft staan. TL-concepten
-- zonder nummer krijgen in de sync een placeholder 'CONCEPT-<tl_invoice_id>'
-- (uniek per factuur → geen botsing met de jaar-index).

-- ============================================================================
-- Verificatie (read-only) — draai na toepassing:
-- ============================================================================
-- a) Kolom bestaat?
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'invoices' AND column_name = 'tl_department_id';
--
-- b) Indexen bestaan?
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'invoices'
--      AND indexname IN ('invoices_tl_invoice_id_key', 'idx_invoices_tl_department');
