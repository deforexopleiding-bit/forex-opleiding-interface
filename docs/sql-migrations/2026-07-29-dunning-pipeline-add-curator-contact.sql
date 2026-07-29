-- ============================================================================
-- 2026-07-29 — dunning_pipeline_customers.curator_contact (jsonb)
--
-- ACHTERGROND: bij stage='bewind' hebben we contactgegevens van de curator/
-- bewindvoerder nodig zodat de operator direct kan doorschakelen. Los veld
-- (i.p.v. in dunning_pipeline_log.meta) omdat het per-klant persistent is
-- en snel opzoekbaar moet zijn zonder log-scan.
--
-- Shape (per rij, alleen relevant bij stage='bewind'):
--   {
--     "name":         string,   // bewindvoerder-naam of kantoor
--     "email":        string?,  // contact-email
--     "phone":        string?,  // contact-telefoon
--     "reference":    string?,  // dossiernummer bij bewind/curator
--     "note":         string?,  // vrije notitie
--     "recorded_at":  string    // ISO timestamp bij invoer
--   }
--
-- Nullable — bestaande rijen krijgen automatisch NULL. Alleen ingevuld door
-- api/finance-dunning-mark-bewind.js bij stage='bewind'. Rollback laat de
-- data staan (kolom drop is destructief) — als je wilt terug: DROP COLUMN.
--
-- Idempotent (IF NOT EXISTS).
-- ============================================================================

BEGIN;

  ALTER TABLE public.dunning_pipeline_customers
    ADD COLUMN IF NOT EXISTS curator_contact jsonb;

  COMMENT ON COLUMN public.dunning_pipeline_customers.curator_contact IS
    'Bewindvoerder/curator-contactgegevens (jsonb) — alleen ingevuld bij stage=bewind. Shape: {name, email?, phone?, reference?, note?, recorded_at}. Gezet door api/finance-dunning-mark-bewind.js.';

  NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK (destructief — data wordt gewist):
-- BEGIN;
--   ALTER TABLE public.dunning_pipeline_customers DROP COLUMN IF EXISTS curator_contact;
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
