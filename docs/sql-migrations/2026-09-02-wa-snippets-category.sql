-- ============================================================================
-- BP3 · wa_snippets → templates: category-kolom
-- 2026-09-02
--
-- Voegt een nullable category-kolom toe aan de bestaande wa_snippets-tabel.
-- Naam blijft wa_snippets (backward-compat; endpoints en callers zijn al
-- geoptimaliseerd op die naam). Semantisch worden 'snippets' vanaf nu
-- 'templates' — categorieloos-gebleven rijen zijn simpelweg templates
-- zonder categorie-tag (blijven werken in de picker onder een 'Zonder
-- categorie'-groep).
--
-- Waarom géén aparte tabel?
--   - Zelfde schema: titel + body + owner_user_id + sort_order + timestamps.
--     Categorie is één extra dimensie, geen conceptueel andere entity.
--   - Bestaande endpoints (list/upsert/delete) hoeven alleen 1 veld extra
--     te lezen/schrijven — géén migratie-pad voor bestaande data nodig.
--   - RLS-policy is al scherp (crm_staff read, service-role write). Nieuwe
--     tabel zou die opnieuw moeten opzetten.
--   - Als channels-scheiding later nodig blijkt (bv. mail-only templates
--     met HTML-body): channels text[]-kolom toevoegen in een vervolg-migratie.
--
-- INCASSO-VEILIG: raakt uitsluitend public.wa_snippets. Geen finance/
-- dunning/arrangement-tabellen.
--
-- IDEMPOTENT: IF NOT EXISTS → herhaald draaien is een no-op.
--
-- BLOKKEREND: de code accepteert category in create/update en toont de
-- kolom in de list-response. Zonder deze migratie faalt de INSERT/UPDATE
-- met 42703 zodra de user een categorie tikt. Draai vóór de code-deploy.
-- ============================================================================

BEGIN;

ALTER TABLE public.wa_snippets
  ADD COLUMN IF NOT EXISTS category text NULL
    CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 80);

-- Optioneel: partial index voor snelle groep-lookup per categorie.
CREATE INDEX IF NOT EXISTS idx_wa_snippets_category
  ON public.wa_snippets (category, sort_order, titel)
  WHERE category IS NOT NULL;

COMMENT ON COLUMN public.wa_snippets.category IS
  'BP3 (2026-09-02): vrije categorie-tag voor template-groepering (bv. '
  '"Aftertrial", "Follow-up", "Sales"). NULL = geen categorie → picker '
  'groepeert onder "Zonder categorie". Max 80 chars. Categorie-suggesties '
  'in de UI komen uit DISTINCT category in de list-response — géén aparte '
  'lookup-tabel om admin-overhead te vermijden.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════════
--
--   -- 1. Kolom bestaat + CHECK aanwezig?
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='wa_snippets'
--     AND column_name='category';
--   -- Verwacht: text, YES.
--
--   -- 2. Bestaande snippets ongemoeid (category NULL overal)?
--   SELECT count(*) FILTER (WHERE category IS NULL) AS zonder_cat,
--          count(*) FILTER (WHERE category IS NOT NULL) AS met_cat,
--          count(*) AS total
--   FROM public.wa_snippets;
--   -- Verwacht: zonder_cat = total, met_cat = 0.
--
--   -- 3. Index staat?
--   SELECT indexname FROM pg_indexes
--   WHERE tablename='wa_snippets' AND indexname='idx_wa_snippets_category';
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   BEGIN;
--     DROP INDEX IF EXISTS public.idx_wa_snippets_category;
--     ALTER TABLE public.wa_snippets DROP COLUMN IF EXISTS category;
--   COMMIT;
-- ============================================================================
