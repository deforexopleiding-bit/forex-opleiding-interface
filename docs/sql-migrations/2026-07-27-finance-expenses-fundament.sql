-- ============================================================================
-- Finance Uitgaven-analyse PR 1a — DB-fundament
-- Datum: 2026-07-27
-- Branch: feat/finance-expenses-pr1a-parser
--
-- Voegt toe:
--   1. source-kolom op camt_transactions (default 'camt'; bestaande rijen
--      krijgen 'camt' via default). PayPal-import gebruikt 'paypal'.
--   2. expense_categories — 12 seed-categorieën voor uitgaven-analyse.
--   3. expense_counterparty_rules — mapping counterparty_name → categorie
--      (simpelste regel-vorm: exacte match op counterparty_name).
--   4. transaction_categorizations — per-transactie categorie-staat
--      (source='rule' via counterparty-mapping OF 'manual' losse override).
--   5. RLS: authenticated-read, writes via service-role (zelfde patroon
--      als camt_transactions / bank_transactions).
--
-- Additief: bestaande CAMT-flow, factuur-matching en indexes ongemoeid.
-- Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- ============================================================================

BEGIN;

-- ── 1. source-kolom op camt_transactions ──
-- Default 'camt' → bestaande rijen krijgen automatisch 'camt'. PayPal-parser
-- schrijft 'paypal'. Later kunnen andere bronnen (Adyen/Mollie) eigen slug krijgen.
ALTER TABLE public.camt_transactions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'camt';

CREATE INDEX IF NOT EXISTS idx_camt_tx_source
  ON public.camt_transactions (source);

-- ── 2. expense_categories ──
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  label        text NOT NULL,
  color        text,                                  -- hex-string voor UI-chips/charts
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed: 12 categorieën met onderscheidende colors. Slugs stabiel (zonder
-- ampersand/spaties) zodat ze in code + query's veilig zijn.
INSERT INTO public.expense_categories (slug, label, color) VALUES
  ('marketing_advertenties',    'Marketing & advertenties',       '#ef4444'),  -- rood
  ('software_tools',            'Software & tools',               '#3b82f6'),  -- blauw
  ('personeel_freelance',       'Personeel & freelance',          '#8b5cf6'),  -- paars
  ('betaaldiensten_bankkosten', 'Betaaldiensten & bankkosten',    '#64748b'),  -- grijs-slate
  ('kantoor_huisvesting',       'Kantoor & huisvesting',          '#f97316'),  -- oranje
  ('reis_verblijf',             'Reis & verblijf',                '#14b8a6'),  -- teal
  ('opleiding_content',         'Opleiding & content',            '#84cc16'),  -- lime
  ('belastingen_heffingen',     'Belastingen & heffingen',        '#dc2626'),  -- dieprood
  ('verzekeringen',             'Verzekeringen',                  '#0ea5e9'),  -- sky-blauw
  ('eten_horeca',               'Eten & horeca',                  '#eab308'),  -- geel
  ('telefonie_internet',        'Telefonie & internet',           '#06b6d4'),  -- cyan
  ('overig',                    'Overig',                         '#94a3b8')   -- neutraal grijs
ON CONFLICT (slug) DO NOTHING;

-- ── 3. expense_counterparty_rules ──
-- Simpelste regelvorm: exacte match op counterparty_name → categorie.
-- (PR 2 kan match_type toevoegen voor fuzzy/description-matching.)
CREATE TABLE IF NOT EXISTS public.expense_counterparty_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_counterparty  text NOT NULL,
  category_id         uuid NOT NULL REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  created_by_user_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_counterparty)
);

CREATE INDEX IF NOT EXISTS idx_expense_rules_category
  ON public.expense_counterparty_rules (category_id);

-- updated_at trigger (consistent met andere finance-tabellen).
CREATE OR REPLACE FUNCTION public.expense_counterparty_rules_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_rules_touch ON public.expense_counterparty_rules;
CREATE TRIGGER trg_expense_rules_touch
  BEFORE UPDATE ON public.expense_counterparty_rules
  FOR EACH ROW EXECUTE FUNCTION public.expense_counterparty_rules_touch_updated_at();

-- ── 4. transaction_categorizations ──
-- Per-transactie definitieve categorisatie. Manual overrides overrulen rule-
-- based via UPSERT met 'manual'; rule-based invulling gebeurt bij import of
-- na regel-toepassing.
CREATE TABLE IF NOT EXISTS public.transaction_categorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camt_transaction_id   uuid UNIQUE NOT NULL REFERENCES public.camt_transactions(id) ON DELETE CASCADE,
  category_id           uuid NOT NULL REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  source                text NOT NULL CHECK (source IN ('rule','manual')),
  rule_id               uuid REFERENCES public.expense_counterparty_rules(id) ON DELETE SET NULL,
  set_by_user_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  set_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tx_cat_category
  ON public.transaction_categorizations (category_id);

CREATE INDEX IF NOT EXISTS idx_tx_cat_rule
  ON public.transaction_categorizations (rule_id)
  WHERE rule_id IS NOT NULL;

-- ── 5. RLS: authenticated-read, writes via service-role ──
ALTER TABLE public.expense_categories             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_counterparty_rules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_categorizations    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_categories_select             ON public.expense_categories;
DROP POLICY IF EXISTS expense_categories_write_svc          ON public.expense_categories;
DROP POLICY IF EXISTS expense_counterparty_rules_select     ON public.expense_counterparty_rules;
DROP POLICY IF EXISTS expense_counterparty_rules_write_svc  ON public.expense_counterparty_rules;
DROP POLICY IF EXISTS transaction_categorizations_select    ON public.transaction_categorizations;
DROP POLICY IF EXISTS transaction_categorizations_write_svc ON public.transaction_categorizations;

CREATE POLICY expense_categories_select ON public.expense_categories
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY expense_categories_write_svc ON public.expense_categories
  FOR ALL USING (false) WITH CHECK (false);

CREATE POLICY expense_counterparty_rules_select ON public.expense_counterparty_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY expense_counterparty_rules_write_svc ON public.expense_counterparty_rules
  FOR ALL USING (false) WITH CHECK (false);

CREATE POLICY transaction_categorizations_select ON public.transaction_categorizations
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY transaction_categorizations_write_svc ON public.transaction_categorizations
  FOR ALL USING (false) WITH CHECK (false);

COMMIT;

-- ============================================================================
-- Verificatie na uitvoering:
--   SELECT count(*) FROM expense_categories;                          -- 12
--   SELECT slug, label FROM expense_categories ORDER BY label;
--   SELECT count(*) FROM camt_transactions WHERE source = 'camt';     -- alle bestaande
--   SELECT count(*) FROM camt_transactions WHERE source = 'paypal';   -- 0 direct na migratie
--   SELECT * FROM pg_policies WHERE tablename IN
--     ('expense_categories','expense_counterparty_rules','transaction_categorizations');
-- ============================================================================
