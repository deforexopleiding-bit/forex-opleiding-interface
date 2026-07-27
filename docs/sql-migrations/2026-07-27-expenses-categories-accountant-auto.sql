-- ============================================================================
-- Uitgaven-analyse — 2 nieuwe categorieën: Accountant & administratie + Auto
-- Datum: 2026-07-27
-- Branch: feat/expenses-categories-accountant-auto
--
-- Wat: seed 2 categorieën met eigen slug + onderscheidende kleur.
--   - 'accountant-administratie'  — Accountant & administratie  (#0d9488 teal-donker)
--   - 'auto'                      — Auto                        (#1e40af blauw-donker)
--
-- is_internal=false → tellen mee als ECHTE uitgaven in totaal + breakdown +
-- dashboard. Ze verschijnen automatisch in:
--   - /api/finance-expenses-categories (picker-dropdown)
--   - /api/finance-expenses-breakdown  (breakdown-tabel)
--   - /api/finance-expenses-dashboard  (categorie-grafiek + valt onder
--                                       "operationeel" in de 3-way split)
--
-- Geen backfill in deze migratie — kandidaat-tegenpartijen worden
-- voorgesteld in de PR-body, en Jeffrey wijst ze toe via de UI (of via
-- een aparte bevestigde counterparty-rule) zoals overal in deze tool.
-- Reden: automatisch koppelen op keyword kan fout zitten (bv. 'Total' =
-- brandstofmerk óf woord in omschrijving) en dit is financiële data —
-- voorstellen, niet opdringen.
--
-- Idempotent: INSERT ... WHERE NOT EXISTS. 2x draaien is veilig.
-- ============================================================================

BEGIN;

-- Accountant & administratie
INSERT INTO public.expense_categories (slug, label, color, is_active, is_internal)
SELECT 'accountant-administratie', 'Accountant & administratie', '#0d9488', true, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories WHERE slug = 'accountant-administratie'
);

-- Auto
INSERT INTO public.expense_categories (slug, label, color, is_active, is_internal)
SELECT 'auto', 'Auto', '#1e40af', true, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories WHERE slug = 'auto'
);

-- Post-check
DO $$
DECLARE
  n_new INT;
BEGIN
  SELECT COUNT(*) INTO n_new
    FROM public.expense_categories
   WHERE slug IN ('accountant-administratie', 'auto');
  RAISE NOTICE 'Nieuwe categorieën aanwezig: % / 2', n_new;
END$$;

COMMIT;

-- ROLLBACK (indien nodig — verwijder eerst alle categorisaties die eraan hangen):
-- DELETE FROM public.transaction_categorizations
--   WHERE category_id IN (
--     SELECT id FROM public.expense_categories
--     WHERE slug IN ('accountant-administratie', 'auto')
--   );
-- DELETE FROM public.expense_counterparty_rules
--   WHERE category_id IN (
--     SELECT id FROM public.expense_categories
--     WHERE slug IN ('accountant-administratie', 'auto')
--   );
-- DELETE FROM public.expense_categories WHERE slug IN ('accountant-administratie', 'auto');
