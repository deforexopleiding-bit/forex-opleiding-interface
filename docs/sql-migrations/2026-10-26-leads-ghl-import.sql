-- 2026-10-26 · GHL-import: importbatches voor de wekelijkse webinar-uitnodigingen.
--
-- STATUS: handmatig draaien in de Supabase SQL-editor (Jeffrey). Muterend, maar
-- puur ADDITIEF (nullable kolommen + index). Losse statements. Opnieuw draaien kan.
--
-- VOLGORDE: deze migratie VÓÓR de eerste import draaien. Daarna de import via
-- Leads → "GHL importeren" (proefrun → bevestigen).
--
-- NIET BLOKKEREND voor bestaande flows: alleen de import, het batchfilter en het
-- markeren na een massabericht noemen deze kolommen; zonder migratie geven die
-- een duidelijke melding, de rest van het CRM merkt niets.
--
--   import_batch          1..99 — welke week (1..24 nu); filter in Leads + Massabericht
--   ghl_tag               oorspronkelijke GHL-bron/tag (referentie)
--   ghl_created           echte aanmaakdatum in GHL (referentie; NIET de sorteerdatum)
--   uitgenodigd_op        wanneer de webinar-uitnodiging (massabericht, e-mail) verstuurd is
--   uitgenodigd_campagne  welke massacampagne (massa_campagnes.id)

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS import_batch smallint NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ghl_tag text NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ghl_created timestamptz NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS uitgenodigd_op timestamptz NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS uitgenodigd_campagne uuid NULL;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_import_batch_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_import_batch_check CHECK (import_batch IS NULL OR import_batch BETWEEN 1 AND 99);

CREATE INDEX IF NOT EXISTS leads_import_batch_idx ON public.leads (import_batch) WHERE import_batch IS NOT NULL;

COMMENT ON COLUMN public.leads.import_batch IS 'GHL-import (2026-10-26): weekbatch 1..99 voor de webinar-uitnodigingen. NULL = geen import.';
COMMENT ON COLUMN public.leads.ghl_tag IS 'GHL-import: oorspronkelijke GHL-bron/tag (referentie).';
COMMENT ON COLUMN public.leads.ghl_created IS 'GHL-import: echte aanmaakdatum in GHL. aangemaakt is bewust ouder gezet (import achteraan).';
COMMENT ON COLUMN public.leads.uitgenodigd_op IS 'Webinar-uitnodiging per massabericht (e-mail) verstuurd op; gezet door de massa-worker.';
COMMENT ON COLUMN public.leads.uitgenodigd_campagne IS 'De massacampagne (massa_campagnes.id) van de uitnodiging.';

-- Vooraf (alleen lezen) — is e-mail verplicht? Zo ja, dan kan de telefoon-only-
-- import (bron Import-telefoon) niet; de import meldt dat dan zelf.
-- SELECT is_nullable FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'email';
--
-- Na de import (alleen lezen):
-- SELECT import_batch, count(*), count(uitgenodigd_op) AS uitgenodigd
--   FROM public.leads WHERE import_batch IS NOT NULL GROUP BY 1 ORDER BY 1;
