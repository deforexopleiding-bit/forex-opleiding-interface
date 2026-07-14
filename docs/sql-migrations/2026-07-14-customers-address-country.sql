-- ============================================================================
-- 2026-07-14 — customers.address_country (NL/BE landkeuze)
--
-- CONTEXT: api/_lib/teamleader-contact.js hardcodede `country: 'NL'` bij het
-- pushen van contacts.add / companies.add. Belgische klanten kregen daardoor
-- NL in Teamleader.
--
-- Deze migratie voegt een `address_country` kolom toe aan customers. Bij het
-- toevoegen/bewerken van een klant in de sales-wizard kan sales nu NL of BE
-- kiezen; de TL-push leest die waarde en stuurt correct 'NL' of 'BE'.
--
-- Backward-compat: kolom is NULL voor bestaande rijen. teamleader-contact.js
-- valt terug op 'NL' als address_country ontbreekt/leeg is, zodat oude
-- klanten hun huidige gedrag behouden.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CHECK constraint met safety-drop.
-- ============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS address_country text;

-- Beperk toegestane waarden tot NL/BE (en NULL voor legacy). Uitbreiding
-- naar meer landen later mogelijk door de check-constraint te vervangen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_address_country_check'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_address_country_check
      CHECK (address_country IS NULL OR address_country IN ('NL', 'BE'));
  END IF;
END $$;

COMMIT;
