-- ============================================================================
-- Reserveringsfee-bypass — audit-kolommen op deals
-- Datum: 2026-07-28
-- Branch: fix/reservation-fee-bypass
--
-- Wat: bij late-start-abonnement (>40 dagen na vandaag) kan een gebruiker met
-- permission `sales.reservation_fee.bypass` de €100 reserveringsfee overslaan.
-- Deze migratie voegt de audit-velden toe die vastleggen WIE dat deed, WANNEER
-- en WAAROM. Zonder deze kolommen loopt de endpoint-write (best-effort) tegen
-- een schema-fout → NOTIFY reload zorgt dat PostgREST de kolommen meteen kent.
--
-- Idempotent (IF NOT EXISTS) — veilig te herhalen.
-- ============================================================================

BEGIN;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS reservation_fee_bypassed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reservation_fee_bypassed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reservation_fee_bypass_reason   text;

COMMENT ON COLUMN public.deals.reservation_fee_bypassed_by   IS
  'User-id (auth.users) die de €100-reserveringsfee heeft omzeild bij abbo-invoer. NULL = geen bypass.';
COMMENT ON COLUMN public.deals.reservation_fee_bypassed_at   IS
  'Tijdstip waarop de bypass werd toegepast. NULL als geen bypass.';
COMMENT ON COLUMN public.deals.reservation_fee_bypass_reason IS
  'Verplichte reden (min. 10 chars) voor de omzeiling — vrije tekst, bewaard voor audit.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK (indien nodig):
-- BEGIN;
-- ALTER TABLE public.deals
--   DROP COLUMN IF EXISTS reservation_fee_bypassed_by,
--   DROP COLUMN IF EXISTS reservation_fee_bypassed_at,
--   DROP COLUMN IF EXISTS reservation_fee_bypass_reason;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
