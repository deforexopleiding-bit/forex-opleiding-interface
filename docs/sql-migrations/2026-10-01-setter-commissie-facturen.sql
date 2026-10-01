-- 2026-10-01-setter-commissie-facturen.sql
--
-- STATUS: TER REVIEW — handmatig draaien in de Supabase SQL-editor.
--
-- Setter-commissie op FACTUREN (PR B, feat/setter-commissie-facturen).
--
-- ⚠ BLOKKEREND VOOR HET UITZETTEN VAN DE DRY-RUN — NIET voor de merge zelf:
--   - De commissie-cron (api/cron-setter-cash-release.js) noemt
--     setter_ledger_entries.betaal_datum bij de INSERT. Zolang de dry-run-vlag
--     AAN staat (default; zie stap 3) schrijft de cron niets, dus de merge is
--     veilig zonder deze migratie.
--   - Zet je app_settings.setter_commissie_dry_run op {"enabled": false}
--     VÓÓR deze migratie, dan faalt ELKE commissie-insert met
--     `column "betaal_datum" does not exist` (cron meldt de fouten, er wordt
--     niets geboekt).
--   - De lezers (setter-overview / -commission-timeline / -commission-monthly
--     / -dashboard-metrics) vallen zonder de kolom terug op created_at.
--
-- Elk statement staat los (SQL-editor knipt op statement-grenzen): geen
-- TEMP-tabellen, geen DO-blocks die van elkaar afhangen. Herhaalbaar.

-- 1) Betaaldatum per commissieregel: de maand waarin de commissie valt is de
--    maand van de BETALING (invoices.paid_date), niet die van de cron-run.
--    Correctieregels (creditnota na commissie) krijgen de rundatum.
ALTER TABLE public.setter_ledger_entries
  ADD COLUMN IF NOT EXISTS betaal_datum date;

COMMENT ON COLUMN public.setter_ledger_entries.betaal_datum IS
  'Betaaldatum van de factuur waarop deze commissie is berekend (invoices.paid_date); '
  'bij een negatieve correctie de datum van de correctie. Bepaalt de maand in het '
  'maandoverzicht en het setter-maandrapport.';

-- 2) Indexen voor de reconcile per (setter, factuur) en het maandoverzicht.
CREATE INDEX IF NOT EXISTS idx_setter_ledger_setter_invoice
  ON public.setter_ledger_entries (setter_user_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_setter_ledger_setter_betaaldatum
  ON public.setter_ledger_entries (setter_user_id, betaal_datum);

-- 3) Kill-switch / dry-run (default AAN). Een ontbrekende rij leest de code
--    óók als dry-run; deze rij maakt de schakelaar zichtbaar.
INSERT INTO public.app_settings (key, value)
VALUES ('setter_commissie_dry_run', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'setter_ledger_entries'
--    AND column_name = 'betaal_datum';                       -- 1 rij, date
-- SELECT key, value FROM public.app_settings
--  WHERE key = 'setter_commissie_dry_run';                    -- {"enabled": true}
--
-- LIVE ZETTEN (pas na het lezen van een dry-run-antwoord van de cron):
--   UPDATE public.app_settings SET value = '{"enabled": false}'::jsonb
--    WHERE key = 'setter_commissie_dry_run';
--
-- ROLLBACK
--   DROP INDEX IF EXISTS public.idx_setter_ledger_setter_betaaldatum;
--   DROP INDEX IF EXISTS public.idx_setter_ledger_setter_invoice;
--   ALTER TABLE public.setter_ledger_entries DROP COLUMN IF EXISTS betaal_datum;
--   DELETE FROM public.app_settings WHERE key = 'setter_commissie_dry_run';
