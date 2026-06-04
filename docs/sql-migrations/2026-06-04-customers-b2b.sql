-- ============================================================================
-- B2B-klantondersteuning — customers-tabel uitbreiding
-- Datum: 2026-06-04
-- Additief + idempotent. Backwards-compatible: bestaande B2C-records blijven
-- geldig (first_name/last_name worden nullable; default is_company = false).
--
-- Toepassen: Supabase SQL Editor (productie). Daarna verifieer-queries onderaan.
-- ============================================================================

-- 1) Type-flag + bedrijfsvelden.
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS is_company   boolean NOT NULL DEFAULT false;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS kvk_number   text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS vat_number   text;

-- 2) TL company-id (voor idempotente B2B TL-push; los van tl_contact_id).
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS tl_company_id text;

-- 3) first_name / last_name nullable maken — bedrijven hebben geen verplichte
--    persoonsnaam. DROP NOT NULL is idempotent (no-op als al nullable).
ALTER TABLE public.customers ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE public.customers ALTER COLUMN last_name  DROP NOT NULL;

-- 4) Index voor TL company-lookup (sync/idempotency).
CREATE INDEX IF NOT EXISTS idx_customers_tl_company ON public.customers (tl_company_id);

-- ============================================================================
-- Verificatie (read-only) — draai na toepassing:
-- ============================================================================
-- a) Nieuwe kolommen aanwezig?
--    SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name='customers'
--      AND column_name IN ('is_company','company_name','kvk_number','vat_number','tl_company_id','first_name','last_name')
--    ORDER BY column_name;
--    -> first_name/last_name is_nullable moet nu 'YES' zijn.
--
-- b) Bestaande rijen ongemoeid?
--    SELECT count(*) AS total, count(*) FILTER (WHERE is_company) AS companies FROM public.customers;
--    -> companies = 0 direct na migratie (alles particulier, backwards-compatible).
