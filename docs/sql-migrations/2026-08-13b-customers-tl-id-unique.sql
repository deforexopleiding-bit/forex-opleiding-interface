-- Migratie 2026-08-13b: partial UNIQUE index op customers.tl_contact_id / tl_company_id.
--
-- ⚠️ DRAAI PAS NÁ DE DEDUPE. Zolang er >1 ACTIEVE customer met dezelfde tl_*-id
-- bestaat, stopt de pre-check hieronder met een duidelijke melding (i.p.v. een
-- kryptische unique-violation).
--
-- Reden: idx_customers_tl_contact / idx_customers_tl_company waren NIET-uniek,
-- waardoor het aanmaakpad een tweede customers-rij met hetzelfde tl_contact_id
-- kon maken. Dat brak de customer-lookup (maybeSingle op >1 → error → null →
-- "geen klant") en liet de factuur-sync facturen overslaan (bv. 2026/1548).
--
-- Scope 'active' (archived_at/anonymized_at NULL): een GEDEACTIVEERDE duplicaat
-- (archived_at gezet als dedupe-strategie) mag blijven bestaan zonder de
-- uniqueness te breken. Er mag dus max. één ACTIEVE customer per tl_*-id zijn.

-- Pre-check: harde stop met bruikbare melding als er nog actieve duplicaten zijn.
DO $$
DECLARE d record;
BEGIN
  FOR d IN
    SELECT tl_contact_id AS id, 'tl_contact_id' AS col, count(*) AS n
      FROM public.customers
      WHERE tl_contact_id IS NOT NULL AND archived_at IS NULL AND anonymized_at IS NULL
      GROUP BY tl_contact_id HAVING count(*) > 1
    UNION ALL
    SELECT tl_company_id, 'tl_company_id', count(*)
      FROM public.customers
      WHERE tl_company_id IS NOT NULL AND archived_at IS NULL AND anonymized_at IS NULL
      GROUP BY tl_company_id HAVING count(*) > 1
  LOOP
    RAISE EXCEPTION 'Dedupe eerst: % actieve customers met %=%', d.n, d.col, d.id;
  END LOOP;
END $$;

-- Non-concurrent (customers is klein) → korte lock, idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tl_contact_active
  ON public.customers (tl_contact_id)
  WHERE tl_contact_id IS NOT NULL AND archived_at IS NULL AND anonymized_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tl_company_active
  ON public.customers (tl_company_id)
  WHERE tl_company_id IS NOT NULL AND archived_at IS NULL AND anonymized_at IS NULL;
