-- ============================================================================
-- PayPal terugbetalingen/credits scheiden van echte klant-inkomsten
-- Datum: 2026-07-28
-- Branch: fix/paypal-refunds-credits
--
-- Probleem: PayPal-uitgaven via bankpas komen als 3-rijen-paar binnen:
--   1) Af  (uitgave)               — type 'Algemene PayPal-bankpastransactie'
--   2) Bij (verrekening/credit)    — type 'Overige', refTxnId → Af-parent
--   3) Memo (autorisatie)          — al door parser geskipt
-- De 'Overige'-Bij is GEEN klant-inkomst, het is een interne PayPal-
-- verrekening/credit bij een uitgave (~€38 refund op €38 uitgave = fee-restant).
-- Nu tellen ze onterecht als inkomst en strepen ze de echte uitgave-per-
-- tegenpartij bijna weg (Twilio toont €0,48/mnd ipv €38/mnd).
--
-- Fix (analog aan is_internal-pattern uit #964):
--   1) Nieuwe kolom expense_categories.is_credit boolean default false
--   2) Seed systeem-categorie 'terugbetalingen-credits' met is_credit=true
--   3) Backfill: alle matchende PayPal 'Overige'-Bij rijen krijgen deze cat
--      (zelfde skip-manual-guard als andere backfills)
--
-- Detection-signaal (100% precisie, 0 false-positives op sample):
--   source='paypal'
--   AND amount_cents > 0
--   AND transaction_code = 'Overige'
--   AND end_to_end_id (= Reference Txn ID) matcht entry_reference
--       van een andere paypal-tx met amount_cents < 0
--
-- Echte klant-inkomsten (Express Checkout, Terugbetaling, Cashback) hebben
-- transaction_code != 'Overige' → onaangeroerd.
--
-- Saldo-validatie: BLIJFT €0,00 — raw amount_cents in camt_transactions
-- verandert niet; we voegen alleen een categorisatie-rij toe.
--
-- Idempotent: NOT EXISTS + IF NOT EXISTS + skip-al-gecategoriseerd guards.
-- ============================================================================

BEGIN;

-- ── Stap 1: is_credit-kolom ──
ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS is_credit boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.expense_categories.is_credit IS
  'true = categorie voor PayPal-verrekeningen/credits bij uitgaves. Default uit uitgaven+inkomsten-weergave gefilterd; aparte toggle in UI.';

-- ── Stap 2: seed systeem-categorie 'Terugbetalingen & credits' ──
INSERT INTO public.expense_categories (slug, label, color, is_active, is_internal, is_credit)
SELECT 'terugbetalingen-credits', 'Terugbetalingen & credits', '#06b6d4', true, false, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories WHERE slug = 'terugbetalingen-credits'
);

-- ── Stap 3: backfill — tag alle matchende PayPal-credits ──
-- Match op refTxnId → parent-Af koppeling. Skip tx die al gecategoriseerd zijn
-- (respecteer manual overrides + eventuele bestaande rule-categorisaties).
DO $$
DECLARE
  cat_credit uuid;
  n_inserted INT := 0;
BEGIN
  SELECT id INTO cat_credit FROM public.expense_categories
    WHERE slug = 'terugbetalingen-credits';
  IF cat_credit IS NULL THEN
    RAISE EXCEPTION 'terugbetalingen-credits category niet gevonden';
  END IF;

  INSERT INTO public.transaction_categorizations
    (camt_transaction_id, category_id, source, rule_id, set_by_user_id, set_at)
  SELECT
    bij.id, cat_credit, 'rule', NULL, NULL, now()
  FROM public.camt_transactions bij
  JOIN public.camt_transactions af
    ON af.entry_reference = bij.end_to_end_id
   AND af.source          = 'paypal'
   AND af.amount_cents    < 0
  WHERE bij.source           = 'paypal'
    AND bij.amount_cents     > 0
    AND bij.transaction_code = 'Overige'
    AND NOT EXISTS (
      SELECT 1 FROM public.transaction_categorizations c
      WHERE c.camt_transaction_id = bij.id
    );

  GET DIAGNOSTICS n_inserted = ROW_COUNT;
  RAISE NOTICE 'PayPal-credits getagd (backfill): % rijen', n_inserted;
END$$;

-- ── Post-check ──
DO $$
DECLARE
  n_cnt INT; s_eur NUMERIC;
BEGIN
  SELECT COUNT(*), SUM(t.amount_cents) / 100.0
    INTO n_cnt, s_eur
    FROM public.camt_transactions t
    JOIN public.transaction_categorizations c ON c.camt_transaction_id = t.id
    JOIN public.expense_categories ec ON ec.id = c.category_id
   WHERE ec.slug = 'terugbetalingen-credits';
  RAISE NOTICE 'Totaal getagd als credit: % tx / % EUR', n_cnt, s_eur;
END$$;

COMMIT;

-- ROLLBACK (indien nodig):
-- DELETE FROM public.transaction_categorizations
--   WHERE category_id = (SELECT id FROM public.expense_categories WHERE slug='terugbetalingen-credits');
-- DELETE FROM public.expense_categories WHERE slug = 'terugbetalingen-credits';
-- ALTER TABLE public.expense_categories DROP COLUMN IF EXISTS is_credit;
