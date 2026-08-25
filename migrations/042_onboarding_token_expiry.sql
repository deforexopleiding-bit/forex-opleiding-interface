-- ============================================================================
-- Migratie 042: Onboarding-token expiry — [M-06]
-- Datum: 2026-08-25
-- Doel: dicht een security-gap in de klant-facing onboarding-token-flow
--       (voorheen geen expiry, geen one-time-use). Bewuste klant-facing
--       flow → grace-period voor bestaande open links (er zijn er 0 oud,
--       impact-check bevestigd door Jeffrey).
--
-- Impact-check vooraf (Jeffrey draaide):
--   SELECT count(*) FROM customers
--    WHERE onboarding_status != 'completed'
--      AND onboarding_sent_at < now() - interval '30 days';
--   Uitkomst: 0 rijen → grace-window van 30 dagen op backfill raakt niks.
--
-- Wijzigingen:
--   1. Nieuwe kolom: customers.onboarding_token_expires_at timestamptz
--   2. Backfill:
--      - Rijen met status='sent' + onboarding_sent_at NOT NULL:
--          expires_at = onboarding_sent_at + interval '60 days'
--        (matcht wat sales-onboarding-send.js voortaan schrijft bij nieuwe
--        verzendingen — 60 dagen na verzenden is ruim.)
--      - Rijen met status='sent' zonder onboarding_sent_at (edge-case):
--          expires_at = now() + interval '30 days' (grace)
--      - Rijen met status='completed': expires_at blijft NULL (irrelevant —
--        idempotent no-op in POST-handler).
--      - Rijen met status='pending'/NULL zonder token: expires_at blijft NULL
--        (nog niet verzonden → geen link outstanding).
--   3. Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE ... WHERE expires_at IS NULL.
--
-- ROLLBACK — onderaan (aparte transactie).
-- ============================================================================

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS onboarding_token_expires_at timestamptz;

COMMENT ON COLUMN public.customers.onboarding_token_expires_at IS
  'Vervaldatum van onboarding_token. Bij api/onboarding.js GET+POST: als '
  '< now() en status != ''completed'' → 410 Gone. Wordt gezet bij '
  'sales-onboarding-send.js op onboarding_sent_at + 60 dagen. NULL = '
  'nog niet verzonden of completed (irrelevant).';

-- Backfill 1: bestaande sent-rijen met sent_at → +60 dagen vanaf sent.
UPDATE public.customers
   SET onboarding_token_expires_at = onboarding_sent_at + interval '60 days'
 WHERE onboarding_token_expires_at IS NULL
   AND onboarding_status = 'sent'
   AND onboarding_sent_at IS NOT NULL;

-- Backfill 2: sent-rijen zonder sent_at (edge — grace 30d vanaf nu).
UPDATE public.customers
   SET onboarding_token_expires_at = now() + interval '30 days'
 WHERE onboarding_token_expires_at IS NULL
   AND onboarding_status = 'sent'
   AND onboarding_sent_at IS NULL;

-- Verificatie: hoeveel rijen hebben nu een expires_at?
DO $$
DECLARE
  cnt_sent int;
  cnt_expires int;
  cnt_overdue int;
BEGIN
  SELECT count(*) INTO cnt_sent    FROM public.customers WHERE onboarding_status = 'sent';
  SELECT count(*) INTO cnt_expires FROM public.customers WHERE onboarding_token_expires_at IS NOT NULL;
  SELECT count(*) INTO cnt_overdue FROM public.customers WHERE onboarding_status = 'sent' AND onboarding_token_expires_at < now();
  RAISE NOTICE '[migratie 042] status=sent: %', cnt_sent;
  RAISE NOTICE '[migratie 042] expires_at gezet: %', cnt_expires;
  RAISE NOTICE '[migratie 042] al verlopen (sent + expired): %', cnt_overdue;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT, apart)
-- ============================================================================
-- 1. Kolom bestaat:
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='customers' AND column_name='onboarding_token_expires_at';
--
-- 2. Backfill klopt:
--    SELECT count(*) FILTER (WHERE onboarding_status='sent') AS sent_total,
--           count(*) FILTER (WHERE onboarding_status='sent' AND onboarding_token_expires_at IS NOT NULL) AS sent_with_expiry
--    FROM public.customers;
--    Verwacht: beide getallen zijn gelijk.
--
-- 3. Handmatige test:
--    -- Pak een test-klant met status='sent':
--    SELECT id, first_name, email, onboarding_sent_at, onboarding_token_expires_at
--    FROM public.customers WHERE onboarding_status='sent' LIMIT 3;
--    -- Force verlopen:
--    UPDATE public.customers SET onboarding_token_expires_at = now() - interval '1 hour'
--    WHERE id = '<test-uuid>';
--    -- Roep de link aan: /modules/onboarding.html?t=<token> → moet 410 tonen
--    -- Reset: UPDATE ... SET onboarding_token_expires_at = now() + interval '60 days' WHERE id='<test-uuid>';
--
-- ============================================================================
-- ROLLBACK (aparte transactie als iets breekt)
-- ============================================================================
-- BEGIN;
-- -- 1. Endpoint-side: revert api/onboarding.js (git revert commit) VÓÓR kolom-drop.
-- -- 2. Kolom droppen (data-verlies! backup expiry-waarden als je hergebruik wil):
-- ALTER TABLE public.customers DROP COLUMN IF EXISTS onboarding_token_expires_at;
-- COMMIT;
-- ============================================================================
