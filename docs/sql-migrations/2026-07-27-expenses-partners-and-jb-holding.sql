-- ============================================================================
-- Uitgaven-analyse — JB Holding (intern), Delo/Heylen (vennoten), Belastingdienst
-- Datum: 2026-07-27
-- Branch: fix/expenses-internal-and-partners
--
-- Bouwt bovenop 2026-07-27-expenses-internal-transfers.sql (#963). Vereist
-- dat die migratie eerst is gedraaid — 'intern-overboeking'-categorie en
-- is_internal-kolom bestaan al.
--
-- Wat:
--   1) Seed nieuwe categorie 'Winstuitkering vennoten' (is_internal=false;
--      telt mee als echte uitstroom, maar apart zichtbaar in breakdown).
--   2) Insert 4 nieuwe counterparty-rules:
--      - 'JB Holding B.V.'   → intern-overboeking       (eigen vennootschap)
--      - 'Delo commv'        → winstuitkering-vennoten  (compagnon)
--      - 'Heyleninvestments' → winstuitkering-vennoten  (vennoot)
--      - 'Belastingdienst'   → belastingen_heffingen    (bestaande cat)
--   3) Backfill: bestaande source='camt'-tx krijgen deze categorieën.
--      Voor Belastingdienst: ILIKE '%belastingdienst%' dekt varianten
--      ('Belastingdienst Apeldoorn' etc.); voor de 3 andere: exacte match.
--      Skip tx die al 'manual' override hebben (respecteer user-keuzes).
--
-- Idempotent: NOT EXISTS + skip-al-gecategoriseerd guards.
-- CAMT-flow ongemoeid: alleen transaction_categorizations krijgt rijen bij.
-- ============================================================================

BEGIN;

-- ── Stap 1: seed 'Winstuitkering vennoten' ──
INSERT INTO public.expense_categories (slug, label, color, is_active, is_internal)
SELECT 'winstuitkering-vennoten', 'Winstuitkering vennoten', '#a855f7', true, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories WHERE slug = 'winstuitkering-vennoten'
);

-- ── Stap 2: counterparty-rules voor toekomstige imports (exacte namen) ──
-- JB Holding → interne overboeking
INSERT INTO public.expense_counterparty_rules (match_counterparty, category_id, created_by_user_id)
SELECT
  'JB Holding B.V.',
  (SELECT id FROM public.expense_categories WHERE slug = 'intern-overboeking'),
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_counterparty_rules
  WHERE match_counterparty = 'JB Holding B.V.'
);

-- Delo commv → winstuitkering vennoten
INSERT INTO public.expense_counterparty_rules (match_counterparty, category_id, created_by_user_id)
SELECT
  'Delo commv',
  (SELECT id FROM public.expense_categories WHERE slug = 'winstuitkering-vennoten'),
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_counterparty_rules
  WHERE match_counterparty = 'Delo commv'
);

-- Heyleninvestments → winstuitkering vennoten
INSERT INTO public.expense_counterparty_rules (match_counterparty, category_id, created_by_user_id)
SELECT
  'Heyleninvestments',
  (SELECT id FROM public.expense_categories WHERE slug = 'winstuitkering-vennoten'),
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_counterparty_rules
  WHERE match_counterparty = 'Heyleninvestments'
);

-- Belastingdienst → belastingen_heffingen (bestaande categorie uit seed)
INSERT INTO public.expense_counterparty_rules (match_counterparty, category_id, created_by_user_id)
SELECT
  'Belastingdienst',
  (SELECT id FROM public.expense_categories WHERE slug = 'belastingen_heffingen'),
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_counterparty_rules
  WHERE match_counterparty = 'Belastingdienst'
);

-- ── Stap 3: backfill — pas rules toe op bestaande tx ──
-- Alleen matchende source='camt'-rijen. Skip tx met bestaande categorisatie
-- (respecteer manual + andere auto-rules). Belastingdienst via ILIKE-match
-- zodat varianten ook getagd worden. rule_id gekoppeld voor traceability.
DO $$
DECLARE
  cat_intern uuid;
  cat_venn   uuid;
  cat_bel    uuid;
  rule_jbh   uuid;
  rule_delo  uuid;
  rule_heyl  uuid;
  rule_bel   uuid;
  n_intern INT := 0;
  n_venn   INT := 0;
  n_bel    INT := 0;
BEGIN
  SELECT id INTO cat_intern FROM public.expense_categories WHERE slug = 'intern-overboeking';
  SELECT id INTO cat_venn   FROM public.expense_categories WHERE slug = 'winstuitkering-vennoten';
  SELECT id INTO cat_bel    FROM public.expense_categories WHERE slug = 'belastingen_heffingen';
  SELECT id INTO rule_jbh   FROM public.expense_counterparty_rules WHERE match_counterparty = 'JB Holding B.V.';
  SELECT id INTO rule_delo  FROM public.expense_counterparty_rules WHERE match_counterparty = 'Delo commv';
  SELECT id INTO rule_heyl  FROM public.expense_counterparty_rules WHERE match_counterparty = 'Heyleninvestments';
  SELECT id INTO rule_bel   FROM public.expense_counterparty_rules WHERE match_counterparty = 'Belastingdienst';

  -- JB Holding → intern-overboeking (exact naam)
  INSERT INTO public.transaction_categorizations
    (camt_transaction_id, category_id, source, rule_id, set_by_user_id, set_at)
  SELECT t.id, cat_intern, 'rule', rule_jbh, NULL, now()
  FROM public.camt_transactions t
  WHERE t.source = 'camt'
    AND t.counterparty_name = 'JB Holding B.V.'
    AND NOT EXISTS (
      SELECT 1 FROM public.transaction_categorizations c
      WHERE c.camt_transaction_id = t.id
    );
  GET DIAGNOSTICS n_intern = ROW_COUNT;
  RAISE NOTICE 'JB Holding → intern-overboeking: % nieuwe categorisaties', n_intern;

  -- Delo commv + Heyleninvestments → winstuitkering-vennoten (exact naam)
  INSERT INTO public.transaction_categorizations
    (camt_transaction_id, category_id, source, rule_id, set_by_user_id, set_at)
  SELECT
    t.id, cat_venn, 'rule',
    CASE WHEN t.counterparty_name = 'Delo commv'         THEN rule_delo
         WHEN t.counterparty_name = 'Heyleninvestments'  THEN rule_heyl
         ELSE NULL
    END,
    NULL, now()
  FROM public.camt_transactions t
  WHERE t.source = 'camt'
    AND t.counterparty_name IN ('Delo commv', 'Heyleninvestments')
    AND NOT EXISTS (
      SELECT 1 FROM public.transaction_categorizations c
      WHERE c.camt_transaction_id = t.id
    );
  GET DIAGNOSTICS n_venn = ROW_COUNT;
  RAISE NOTICE 'Delo + Heylen → winstuitkering-vennoten: % nieuwe categorisaties', n_venn;

  -- Belastingdienst → belastingen_heffingen (ILIKE-match voor varianten)
  INSERT INTO public.transaction_categorizations
    (camt_transaction_id, category_id, source, rule_id, set_by_user_id, set_at)
  SELECT t.id, cat_bel, 'rule', rule_bel, NULL, now()
  FROM public.camt_transactions t
  WHERE t.source = 'camt'
    AND t.counterparty_name ILIKE '%belastingdienst%'
    AND NOT EXISTS (
      SELECT 1 FROM public.transaction_categorizations c
      WHERE c.camt_transaction_id = t.id
    );
  GET DIAGNOSTICS n_bel = ROW_COUNT;
  RAISE NOTICE 'Belastingdienst (ILIKE) → belastingen_heffingen: % nieuwe categorisaties', n_bel;
END$$;

-- ── Post-check: bedragen per nieuwe koppeling ──
DO $$
DECLARE
  jbh_cnt INT; jbh_sum NUMERIC;
  ven_cnt INT; ven_sum NUMERIC;
  bel_cnt INT; bel_sum NUMERIC;
BEGIN
  SELECT COUNT(*), SUM(t.amount_cents) / 100.0
    INTO jbh_cnt, jbh_sum
    FROM public.camt_transactions t
    JOIN public.transaction_categorizations c ON c.camt_transaction_id = t.id
   WHERE c.rule_id = (SELECT id FROM public.expense_counterparty_rules WHERE match_counterparty = 'JB Holding B.V.');

  SELECT COUNT(*), SUM(t.amount_cents) / 100.0
    INTO ven_cnt, ven_sum
    FROM public.camt_transactions t
    JOIN public.transaction_categorizations c ON c.camt_transaction_id = t.id
    JOIN public.expense_categories ec ON ec.id = c.category_id
   WHERE ec.slug = 'winstuitkering-vennoten';

  SELECT COUNT(*), SUM(t.amount_cents) / 100.0
    INTO bel_cnt, bel_sum
    FROM public.camt_transactions t
    JOIN public.transaction_categorizations c ON c.camt_transaction_id = t.id
   WHERE c.rule_id = (SELECT id FROM public.expense_counterparty_rules WHERE match_counterparty = 'Belastingdienst');

  RAISE NOTICE 'JB Holding totaal:            % tx / % EUR', jbh_cnt, jbh_sum;
  RAISE NOTICE 'Winstuitkering vennoten:      % tx / % EUR', ven_cnt, ven_sum;
  RAISE NOTICE 'Belastingdienst (ILIKE):      % tx / % EUR', bel_cnt, bel_sum;
END$$;

COMMIT;

-- ROLLBACK (indien nodig):
-- DELETE FROM public.transaction_categorizations
--   WHERE rule_id IN (
--     SELECT id FROM public.expense_counterparty_rules
--     WHERE match_counterparty IN ('JB Holding B.V.','Delo commv','Heyleninvestments','Belastingdienst')
--   );
-- DELETE FROM public.expense_counterparty_rules
--   WHERE match_counterparty IN ('JB Holding B.V.','Delo commv','Heyleninvestments','Belastingdienst');
-- DELETE FROM public.expense_categories WHERE slug = 'winstuitkering-vennoten';
