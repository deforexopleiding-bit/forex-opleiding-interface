-- ============================================================================
-- Finance Module — Fase 1: DB-fundament
-- Datum: 2026-05-30
-- Branch: feature/finance-fase-1-fundament
--
-- 17 nieuwe tabellen + 2 kolom-uitbreidingen op customers + indexes + RLS.
-- Hergebruikt klanten-module infrastructuur (whatsapp_*, letters, audit_log).
--
-- ── Verifie-queries na uitvoeren ────────────────────────────────────────────
-- SELECT count(*) FROM lead_sources;            -- moet 7 zijn (seed)
-- SELECT count(*) FROM deals;                   -- 0 (leeg, klaar voor gebruik)
-- SELECT * FROM pg_policies WHERE tablename = 'deals';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='customers' AND column_name IN ('ghl_contact_id','risk_tag_auto');
-- ============================================================================

BEGIN;

-- ── A. KOLOM-UITBREIDINGEN customers ────────────────────────────────────────
-- ghl_contact_id bestaat al via api/customer.js WRITABLE_FIELDS, maar
-- IF NOT EXISTS voor zekerheid.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS ghl_contact_id text;
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS risk_tag_auto boolean DEFAULT false;

-- ── B. NIEUWE TABELLEN ─────────────────────────────────────────────────────

-- 1. deals — financieel hoofdcontract per klant
CREATE TABLE IF NOT EXISTS public.deals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  total_amount           numeric(10,2),
  start_date             date,
  end_date               date,
  status                 text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','paused','completed','delinquent','disputed','deceased')),
  sales_user_id          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  source                 text,
  parent_deal_id         uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  downpayment_amount     numeric(10,2),
  downpayment_paid_at    timestamptz,
  first_call_at          timestamptz,
  first_call_ghl_event_id text,
  quote_reference        text,
  notes                  text,
  acquisition_cost       numeric(10,2),   -- CAC, "binnenkort" gevuld via marketing-integratie
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz
);

-- 2. subscriptions — termijnen / abonnementen binnen deal
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                     uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  amount                      numeric(10,2),
  vat_percentage              smallint DEFAULT 21,
  term_count                  integer,
  start_date                  date,
  teamleader_subscription_id  text,
  status                      text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','paused','completed')),
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- 3. bonuses — sales-bonusrechten per deal
CREATE TABLE IF NOT EXISTS public.bonuses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
  sales_user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  amount                numeric(10,2) NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','earned','invoiced','paid','under_threshold')),
  earned_at             timestamptz,
  paid_at               timestamptz,
  month_invoice_period  date,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- 4. sales_bonus_configs — % en drempel per sales-user
CREATE TABLE IF NOT EXISTS public.sales_bonus_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  percentage        numeric(5,2) NOT NULL DEFAULT 3.00,
  threshold_amount  numeric(10,2) NOT NULL DEFAULT 1000.00,
  active_from       date NOT NULL DEFAULT CURRENT_DATE,
  active_until      date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 5. invoices — facturen
CREATE TABLE IF NOT EXISTS public.invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  deal_id         uuid REFERENCES public.deals(id) ON DELETE SET NULL,  -- nullable voor historisch
  tl_invoice_id   text,  -- nullable bij handmatige
  invoice_number  text NOT NULL,
  amount_total    numeric(10,2) NOT NULL,
  amount_paid     numeric(10,2) DEFAULT 0,
  vat_amount      numeric(10,2),
  issue_date      date NOT NULL DEFAULT CURRENT_DATE,
  due_date        date,
  paid_date       date,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('concept','open','partially_paid','paid','overdue','credited','writeoff')),
  is_manual       boolean NOT NULL DEFAULT false,
  pushed_to_tl    boolean NOT NULL DEFAULT false,
  is_historical   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Unique per (invoice_number, jaar) — voorkomt dubbele factuurnummers per jaar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_number_year
  ON public.invoices (invoice_number, (EXTRACT(YEAR FROM issue_date)));

-- 6. payments — betalingen (matched aan invoice of unmatched)
CREATE TABLE IF NOT EXISTS public.payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  invoice_id      uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  amount          numeric(10,2) NOT NULL,
  payment_date    date NOT NULL,
  payment_method  text,
  source          text CHECK (source IN ('ing','tl','manual')),
  match_score     smallint,
  matched_by      text,  -- 'auto' of user-uuid-string
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 7. bank_accounts — verbonden bankrekeningen (GoCardless)
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gocardless_account_id text,
  iban                  text,
  currency              text NOT NULL DEFAULT 'EUR',
  current_balance       numeric(10,2),
  last_sync_at          timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- 9. bank_categories (eerst aanmaken — bank_transactions refereert ernaar)
CREATE TABLE IF NOT EXISTS public.bank_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  parent_id   uuid REFERENCES public.bank_categories(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 8. bank_transactions
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id            uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  transaction_date           date NOT NULL,
  amount                     numeric(10,2) NOT NULL,
  direction                  text NOT NULL CHECK (direction IN ('in','out')),
  counterparty_iban          text,
  counterparty_name          text,
  description                text,
  category_id                uuid REFERENCES public.bank_categories(id) ON DELETE SET NULL,
  matched_payment_id         uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  is_categorized_manually    boolean NOT NULL DEFAULT false,
  flag_unusual               boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

-- 10. bank_category_rules — auto-categorise regels
CREATE TABLE IF NOT EXISTS public.bank_category_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id           uuid NOT NULL REFERENCES public.bank_categories(id) ON DELETE CASCADE,
  counterparty_pattern  text,
  description_pattern   text,
  priority              integer NOT NULL DEFAULT 100,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- 11. dunning_trajectories — wanbetaler-trajecten
CREATE TABLE IF NOT EXISTS public.dunning_trajectories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','resolved')),
  pause_reason       text,
  pause_until        timestamptz,
  pause_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  current_phase_id   uuid,  -- FK ná dunning_phases creatie (zie ALTER hieronder)
  started_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- 12. dunning_phases — fasen binnen traject (whatsapp/letter/email/internal)
CREATE TABLE IF NOT EXISTS public.dunning_phases (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trajectory_id              uuid NOT NULL REFERENCES public.dunning_trajectories(id) ON DELETE CASCADE,
  phase_number               integer NOT NULL,
  channel                    text NOT NULL CHECK (channel IN ('whatsapp','letter','email','internal')),
  template_id                uuid,  -- FK kan later naar whatsapp_templates of letter_templates (polymorf)
  trigger_days_after_due     integer,
  executed_at                timestamptz,
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','sent','replied','converted')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trajectory_id, phase_number)
);

-- FK current_phase_id → dunning_phases (na beide tabellen).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dunning_trajectories_current_phase_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE public.dunning_trajectories
             ADD CONSTRAINT dunning_trajectories_current_phase_id_fkey
             FOREIGN KEY (current_phase_id) REFERENCES public.dunning_phases(id) ON DELETE SET NULL';
  END IF;
END$$;

-- 13. payment_promises — betaalbeloften via WhatsApp/email/phone
CREATE TABLE IF NOT EXISTS public.payment_promises (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  dunning_trajectory_id    uuid REFERENCES public.dunning_trajectories(id) ON DELETE SET NULL,
  promised_date            date,
  promised_amount          numeric(10,2),
  source                   text CHECK (source IN ('whatsapp','email','phone','in_person')),
  note                     text,
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','fulfilled','broken')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz
);

-- 14. forecast_scenarios — what-if scenario's voor cashflow
CREATE TABLE IF NOT EXISTS public.forecast_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  parameters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 15. monthly_reports — gegenereerde maand-PDF's
CREATE TABLE IF NOT EXISTS public.monthly_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_year   integer NOT NULL,
  period_month  smallint NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  pdf_url       text,
  recipients    text[],
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_year, period_month)
);

-- 16. lead_sources — CAC-attributie + deal.source dropdown
CREATE TABLE IF NOT EXISTS public.lead_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 17. user_dashboard_layouts — gepersonaliseerde widget-volgorde
CREATE TABLE IF NOT EXISTS public.user_dashboard_layouts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  widget_order_json     jsonb NOT NULL DEFAULT '[]'::jsonb,
  widgets_visible_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- ── C. SEED lead_sources (idempotent via ON CONFLICT) ──────────────────────
INSERT INTO public.lead_sources (name) VALUES
  ('Lisa (IG)'),
  ('Referral'),
  ('Google Ads'),
  ('Meta Ads'),
  ('Podcast'),
  ('Organisch'),
  ('Overig')
ON CONFLICT (name) DO NOTHING;

-- ── D. INDEXES ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_deals_customer            ON public.deals (customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_sales_user          ON public.deals (sales_user_id);
CREATE INDEX IF NOT EXISTS idx_deals_status              ON public.deals (status);

CREATE INDEX IF NOT EXISTS idx_subs_deal                 ON public.subscriptions (deal_id);
CREATE INDEX IF NOT EXISTS idx_subs_status               ON public.subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_bonuses_deal              ON public.bonuses (deal_id);
CREATE INDEX IF NOT EXISTS idx_bonuses_sales_user        ON public.bonuses (sales_user_id);
CREATE INDEX IF NOT EXISTS idx_bonuses_status            ON public.bonuses (status);
CREATE INDEX IF NOT EXISTS idx_bonuses_month             ON public.bonuses (month_invoice_period);

CREATE INDEX IF NOT EXISTS idx_invoices_customer         ON public.invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_deal             ON public.invoices (deal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status           ON public.invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_due              ON public.invoices (due_date);

CREATE INDEX IF NOT EXISTS idx_payments_customer         ON public.payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice          ON public.payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_date             ON public.payments (payment_date);

CREATE INDEX IF NOT EXISTS idx_bank_tx_account           ON public.bank_transactions (bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_tx_date              ON public.bank_transactions (transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_tx_matched           ON public.bank_transactions (matched_payment_id);

CREATE INDEX IF NOT EXISTS idx_dunning_customer          ON public.dunning_trajectories (customer_id);
CREATE INDEX IF NOT EXISTS idx_dunning_status            ON public.dunning_trajectories (status);
CREATE INDEX IF NOT EXISTS idx_dunning_phases_traj       ON public.dunning_phases (trajectory_id);
CREATE INDEX IF NOT EXISTS idx_dunning_phases_executed   ON public.dunning_phases (executed_at);

CREATE INDEX IF NOT EXISTS idx_promises_customer         ON public.payment_promises (customer_id);
CREATE INDEX IF NOT EXISTS idx_promises_status           ON public.payment_promises (status);

-- ── E. RLS — authenticated-read-all, schrijven via API/service-role ────────
-- Pattern: consistent met klanten-module (migratie 003 + 012).
-- Helper: één macro-achtige DO-block voor alle nieuwe tabellen.
DO $$
DECLARE
  t text;
  tabs text[] := ARRAY[
    'deals','subscriptions','bonuses','sales_bonus_configs',
    'invoices','payments','bank_accounts','bank_transactions',
    'bank_categories','bank_category_rules',
    'dunning_trajectories','dunning_phases','payment_promises',
    'forecast_scenarios','monthly_reports','lead_sources','user_dashboard_layouts'
  ];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- SELECT: authenticated users (consistent met klanten-module PII-pattern).
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (auth.uid() IS NOT NULL)', t, t);
    -- INSERT/UPDATE/DELETE: false → alleen service_role (supabaseAdmin) schrijft via API.
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (false)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (false) WITH CHECK (false)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_delete ON public.%I FOR DELETE USING (false)', t, t);
  END LOOP;
END$$;

COMMIT;

-- ============================================================================
-- ROLLBACK (handmatig — bij issues binnen rollback-window)
-- ============================================================================
-- BEGIN;
--   -- Drop in reverse FK-order.
--   DROP TABLE IF EXISTS public.user_dashboard_layouts;
--   DROP TABLE IF EXISTS public.monthly_reports;
--   DROP TABLE IF EXISTS public.lead_sources;
--   DROP TABLE IF EXISTS public.forecast_scenarios;
--   DROP TABLE IF EXISTS public.payment_promises;
--   ALTER TABLE IF EXISTS public.dunning_trajectories DROP CONSTRAINT IF EXISTS dunning_trajectories_current_phase_id_fkey;
--   DROP TABLE IF EXISTS public.dunning_phases;
--   DROP TABLE IF EXISTS public.dunning_trajectories;
--   DROP TABLE IF EXISTS public.bank_category_rules;
--   DROP TABLE IF EXISTS public.bank_transactions;
--   DROP TABLE IF EXISTS public.bank_categories;
--   DROP TABLE IF EXISTS public.bank_accounts;
--   DROP TABLE IF EXISTS public.payments;
--   DROP TABLE IF EXISTS public.invoices;
--   DROP TABLE IF EXISTS public.sales_bonus_configs;
--   DROP TABLE IF EXISTS public.bonuses;
--   DROP TABLE IF EXISTS public.subscriptions;
--   DROP TABLE IF EXISTS public.deals;
--   ALTER TABLE public.customers DROP COLUMN IF EXISTS risk_tag_auto;
--   -- ghl_contact_id bewust BEHOUDEN (was al via klanten-module).
-- COMMIT;
