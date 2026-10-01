-- 2026-10-01-setter-rapport-btw.sql
--
-- STATUS: TER REVIEW — handmatig draaien in de Supabase SQL-editor.
--
-- Setter-maandrapport met btw-uitsplitsing (PR feat/setter-rapport-btw).
-- Draai NA 2026-10-01-setter-maandrapport.sql (die is al gedraaid).
--
-- ⚠ BLOKKEREND — DRAAI VÓÓR DE MERGE (inclusief stap 3, Romy → 650):
--   - api/_lib/setter-report-core.js schrijft bij "Rapport genereren /
--     bijwerken", "Goedkeuren" en de maandcron de kolommen hieronder BIJ
--     NAAM. Zonder deze migratie faalt elke generatie met een
--     kolomfout → MIGRATIE_ONTBREEKT (POST 503, cron 200 skipped); er wordt
--     dan niets geschreven of verwijderd. Lezen (tab Rapporten) blijft werken
--     via een fallback op de oude kolommen.
--   - setter_config.monthly_fee betekent na deze PR EXCL. btw. Blijft Romy op
--     750 staan, dan wordt haar vergoeding 750 excl. = 907,50 incl. Daarom
--     stap 3 tegelijk draaien.
--
-- Elk statement staat los (SQL-editor knipt op statement-grenzen): geen
-- TEMP-tabellen, geen DO-blocks. Herhaalbaar (IF NOT EXISTS / idempotente
-- UPDATE).
--
-- BETEKENIS VAN DE KOLOMMEN (rapport):
--   btw_pct          tarief waarmee dit rapport is berekend (21.00). NULL =
--                    rapport van vóór deze migratie (bedragen toen als incl.
--                    opgeslagen; de API splitst die alleen voor weergave).
--   fee_excl         vaste vergoeding excl. btw (= setter_config.monthly_fee)
--   fee_btw          round2(fee_excl × btw_pct / 100)
--   fee_incl         fee_excl + fee_btw
--   commission_excl  Σ regels: round2(commissie_incl / (1 + btw_pct/100))
--   commission_btw   Σ regels: commissie_incl − commissie_excl
--   commission_incl  Σ setter_ledger_entries.amount (de commissie zoals
--                    geboekt, incl. btw — ongewijzigd)
--   total_excl/_btw/_incl  fee_* + commission_*
--   fee_total / commission_total / total  (bestaand) blijven gevuld als
--                    alias van de INCL-bedragen (fee_incl / commission_incl /
--                    total_incl), zodat oudere lezers incl. blijven zien.
-- REGELS: btw_pct, amount_excl, amount_btw, amount_incl per regel;
--   bestaande `amount` = amount_incl. Totalen = som van de afgeronde regels.

-- 1) Rapport-kolommen.
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS btw_pct numeric(5,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS fee_excl numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS fee_btw numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS fee_incl numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS commission_excl numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS commission_btw numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS commission_incl numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS total_excl numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS total_btw numeric(10,2);
ALTER TABLE public.setter_monthly_reports ADD COLUMN IF NOT EXISTS total_incl numeric(10,2);

COMMENT ON COLUMN public.setter_monthly_reports.btw_pct IS
  'Btw-tarief (%) waarmee dit rapport berekend is. NULL = rapport van vóór de btw-uitsplitsing (bedragen incl.).';
COMMENT ON COLUMN public.setter_monthly_reports.fee_excl IS 'Vaste vergoeding excl. btw (setter_config.monthly_fee).';
COMMENT ON COLUMN public.setter_monthly_reports.commission_incl IS 'Commissie incl. btw = Σ setter_ledger_entries.amount in dit rapport.';
COMMENT ON COLUMN public.setter_monthly_reports.total IS 'Alias van total_incl (backward-compat).';

-- 2) Regel-kolommen.
ALTER TABLE public.setter_monthly_report_lines ADD COLUMN IF NOT EXISTS btw_pct numeric(5,2);
ALTER TABLE public.setter_monthly_report_lines ADD COLUMN IF NOT EXISTS amount_excl numeric(10,2);
ALTER TABLE public.setter_monthly_report_lines ADD COLUMN IF NOT EXISTS amount_btw numeric(10,2);
ALTER TABLE public.setter_monthly_report_lines ADD COLUMN IF NOT EXISTS amount_incl numeric(10,2);

COMMENT ON COLUMN public.setter_monthly_report_lines.amount IS 'Alias van amount_incl (backward-compat).';

-- 3) setter_config.monthly_fee betekent voortaan EXCL. btw.
COMMENT ON COLUMN public.setter_config.monthly_fee IS
  'Vaste maandvergoeding EXCL. btw in het setter-maandrapport (btw komt erbij: '
  'SETTER_BTW_PCT). Telt voor maand M als is_active en effective_from <= de 1e van M.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4) ⚠ APART STATEMENT — Romy's vaste maandvergoeding: € 650 EXCL. btw
--    (= € 136,50 btw → € 786,50 incl.). Was 750 (toen bedoeld als incl.).
--    Romy = profiles.id e5006a5f-463a-46c8-ba04-467503ab8cc7.
-- ═══════════════════════════════════════════════════════════════════════
UPDATE public.setter_config SET monthly_fee = 650 WHERE user_id = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';

-- ═══════════════════════════════════════════════════════════════════════
-- BESTAANDE RAPPORTEN (geen backfill in SQL)
-- ═══════════════════════════════════════════════════════════════════════
-- - concept-rapporten: worden met de nieuwe logica herberekend bij
--   "Rapport genereren / bijwerken", bij "Goedkeuren" (herberekent eerst) en
--   door de maandcron. Alle kolommen + regels worden dan opnieuw gezet.
-- - goedgekeurd / uitbetaald: blijven BEVROREN (btw_pct NULL); de tab
--   Rapporten splitst de oude incl.-bedragen alleen voor weergave.
-- - Stand 1 okt 2026 (read-only gecontroleerd): er is precies één rapport,
--   Romy september 2026, status GOEDGEKEURD, € 750 vaste vergoeding (oude
--   logica, incl.) + € 0 commissie. Om dat naar 650 excl. / 786,50 incl. te
--   zetten: in de tab Rapporten "Heropenen" (→ concept) en daarna
--   "Rapport genereren / bijwerken" of opnieuw "Goedkeuren".
--
-- POST-CHECK
--   SELECT user_id, monthly_fee FROM public.setter_config;              -- Romy 650.00
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='setter_monthly_reports'
--      AND column_name IN ('btw_pct','fee_excl','fee_btw','fee_incl','commission_excl',
--                          'commission_btw','commission_incl','total_excl','total_btw','total_incl'); -- 10
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='setter_monthly_report_lines'
--      AND column_name IN ('btw_pct','amount_excl','amount_btw','amount_incl');                       -- 4
--
-- ROLLBACK (kolommen zijn nullable en worden door oude code niet gelezen)
--   ALTER TABLE public.setter_monthly_report_lines DROP COLUMN IF EXISTS amount_incl;
--   ALTER TABLE public.setter_monthly_report_lines DROP COLUMN IF EXISTS amount_btw;
--   ALTER TABLE public.setter_monthly_report_lines DROP COLUMN IF EXISTS amount_excl;
--   ALTER TABLE public.setter_monthly_report_lines DROP COLUMN IF EXISTS btw_pct;
--   ALTER TABLE public.setter_monthly_reports DROP COLUMN IF EXISTS total_incl;  -- … idem voor de overige 9
--   UPDATE public.setter_config SET monthly_fee = 750 WHERE user_id = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';
