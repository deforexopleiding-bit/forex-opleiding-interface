-- ============================================================================
-- customers.date_of_birth zekerstellen (idempotent)
-- Datum: 2026-06-02
-- Branch: feature/subscription-fixes-v2
--
-- date_of_birth wordt al door code gelezen/geschreven (customer.js,
-- sales-deal-create.js) maar staat in geen enkele migratie-file. Deze
-- ADD COLUMN IF NOT EXISTS is veilig: bestaat de kolom al, dan is dit een no-op.
-- ============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS date_of_birth date;

COMMIT;
