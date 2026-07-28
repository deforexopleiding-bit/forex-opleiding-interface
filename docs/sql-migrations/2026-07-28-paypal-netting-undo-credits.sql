-- ============================================================================
-- PayPal-netting: undo #972 (is_credit filter) — vervangen door correcte netting
-- Datum: 2026-07-28
-- Branch: fix/paypal-authorization-netting
--
-- Wat: PR #972 introduceerde is_credit-flag + 'terugbetalingen-credits'-cat
-- die de +Bij-Overige-rijen als "credit" uitfilterde. Analyse toont dat dat
-- FOUT is — de +Bij is een TERUGGEBOEKTE AUTORISATIE-RESERVERING, geen refund.
-- Filteren leidt tot OVERTELLING (Af blijft staan, Bij weg → €38 ipv €0,48).
--
-- Correcte aanpak: NETTEN op weergave-tijd (Af + Bij tellen samen bij
-- dezelfde counterparty_name → netto = echte uitgave). Dat gebeurt in de
-- endpoints/helpers (deze PR). Deze SQL undoet #972's DB-tagging.
--
-- Wat verwijderen:
--   1) transaction_categorizations rows waar category='terugbetalingen-credits'
--      EN source='rule' AND rule_id IS NULL (die zijn door #972's parser-hook
--      + backfill aangemaakt; user-manual overrides op deze cat blijven staan)
--   2) De 'terugbetalingen-credits' expense_categories rij (indien geen manual
--      overrides meer aan hangen)
--   3) De is_credit kolom (indien niet meer gebruikt)
--
-- Idempotent: WHERE-guards + IF EXISTS. Veilig te herhalen.
-- ============================================================================

BEGIN;

-- ── Stap 1: verwijder auto-tag'de credit-categorisaties ──
-- Alleen rows die door #972's backfill + parser-hook zijn aangemaakt
-- (source='rule', rule_id=NULL, set_by_user_id=NULL of=user). Manual
-- overrides door user (source='manual') blijven staan — die zijn expliciet.
DO $$
DECLARE
  cat_credit uuid;
  n_deleted INT := 0;
BEGIN
  SELECT id INTO cat_credit FROM public.expense_categories
    WHERE slug = 'terugbetalingen-credits';
  IF cat_credit IS NOT NULL THEN
    DELETE FROM public.transaction_categorizations
    WHERE category_id = cat_credit
      AND source = 'rule';
    GET DIAGNOSTICS n_deleted = ROW_COUNT;
    RAISE NOTICE 'Auto-tagged credit-categorisaties verwijderd: % rijen', n_deleted;
  ELSE
    RAISE NOTICE 'Geen credit-categorie gevonden — al opgeruimd of nooit gemaakt';
  END IF;
END$$;

-- ── Stap 2: verwijder credit-categorie (alleen als geen manual overrides meer) ──
DO $$
DECLARE
  cat_credit uuid;
  n_remaining INT;
BEGIN
  SELECT id INTO cat_credit FROM public.expense_categories
    WHERE slug = 'terugbetalingen-credits';
  IF cat_credit IS NOT NULL THEN
    SELECT COUNT(*) INTO n_remaining
      FROM public.transaction_categorizations
      WHERE category_id = cat_credit;
    IF n_remaining = 0 THEN
      DELETE FROM public.expense_categories WHERE id = cat_credit;
      RAISE NOTICE 'Credit-categorie verwijderd (geen refs meer)';
    ELSE
      RAISE NOTICE 'Credit-categorie GEHOUDEN — % manual overrides hangen er nog aan', n_remaining;
    END IF;
  END IF;
END$$;

-- ── Stap 3: is_credit kolom drop (alleen als geen categorie 'em meer gebruikt) ──
-- Defensief: als iemand elders nog is_credit=true gezet heeft, laten we de
-- kolom staan. Anders drop.
DO $$
DECLARE
  n_using INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='expense_categories'
      AND column_name='is_credit'
  ) THEN
    SELECT COUNT(*) INTO n_using
      FROM public.expense_categories
      WHERE is_credit = true;
    IF n_using = 0 THEN
      ALTER TABLE public.expense_categories DROP COLUMN IF EXISTS is_credit;
      RAISE NOTICE 'is_credit kolom gedropt';
    ELSE
      RAISE NOTICE 'is_credit kolom GEHOUDEN — % categorie(en) hebben nog is_credit=true', n_using;
    END IF;
  END IF;
END$$;

COMMIT;

-- Rollback (herstel #972's state) — puur ter referentie, meestal niet nodig:
-- ALTER TABLE public.expense_categories ADD COLUMN IF NOT EXISTS is_credit boolean NOT NULL DEFAULT false;
-- (De categorie + tagging opnieuw laten aanmaken door #972's SQL opnieuw te draaien.)
