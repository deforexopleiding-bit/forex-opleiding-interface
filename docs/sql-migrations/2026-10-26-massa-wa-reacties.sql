-- 2026-10-26 · Massa-WhatsApp: reacties op de knoppen ("Ja, stuur maar" /
-- "Nu even niet") afhandelen.
--
--   massa_campagnes.wa_vervolg_ja       tekst die we sturen na "Ja" ({{voornaam}}, {{link}})
--   massa_campagnes.wa_vervolg_ja_link  de link voor {{link}} (bv. webinar-aanmelding)
--   massa_campagnes.wa_vervolg_nee      korte afsluiting na "Nu even niet" ({{voornaam}})
--   massa_items.reactie                 'ja' | 'nee' | 'stop' (NULL = geen reactie)
--   massa_items.reactie_op              moment van de (eerste) reactie
--   massa_items.vervolg_status          'verstuurd' | 'geen_tekst' | 'buiten_venster' | 'mislukt'
--   massa_items.vervolg_op / vervolg_fout
--   leads.wa_nu_niet_op                 lead zei "Nu even niet"/stop → volgende
--                                       massa-WhatsApps slaan deze lead over
--
-- NIET blokkerend: zonder deze migratie werkt de massa-motor zoals nu (geen
-- vervolg, geen reactie-log). De popup meldt "draai de migratie" pas als je een
-- vervolgtekst invult en de kolommen ontbreken.
-- Supabase SQL-editor: losse statements, geen DO-blokken. Idempotent.

-- ── 1. Vervolgteksten per campagne ───────────────────────────────────────────
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_vervolg_ja text;
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_vervolg_ja_link text;
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_vervolg_nee text;

-- ── 2. Reactie per verzonden WhatsApp ────────────────────────────────────────
ALTER TABLE public.massa_items ADD COLUMN IF NOT EXISTS reactie text;
ALTER TABLE public.massa_items ADD COLUMN IF NOT EXISTS reactie_op timestamptz;
ALTER TABLE public.massa_items ADD COLUMN IF NOT EXISTS vervolg_status text;
ALTER TABLE public.massa_items ADD COLUMN IF NOT EXISTS vervolg_op timestamptz;
ALTER TABLE public.massa_items ADD COLUMN IF NOT EXISTS vervolg_fout text;

ALTER TABLE public.massa_items DROP CONSTRAINT IF EXISTS massa_items_reactie_check;
ALTER TABLE public.massa_items ADD CONSTRAINT massa_items_reactie_check CHECK (reactie IS NULL OR reactie IN ('ja', 'nee', 'stop'));

ALTER TABLE public.massa_items DROP CONSTRAINT IF EXISTS massa_items_vervolg_status_check;
ALTER TABLE public.massa_items ADD CONSTRAINT massa_items_vervolg_status_check CHECK (vervolg_status IS NULL OR vervolg_status IN ('bezig', 'verstuurd', 'geen_tekst', 'buiten_venster', 'mislukt'));

-- Knopantwoord → item opzoeken via de wamid van de verzonden template.
CREATE INDEX IF NOT EXISTS idx_massa_items_wa_extern ON public.massa_items (extern_id) WHERE kanaal = 'whatsapp' AND extern_id IS NOT NULL;

-- ── 3. "Nu even niet" op de lead ─────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS wa_nu_niet_op timestamptz;
CREATE INDEX IF NOT EXISTS idx_leads_wa_nu_niet ON public.leads (wa_nu_niet_op) WHERE wa_nu_niet_op IS NOT NULL;

-- ── Controle ─────────────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'massa_campagnes' AND column_name LIKE 'wa_vervolg%')
    OR (table_name = 'massa_items' AND column_name IN ('reactie', 'reactie_op', 'vervolg_status', 'vervolg_op', 'vervolg_fout'))
    OR (table_name = 'leads' AND column_name = 'wa_nu_niet_op'))
ORDER BY table_name, column_name;
