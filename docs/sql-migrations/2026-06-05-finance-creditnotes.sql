-- ============================================================================
-- Finance creditnota's — opslag + afgeleid credited_amount op invoices
-- Datum: 2026-06-05
-- Branch: feat/finance-creditnotes
-- Additief + idempotent.
-- ============================================================================

-- 1. Afgeleid creditbedrag per factuur (som van gekoppelde creditnota's, incl. btw).
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS credited_amount numeric(10,2) NOT NULL DEFAULT 0;

-- 2. Creditnota's (een factuur kan er meerdere hebben).
CREATE TABLE IF NOT EXISTS public.credit_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tl_credit_note_id  text,
  credit_note_number text,
  tl_invoice_id      text,                                   -- TL-id van de originele factuur
  invoice_id         uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  department_id      text,
  amount_total       numeric(10,2),                          -- incl. btw
  credit_note_date   date,
  status             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Idempotente sync-sleutel (partial unique → 2-staps SELECT→UPSERT in code, geen ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_tl_id_key ON public.credit_notes (tl_credit_note_id) WHERE tl_credit_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice    ON public.credit_notes (invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_tl_invoice ON public.credit_notes (tl_invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_date       ON public.credit_notes (credit_note_date);

-- ============================================================================
-- Verificatie:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='invoices' AND column_name='credited_amount';
--   SELECT count(*) FROM public.credit_notes;
-- ============================================================================
