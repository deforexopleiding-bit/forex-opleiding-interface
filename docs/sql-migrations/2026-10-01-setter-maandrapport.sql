-- 2026-10-01-setter-maandrapport.sql
--
-- STATUS: TER REVIEW — handmatig draaien in de Supabase SQL-editor.
--
-- Setter-maandrapport (PR C, feat/setter-maandrapport): per setter per maand
-- een rapport = vaste maandvergoeding + commissie (uit setter_ledger_entries,
-- PR B). Statussen concept → goedgekeurd → uitbetaald. Alle bedragen incl. btw.
--
-- VOLGORDE: eerst 2026-10-01-setter-commissie-facturen.sql (PR B,
-- setter_ledger_entries.betaal_datum), dan deze.
--
-- ⚠ BLOKKEREND VOOR DE RAPPORTEN-FUNCTIE (draai vóór of direct bij de merge):
--   - api/setter-reports.js, api/_lib/setter-report-core.js en de cron
--     /api/cron/generate-setter-reports lezen/schrijven setter_monthly_reports,
--     setter_monthly_report_lines, setter_config.monthly_fee en
--     setter_ledger_entries.monthly_report_id.
--   - Zonder deze migratie: de tab Rapporten toont "migratie nog niet
--     gedraaid", de cron antwoordt 200 { skipped: 'migratie_ontbreekt' },
--     genereren/goedkeuren geeft 503. De rest van de Commissie-module blijft
--     werken. LET OP: de oude uitbetaalronde (setter-payout-run) is in deze PR
--     uitgeschakeld (410) — tot deze migratie draait is er voor setters dus
--     GEEN uitbetaalpad (er staat nu ook niets uit: grootboek leeg, dry-run aan).
--
-- Zelf-voorzienend: CREATE TABLE IF NOT EXISTS, CHECKs, UNIQUE, RLS. Elk
-- statement staat los (SQL-editor knipt op statement-grenzen): geen
-- TEMP-tabellen, geen DO-blocks. Herhaalbaar.

-- 1) Vaste maandvergoeding per setter (incl. btw). Default 0 = geen vergoeding.
ALTER TABLE public.setter_config
  ADD COLUMN IF NOT EXISTS monthly_fee numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE public.setter_config
  DROP CONSTRAINT IF EXISTS setter_config_monthly_fee_check;

ALTER TABLE public.setter_config
  ADD CONSTRAINT setter_config_monthly_fee_check CHECK (monthly_fee >= 0);

COMMENT ON COLUMN public.setter_config.monthly_fee IS
  'Vaste maandvergoeding (incl. btw) in het setter-maandrapport. Telt voor maand M '
  'als is_active en effective_from <= de 1e van M.';

-- 2) Rapporten: 1 per (setter, maand).
CREATE TABLE IF NOT EXISTS public.setter_monthly_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  period_month      date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  status            text NOT NULL DEFAULT 'concept'
                      CHECK (status IN ('concept', 'goedgekeurd', 'uitbetaald')),
  fee_total         numeric(10,2) NOT NULL DEFAULT 0,
  commission_total  numeric(10,2) NOT NULL DEFAULT 0,
  total             numeric(10,2) NOT NULL DEFAULT 0,
  generated_at      timestamptz,
  approved_at       timestamptz,
  approved_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_at           timestamptz,
  paid_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT setter_monthly_reports_setter_month_key UNIQUE (setter_user_id, period_month)
);

CREATE INDEX IF NOT EXISTS idx_setter_monthly_reports_month
  ON public.setter_monthly_reports (period_month);

COMMENT ON TABLE public.setter_monthly_reports IS
  'Setter-maandrapport: vaste vergoeding + commissie (setter_ledger_entries op '
  'betaal_datum). concept wordt elke run herberekend; goedgekeurd/uitbetaald nooit.';

-- 3) Regels van een rapport (bij elke herberekening volledig herbouwd).
CREATE TABLE IF NOT EXISTS public.setter_monthly_report_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        uuid NOT NULL REFERENCES public.setter_monthly_reports(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('vaste_vergoeding', 'commissie')),
  label            text NOT NULL,
  ledger_entry_id  uuid REFERENCES public.setter_ledger_entries(id) ON DELETE SET NULL,
  invoice_id       uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  deal_id          uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  customer_id      uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  betaal_datum     date,
  basis            numeric(10,2),
  pct              numeric(5,2),
  amount           numeric(10,2) NOT NULL,
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_setter_monthly_report_lines_report
  ON public.setter_monthly_report_lines (report_id);

-- 4) Koppeling grootboek → rapport (een regel hoort bij precies één rapport;
--    bij "uitbetaald" gaan de gekoppelde regels op status 'uitbetaald').
ALTER TABLE public.setter_ledger_entries
  ADD COLUMN IF NOT EXISTS monthly_report_id uuid
  REFERENCES public.setter_monthly_reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_setter_ledger_monthly_report
  ON public.setter_ledger_entries (monthly_report_id);

-- 5) RLS — spiegel van de setter-tabellen: setter ziet eigen rijen,
--    manager/admin/super_admin alles. Writes alleen via service_role.
ALTER TABLE public.setter_monthly_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS setter_monthly_reports_select ON public.setter_monthly_reports;

CREATE POLICY setter_monthly_reports_select ON public.setter_monthly_reports
  FOR SELECT TO authenticated USING (
    setter_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

ALTER TABLE public.setter_monthly_report_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS setter_monthly_report_lines_select ON public.setter_monthly_report_lines;

CREATE POLICY setter_monthly_report_lines_select ON public.setter_monthly_report_lines
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.setter_monthly_reports r
       WHERE r.id = setter_monthly_report_lines.report_id
         AND (r.setter_user_id = auth.uid()
              OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 6) ⚠ APART STATEMENT — Romy's vaste maandvergoeding: € 750 incl. btw.
--    Romy = profiles.id e5006a5f-463a-46c8-ba04-467503ab8cc7 (appointmentsetter).
--    Bewust los van de schema-wijzigingen hierboven: controleer bedrag en id
--    vóór je dit draait.
-- ═══════════════════════════════════════════════════════════════════════
UPDATE public.setter_config
   SET monthly_fee = 750
 WHERE user_id = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT user_id, pct, is_active, effective_from, monthly_fee FROM public.setter_config;
--   -- Romy: monthly_fee = 750.00
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public' AND table_name LIKE 'setter_monthly_report%';   -- 2 rijen
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'setter_ledger_entries'
--    AND column_name IN ('betaal_datum', 'monthly_report_id');                    -- 2 rijen
-- SELECT tablename, policyname FROM pg_policies
--  WHERE tablename LIKE 'setter_monthly_report%';                                 -- 2 rijen
--
-- ROLLBACK
--   ALTER TABLE public.setter_ledger_entries DROP COLUMN IF EXISTS monthly_report_id;
--   DROP TABLE IF EXISTS public.setter_monthly_report_lines;
--   DROP TABLE IF EXISTS public.setter_monthly_reports;
--   ALTER TABLE public.setter_config DROP CONSTRAINT IF EXISTS setter_config_monthly_fee_check;
--   ALTER TABLE public.setter_config DROP COLUMN IF EXISTS monthly_fee;
