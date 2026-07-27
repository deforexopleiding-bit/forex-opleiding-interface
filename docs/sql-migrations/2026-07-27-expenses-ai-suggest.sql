-- ============================================================================
-- Uitgaven-analyse — AI-categorisatie-suggesties
-- Datum: 2026-07-27
-- Branch: feat/expenses-ai-suggest
--
-- Wat: transaction_categorizations.source krijgt derde waarde 'ai_suggest'
-- + kolommen ai_confidence + ai_reason voor het opslaan van model-output.
--
-- Kern-principe: 'ai_suggest'-rijen TELLEN NIET MEE in totaal/breakdown.
-- De endpoints filteren source != 'ai_suggest' waar aggregatie plaatsvindt.
-- Alleen source IN ('rule','manual') telt mee als bevestigde categorie.
--
-- Bevestigen door user (in UI, click 'Bevestig'-knop of picker-select):
--   UPDATE source='manual' + ai_confidence/ai_reason blijven staan (audit).
--   Optioneel: nieuwe expense_counterparty_rule toegevoegd zodat toekomstige
--   imports automatisch getagd worden (dat doet de confirm-endpoint).
--
-- Idempotent: ALTER TABLE ... IF NOT EXISTS + DROP+ADD constraint pattern.
-- ============================================================================

BEGIN;

-- ── Stap 1: kolommen voor AI-output ──
ALTER TABLE public.transaction_categorizations
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(3,2);   -- 0.00..1.00
COMMENT ON COLUMN public.transaction_categorizations.ai_confidence IS
  'AI-model confidence 0.00..1.00. Alleen gevuld bij source=ai_suggest. Blijft staan na bevestigen (audit).';

ALTER TABLE public.transaction_categorizations
  ADD COLUMN IF NOT EXISTS ai_reason text;
COMMENT ON COLUMN public.transaction_categorizations.ai_reason IS
  'AI-model uitleg (1 zin) waarom deze categorie gekozen is. Getoond in tooltip in UI.';

-- ── Stap 2: source CHECK uitbreiden ──
-- DROP + ADD i.p.v. ALTER CONSTRAINT (Postgres kent geen ALTER CHECK).
-- Naam van bestaande constraint komt uit \d transaction_categorizations —
-- default = transaction_categorizations_source_check. Als de naam anders is,
-- vervang hieronder; check via:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.transaction_categorizations'::regclass
--     AND contype='c';
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.transaction_categorizations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%source%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.transaction_categorizations DROP CONSTRAINT %I', cname);
    RAISE NOTICE 'Oude source-CHECK constraint gedropt: %', cname;
  ELSE
    RAISE NOTICE 'Geen bestaande source-CHECK gevonden — nieuwe wordt toegevoegd.';
  END IF;

  ALTER TABLE public.transaction_categorizations
    ADD CONSTRAINT transaction_categorizations_source_check
    CHECK (source IN ('rule','manual','ai_suggest'));
  RAISE NOTICE 'Nieuwe source-CHECK constraint toegevoegd (rule/manual/ai_suggest).';
END$$;

-- ── Stap 3: index op source voor snelle filter in queries ──
CREATE INDEX IF NOT EXISTS idx_tx_cat_source
  ON public.transaction_categorizations (source);

COMMIT;

-- ROLLBACK:
-- ALTER TABLE public.transaction_categorizations DROP CONSTRAINT transaction_categorizations_source_check;
-- ALTER TABLE public.transaction_categorizations ADD CONSTRAINT transaction_categorizations_source_check
--   CHECK (source IN ('rule','manual'));
-- (Verwijder eerst alle ai_suggest-rijen: DELETE FROM public.transaction_categorizations WHERE source='ai_suggest';)
-- ALTER TABLE public.transaction_categorizations DROP COLUMN IF EXISTS ai_confidence;
-- ALTER TABLE public.transaction_categorizations DROP COLUMN IF EXISTS ai_reason;
-- DROP INDEX IF EXISTS idx_tx_cat_source;
