-- ---------------------------------------------------------------------------
-- 2026-07-06 — Offerte-beveiliging bouwstap 2/2 — €100 reserveringsfee.
--
-- Voegt idempotentie-marker toe op deals zodat de fee-factuur maar één keer
-- wordt aangemaakt bij abbo-invoer (voorkomt dubbele facturatie bij retry
-- of hernieuwde submit).
--
-- Bouwstap 1 (2026-07-06-sales-exception-flags.sql) staat live: exception_*
-- kolommen bepalen of een fee van toepassing is. Deze migratie voegt puur
-- de audit-koppeling toe.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS reservation_fee_invoice_id text; -- lokale invoices.id (uuid als text; nullable)

COMMENT ON COLUMN public.deals.reservation_fee_invoice_id IS
  'ID van de €100-reserveringsfee-factuur (idempotentie-marker; alleen gevuld als fee al geboekt+verstuurd is). Bouwstap 2 offerte-beveiliging.';

-- Schema-reload zodat PostgREST de nieuwe kolom meteen kent.
NOTIFY pgrst, 'reload schema';

COMMIT;
