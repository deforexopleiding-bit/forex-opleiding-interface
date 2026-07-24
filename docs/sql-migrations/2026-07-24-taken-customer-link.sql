-- 2026-07-24-taken-customer-link.sql
--
-- Voeg customer_id toe aan taken_items zodat vrije taken aan een klant
-- gekoppeld kunnen worden. Nullable — bestaande taken (zonder koppeling)
-- blijven werken. Alleen NIEUWE taken die vanuit een klantcontext worden
-- aangemaakt schrijven customer_id mee (fase 1). GEEN backfill van oude
-- taken via tekstmatch — dat levert fouten (Jansen/Janssen, naamgenoten).
--
-- Owner draait deze migratie handmatig op prod.

-- 1. Kolom toevoegen (nullable, FK naar customers met ON DELETE SET NULL
--    zodat het verwijderen van een klant geen taken doet cascaden).
ALTER TABLE public.taken_items
  ADD COLUMN IF NOT EXISTS customer_id uuid;

-- 2. Foreign-key constraint. Defensief: alleen als 'customers' bestaat en
--    de constraint nog niet is aangemaakt. IF NOT EXISTS werkt niet direct
--    op ADD CONSTRAINT, dus check via information_schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='customers'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public'
      AND table_name='taken_items'
      AND constraint_name='taken_items_customer_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE public.taken_items
             ADD CONSTRAINT taken_items_customer_id_fkey
             FOREIGN KEY (customer_id) REFERENCES public.customers(id)
             ON DELETE SET NULL';
  END IF;
END$$;

-- 3. Index voor de dossier-lookup "alle open taken van deze klant".
--    Partial index op status <> 'done' houdt 'em klein — het dossier
--    filtert altijd op open taken.
CREATE INDEX IF NOT EXISTS taken_items_customer_open_idx
  ON public.taken_items (customer_id)
  WHERE status <> 'done' AND customer_id IS NOT NULL;

-- 4. Schema-cache reload zodat PostgREST de nieuwe kolom direct kent.
NOTIFY pgrst, 'reload schema';
