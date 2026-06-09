-- =============================================================================
-- Tasks F1 — invoice_id FK op pending_actions
-- =============================================================================
-- Doel: voeg een directe FK-kolom `invoice_id` toe aan pending_actions, zodat
-- MANUAL_VERIFY_PAYMENT-taken (en toekomstige invoice-gerelateerde acties die
-- NIET aan een arrangement gekoppeld zijn) een first-class koppeling hebben
-- naar de gerelateerde factuur. Voorheen moest invoice-id uit payload.jsonb
-- gevist worden, wat queries / index-gebruik bemoeilijkt.
--
-- Achtergrond (uit D1 recon):
--   * pending_actions.arrangement_id IS reeds NULLABLE (zie
--     2026-06-09-payment-arrangements-d1.sql regel 89 — geen NOT NULL).
--   * Een MANUAL_VERIFY_PAYMENT row kan dus arrangement_id = NULL hebben
--     zonder schema-aanpassing.
--   * Nieuw: invoice_id FK + partial index voor snelle filter op
--     'open verify-payment taken per factuur'.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- --- Pre-flight: bevestig dat arrangement_id NULLABLE is (no-op bij correcte
-- state, faalt expliciet wanneer iemand per ongeluk een NOT NULL constraint
-- heeft toegevoegd).
DO $$
DECLARE
  v_is_nullable text;
BEGIN
  SELECT is_nullable
    INTO v_is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'pending_actions'
     AND column_name  = 'arrangement_id';

  IF v_is_nullable IS NULL THEN
    RAISE EXCEPTION 'pending_actions.arrangement_id niet gevonden — draai eerst D1-migratie';
  END IF;

  IF v_is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'pending_actions.arrangement_id moet NULLABLE zijn (huidig: %)', v_is_nullable;
  END IF;
END $$;

-- --- 1. Kolom toevoegen ------------------------------------------------------
ALTER TABLE public.pending_actions
  ADD COLUMN IF NOT EXISTS invoice_id uuid
    REFERENCES public.invoices(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.pending_actions.invoice_id IS
  'Verwijst naar de gerelateerde factuur (bv. MANUAL_VERIFY_PAYMENT, of toekomstige invoice-acties zonder arrangement). NULL voor acties die niet aan een specifieke factuur hangen.';

-- --- 2. Partial index voor snelle filter -------------------------------------
CREATE INDEX IF NOT EXISTS idx_pact_invoice
  ON public.pending_actions (invoice_id)
  WHERE invoice_id IS NOT NULL;

COMMIT;
