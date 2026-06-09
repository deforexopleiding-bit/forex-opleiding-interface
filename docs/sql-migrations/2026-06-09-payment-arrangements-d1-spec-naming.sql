-- 2026-06-09-payment-arrangements-d1-spec-naming.sql
-- Spec-conforme naming voor payment_arrangements (D1 polish).
--
-- Vervangt de CHECK-constraints op payment_arrangements.type en
-- payment_arrangements.status door uppercase enum-keys die de spec volgen.
--
-- type-keys: UITSTEL / SPLITSING / ABONNEMENT_PAUZE / ABONNEMENT_STOP / KWIJTSCHELDING
--   - SPLITSING vervangt de oude 'gespreid'
--   - ABONNEMENT_PAUZE + ABONNEMENT_STOP zijn 2 aparte types (niet samengevoegd
--     tot 'pauze' + 'overig')
--   - 'overig' wordt verwijderd; alle stop-cases vallen onder ABONNEMENT_STOP
--
-- status-keys: VOORGESTELD / ACTIEF / NAGEKOMEN / VERBROKEN / GEANNULEERD
--   - Approval-flow zit op pending_actions.status (PENDING/APPROVED/REJECTED/EXECUTED/...),
--     dus 'goedgekeurd' + 'afgewezen' worden hier verwijderd om dubbeling te voorkomen.
--   - 'voltooid' wordt hernoemd naar NAGEKOMEN (semantiek: klant heeft afspraak
--     volledig nagekomen).
--   - VERBROKEN is nieuw voor breach-detectie in D5 (bv. herhaalde late betaling).
--   - Lifecycle: VOORGESTELD -> (alle pending_actions APPROVED+EXECUTED) -> ACTIEF
--                              -> NAGEKOMEN | VERBROKEN | GEANNULEERD
--
-- NIET-aanrakingen:
--   - pending_actions.status CHECK blijft ongewijzigd (workflow-laag).
--   - arrangement_action_settings extras (max_amount, max_days, notify_roles,
--     scheduled_for, expires_at) blijven ongewijzigd.
--   - De originele migratie 2026-06-09-payment-arrangements-d1.sql wordt NIET
--     aangepast (kan al gedraaid zijn). Deze migratie is additief.
--
-- Run-volgorde:
--   1. Pre-flight check: bestaan er nog rows met de oude lowercase waarden?
--      Zo ja: deze migratie aborteert. Pas de waarden eerst handmatig aan
--      via de UPDATE-statements onderaan, of accepteer dat ze worden vertaald
--      door het optionele DATA-MAPPING blok (commented-out).
--   2. DROP + ADD CHECK constraints voor type en status.
--   3. COMMIT.

BEGIN;

-- ===========================================================================
-- 1. Pre-flight check: rows met legacy waarden?
-- ===========================================================================
-- Als hier rijen worden gevonden: de transactie wordt geRAISEd voordat de
-- CHECK-constraints worden aangepast (anders zou de ADD CONSTRAINT falen).
-- Pas de UPDATE-statements onder dit blok aan om legacy -> spec te mappen
-- voordat je de migratie opnieuw draait.
DO $$
DECLARE
  legacy_type_count    integer;
  legacy_status_count  integer;
BEGIN
  SELECT count(*) INTO legacy_type_count
  FROM public.payment_arrangements
  WHERE type IN ('uitstel','gespreid','pauze','kwijtschelding','overig');

  SELECT count(*) INTO legacy_status_count
  FROM public.payment_arrangements
  WHERE status IN ('voorgesteld','goedgekeurd','afgewezen','actief','voltooid','geannuleerd');

  IF legacy_type_count > 0 OR legacy_status_count > 0 THEN
    RAISE EXCEPTION
      'Legacy lowercase payment_arrangements rows gevonden (type=% / status=%). Run eerst het DATA-MAPPING blok onderaan deze migratie, dan opnieuw uitvoeren.',
      legacy_type_count, legacy_status_count;
  END IF;
END$$;

-- ===========================================================================
-- 2. type CHECK -> uppercase enum-keys (spec-conform)
-- ===========================================================================
ALTER TABLE public.payment_arrangements
  DROP CONSTRAINT IF EXISTS payment_arrangements_type_check;

ALTER TABLE public.payment_arrangements
  ADD CONSTRAINT payment_arrangements_type_check
  CHECK (type IN ('UITSTEL','SPLITSING','ABONNEMENT_PAUZE','ABONNEMENT_STOP','KWIJTSCHELDING'));

-- ===========================================================================
-- 3. status CHECK -> uppercase enum-keys + verwijder approval-states
-- ===========================================================================
ALTER TABLE public.payment_arrangements
  DROP CONSTRAINT IF EXISTS payment_arrangements_status_check;

ALTER TABLE public.payment_arrangements
  ADD CONSTRAINT payment_arrangements_status_check
  CHECK (status IN ('VOORGESTELD','ACTIEF','NAGEKOMEN','VERBROKEN','GEANNULEERD'));

-- Default ook bijwerken (was 'voorgesteld' -> wordt 'VOORGESTELD').
ALTER TABLE public.payment_arrangements
  ALTER COLUMN status SET DEFAULT 'VOORGESTELD';

COMMENT ON COLUMN public.payment_arrangements.status IS
  'Lifecycle: VOORGESTELD -> (alle pending_actions APPROVED+EXECUTED) -> ACTIEF -> NAGEKOMEN | VERBROKEN | GEANNULEERD. Approval-flow zit op pending_actions.status.';

COMMIT;

-- ============================================================================
-- DATA-MAPPING (handmatig — alleen draaien als pre-flight check faalde)
-- ============================================================================
-- BEGIN;
--   -- type
--   UPDATE public.payment_arrangements SET type='UITSTEL'           WHERE type='uitstel';
--   UPDATE public.payment_arrangements SET type='SPLITSING'         WHERE type='gespreid';
--   UPDATE public.payment_arrangements SET type='ABONNEMENT_PAUZE'  WHERE type='pauze';
--   UPDATE public.payment_arrangements SET type='ABONNEMENT_STOP'   WHERE type='overig';
--   UPDATE public.payment_arrangements SET type='KWIJTSCHELDING'    WHERE type='kwijtschelding';
--   -- status
--   UPDATE public.payment_arrangements SET status='VOORGESTELD'  WHERE status IN ('voorgesteld','goedgekeurd','afgewezen');
--   UPDATE public.payment_arrangements SET status='ACTIEF'       WHERE status='actief';
--   UPDATE public.payment_arrangements SET status='NAGEKOMEN'    WHERE status='voltooid';
--   UPDATE public.payment_arrangements SET status='GEANNULEERD'  WHERE status='geannuleerd';
-- COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.payment_arrangements DROP CONSTRAINT IF EXISTS payment_arrangements_type_check;
--   ALTER TABLE public.payment_arrangements ADD CONSTRAINT payment_arrangements_type_check
--     CHECK (type IN ('uitstel','gespreid','pauze','kwijtschelding','overig'));
--   ALTER TABLE public.payment_arrangements DROP CONSTRAINT IF EXISTS payment_arrangements_status_check;
--   ALTER TABLE public.payment_arrangements ADD CONSTRAINT payment_arrangements_status_check
--     CHECK (status IN ('voorgesteld','goedgekeurd','afgewezen','actief','voltooid','geannuleerd'));
--   ALTER TABLE public.payment_arrangements ALTER COLUMN status SET DEFAULT 'voorgesteld';
-- COMMIT;
