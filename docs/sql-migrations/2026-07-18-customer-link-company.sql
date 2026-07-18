-- 2026-07-18 — Bedrijf ↔ persoon koppeling v1 (lokaal, geen TL-sync)
--
-- Voegt company_customer_id toe aan customers zodat een persoon-klant
-- kan worden gelinkt aan een bedrijf-klant. Alleen zinvol op is_company=false
-- rijen wijzend naar een is_company=true rij; de validatie van die invariant
-- gebeurt server-side in api/customer-link-company.js (niet in DB) zodat we
-- geen check-constraint hoeven te droppen bij data-migraties later.
--
-- Fase 2 (buiten scope van deze migratie): TL-sync via contacts.linkToCompany.
--
-- ⚠ MIGRATIE BLOKKEREND wordt vermeden — de code is defensief geschreven
-- (isMissingColumnError-check op 42703/PGRST204) zodat customer.js GET blijft
-- werken zonder de kolom, en het nieuwe link-endpoint een duidelijke 501
-- geeft met de instructie deze migratie te draaien. Toch is het aanbevolen
-- deze migratie VÓÓR of DIRECT NA merge te draaien zodat de UI-secties
-- daadwerkelijk functioneel worden.
--
-- ON DELETE SET NULL: als een bedrijf-klant hard-verwijderd wordt (zelden
-- — meestal archived) blijft de gekoppelde persoon bestaan; de link wordt
-- geleegd. Voorkomt cascade-delete van personen bij bedrijfs-cleanup.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS company_customer_id uuid
    REFERENCES public.customers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.customers.company_customer_id IS
  'FK naar customers(id) — koppelt een persoon-klant (is_company=false) aan '
  'een bedrijf-klant (is_company=true). Server-side gate in '
  'api/customer-link-company.js valideert dat beide zijden het juiste type '
  'hebben. NULL = geen koppeling. Zie migratie 2026-07-18-customer-link-company.sql.';

-- Index op de FK zodat reverse-lookup (alle personen bij een bedrijf) snel
-- is bij de bedrijf-detail-view.
CREATE INDEX IF NOT EXISTS idx_customers_company_customer_id
  ON public.customers(company_customer_id)
  WHERE company_customer_id IS NOT NULL;

-- PostgREST schema-cache reloaden zodat de nieuwe kolom direct beschikbaar
-- is in de REST-API (zonder deze notify bleef Eddy Delmoitie's call_status
-- 3u lang stil hangen — zie #814).
NOTIFY pgrst, 'reload schema';

-- Sanity-check: kolom bestaat + is nullable + FK klopt.
SELECT
  column_name,
  data_type,
  is_nullable,
  (SELECT tc.constraint_type
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
    WHERE kcu.table_name = 'customers'
      AND kcu.column_name = 'company_customer_id'
      AND tc.constraint_type = 'FOREIGN KEY'
    LIMIT 1) AS fk_constraint
FROM information_schema.columns
WHERE table_name = 'customers'
  AND column_name = 'company_customer_id';
