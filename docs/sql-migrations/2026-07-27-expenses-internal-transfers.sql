-- ============================================================================
-- Uitgaven-analyse — interne overboekingen markeren + backfill ING→PayPal
-- Datum: 2026-07-27
-- Branch: fix/expenses-internal-transfers
--
-- Wat: bewezen dat ING→PayPal-oplaadtransacties (counterparty_iban =
-- 'LU89751000135104200E' OR counterparty_name ILIKE '%paypal%') dubbel geteld
-- worden in de uitgaven-analyse. Ze zijn INTERNE overboekingen naar het eigen
-- PayPal-saldo; de echte uitgave staat aan de PayPal-kant.
--
-- Aanpak (route a uit recon):
--   1) is_internal-flag toevoegen aan expense_categories.
--   2) Systeem-categorie "Interne overboeking" seeden met is_internal=true.
--   3) expense_counterparty_rule aanmaken zodat toekomstige uploads waarvan
--      counterparty_name exact 'PayPal Europe S.a.r.l. et Cie S.C.A' is,
--      automatisch getagd worden.
--   4) Backfill: alle bestaande source='camt'-rijen die op IBAN of naam
--      matchen krijgen deze categorie via transaction_categorizations
--      (source='rule', met rule_id gekoppeld voor traceability).
--
-- CAMT-flow ONGEMOEID: geen kolommen op camt_transactions gewijzigd, geen
-- bedragen aangepast. Alleen categorie-koppelingen bijgemaakt. Bank-view en
-- factuur-matching lezen niet uit transaction_categorizations → geen impact.
--
-- Idempotent:
--   - Kolom-toevoeging via IF NOT EXISTS.
--   - Categorie via INSERT ... WHERE NOT EXISTS.
--   - Rule via INSERT ... WHERE NOT EXISTS.
--   - Backfill via UPSERT met onConflict=camt_transaction_id, en ALLEEN
--     insert als er nog geen categorisatie is (spaart manuele overrides).
-- ============================================================================

BEGIN;

-- ── Stap 1: is_internal-kolom op expense_categories ──
ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.expense_categories.is_internal IS
  'true = categorie is een interne overboeking (bv. ING->PayPal-oplaad); default uit uitgaven-analyse gefilterd.';

-- ── Stap 2: seed systeem-categorie "Interne overboeking" ──
INSERT INTO public.expense_categories (slug, label, color, is_active, is_internal)
SELECT 'intern-overboeking', 'Interne overboeking', '#94a3b8', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories WHERE slug = 'intern-overboeking'
);

-- ── Stap 3: counterparty-rule voor toekomstige imports (exacte naam) ──
-- 866 van de 868 ING-tx hebben counterparty_name = 'PayPal Europe S.a.r.l. et
-- Cie S.C.A' (uit query 5). Deze rule zorgt dat toekomstige CAMT-uploads
-- automatisch getagd worden via de auto-categorize-hook (deze PR voegt die
-- ook toe aan finance-bank-camt-upload.js).
INSERT INTO public.expense_counterparty_rules (match_counterparty, category_id, created_by_user_id)
SELECT
  'PayPal Europe S.a.r.l. et Cie S.C.A',
  (SELECT id FROM public.expense_categories WHERE slug = 'intern-overboeking'),
  NULL   -- system-created rule
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_counterparty_rules
  WHERE match_counterparty = 'PayPal Europe S.a.r.l. et Cie S.C.A'
);

-- ── Stap 4: backfill — alle bestaande matchende ING-tx krijgen categorie ──
-- Match op IBAN (866 tx) EN naam-ILIKE (nog 2 outliers). Skip tx die al een
-- manual override hebben (source='manual') — die respecteren we.
DO $$
DECLARE
  cat_id  uuid;
  rule_id uuid;
  n_inserted INT := 0;
BEGIN
  SELECT id INTO cat_id  FROM public.expense_categories WHERE slug = 'intern-overboeking';
  SELECT id INTO rule_id FROM public.expense_counterparty_rules
    WHERE match_counterparty = 'PayPal Europe S.a.r.l. et Cie S.C.A';

  IF cat_id IS NULL THEN
    RAISE EXCEPTION 'intern-overboeking category niet gevonden';
  END IF;

  INSERT INTO public.transaction_categorizations
    (camt_transaction_id, category_id, source, rule_id, set_by_user_id, set_at)
  SELECT
    t.id, cat_id, 'rule', rule_id, NULL, now()
  FROM public.camt_transactions t
  WHERE t.source = 'camt'
    AND (
         t.counterparty_iban = 'LU89751000135104200E'
      OR t.counterparty_name ILIKE '%paypal%'
    )
    -- Skip tx die al een categorisatie hebben (respecteer manual + andere rules).
    AND NOT EXISTS (
      SELECT 1 FROM public.transaction_categorizations c
      WHERE c.camt_transaction_id = t.id
    );

  GET DIAGNOSTICS n_inserted = ROW_COUNT;
  RAISE NOTICE 'Interne overboekingen gecategoriseerd (backfill): % rijen', n_inserted;
END$$;

-- ── Post-check ──
DO $$
DECLARE
  n_tagged INT;
  sum_eur  NUMERIC;
BEGIN
  SELECT COUNT(*), SUM(t.amount_cents) / 100.0
    INTO n_tagged, sum_eur
    FROM public.camt_transactions t
    JOIN public.transaction_categorizations c ON c.camt_transaction_id = t.id
    JOIN public.expense_categories ec ON ec.id = c.category_id
   WHERE ec.slug = 'intern-overboeking';
  RAISE NOTICE 'Totaal getagd als interne overboeking: % tx / % EUR', n_tagged, sum_eur;
END$$;

COMMIT;

-- ROLLBACK (indien nodig):
-- DELETE FROM public.transaction_categorizations
--   WHERE category_id = (SELECT id FROM public.expense_categories WHERE slug='intern-overboeking');
-- DELETE FROM public.expense_counterparty_rules
--   WHERE match_counterparty = 'PayPal Europe S.a.r.l. et Cie S.C.A';
-- DELETE FROM public.expense_categories WHERE slug = 'intern-overboeking';
-- ALTER TABLE public.expense_categories DROP COLUMN IF EXISTS is_internal;
