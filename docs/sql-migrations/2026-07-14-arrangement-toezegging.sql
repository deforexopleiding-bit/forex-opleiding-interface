-- 2026-07-14-arrangement-toezegging.sql
-- Fase 1 — Licht arrangement-type TOEZEGGING voor betaalafspraken zonder TL-actie.
--
-- Context: de bestaande types (UITSTEL / SPLITSING / ABONNEMENT_PAUZE /
-- ABONNEMENT_STOP / KWIJTSCHELDING) doen zware TL-mutaties (consolideren /
-- splitsen / abonnement muteren / crediteren). Voor een simpele
-- klant-toezegging "ik betaal maandag" is dat over-engineered.
--
-- TOEZEGGING is een LICHT type:
--   - Geen pending_actions (geen TL-actie).
--   - Direct status='ACTIEF' bij insert (geen approval-flow — het is een
--     notitie van een gemaakte afspraak, geen geld-actie).
--   - details.parts = [{ due_date, invoice_id?, amount_cents? }, …]
--     * één part = "hele bedrag op deze datum"
--     * meerdere parts = "factuur A op maandag, factuur B eind vd maand"
--     * invoice_id optioneel: als NULL geldt de datum voor ALLE open
--       facturen van de klant (arrangement.invoice_ids blijft leidend).
--     * amount_cents optioneel (informatief); breach-check gebruikt de
--       daadwerkelijke factuur-status als bron van waarheid.
--
-- Bewaking: cron-arrangements-breach-check krijgt een TOEZEGGING-case:
--   * alle parts nagekomen (facturen betaald op/vóór due_date) → NAGEKOMEN
--   * minstens 1 verstreken part met open bedrag        → VERBROKEN
--
-- Idempotent: DROP + ADD CHECK op payment_arrangements_type_check. Bestaande
-- rijen worden NIET geraakt (alle bestaande waarden blijven in de lijst).
--
-- Pre-flight check: geen rows met onbekende type-waarden vóór ADD CONSTRAINT.

BEGIN;

-- ===========================================================================
-- 1. Pre-flight: bestaan er rijen met een type buiten de spec + TOEZEGGING?
-- ===========================================================================
DO $$
DECLARE
  unknown_count integer;
BEGIN
  SELECT count(*) INTO unknown_count
  FROM public.payment_arrangements
  WHERE type NOT IN (
    'UITSTEL','SPLITSING','ABONNEMENT_PAUZE','ABONNEMENT_STOP','KWIJTSCHELDING',
    'TOEZEGGING'
  );
  IF unknown_count > 0 THEN
    RAISE EXCEPTION
      'payment_arrangements bevat % rijen met onbekende type-waarde. Los eerst op vóór deze migratie draait.',
      unknown_count;
  END IF;
END$$;

-- ===========================================================================
-- 2. type CHECK uitbreiden met TOEZEGGING
-- ===========================================================================
ALTER TABLE public.payment_arrangements
  DROP CONSTRAINT IF EXISTS payment_arrangements_type_check;

ALTER TABLE public.payment_arrangements
  ADD CONSTRAINT payment_arrangements_type_check
  CHECK (type IN (
    'UITSTEL','SPLITSING','ABONNEMENT_PAUZE','ABONNEMENT_STOP','KWIJTSCHELDING',
    'TOEZEGGING'
  ));

COMMENT ON COLUMN public.payment_arrangements.type IS
  'Type arrangement. TOEZEGGING is een lichte afspraak zonder TL-actie (details.parts = [{due_date, invoice_id?, amount_cents?}]). De andere types muteren TL en gaan via pending_actions.';

COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window; verwijdert alle TOEZEGGING-rijen)
-- ============================================================================
-- BEGIN;
--   DELETE FROM public.payment_arrangements WHERE type = 'TOEZEGGING';
--   ALTER TABLE public.payment_arrangements DROP CONSTRAINT IF EXISTS payment_arrangements_type_check;
--   ALTER TABLE public.payment_arrangements
--     ADD CONSTRAINT payment_arrangements_type_check
--     CHECK (type IN ('UITSTEL','SPLITSING','ABONNEMENT_PAUZE','ABONNEMENT_STOP','KWIJTSCHELDING'));
-- COMMIT;
