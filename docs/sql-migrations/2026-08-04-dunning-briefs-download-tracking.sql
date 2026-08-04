-- 2026-08-04 — dunning_briefs: download-tracking + created_at index
--
-- Aanleiding: nieuwe handmatige WIK-brief-functie in Wanbetalers-module.
-- Nieuwe overzichtspagina (Instellingen → Brieven) toont per brief 3 statussen:
--   • Aangemaakt   (downloaded_at IS NULL AND sent_at IS NULL)
--   • Gedownload   (downloaded_at IS NOT NULL AND sent_at IS NULL)
--   • Verstuurd    (sent_at IS NOT NULL)  ← bestond al via sent_via/sent_at
--
-- Voor de eerste twee statussen missen we een moment "voor het eerst
-- gedownload voor print". Die vullen we automatisch bij de bulk-print-
-- endpoint (dunning-briefs-bulk-print) én bij de per-stuk-download uit
-- de case-sheet, zodat overzicht klopt met de werkelijkheid.
--
-- ADDITIEF: 2 kolommen + 1 index. Geen bestaande data aangetast, geen
-- semantiek van bestaande kolommen gewijzigd. Bestaande brieven krijgen
-- downloaded_at=NULL (status "Aangemaakt" of "Verstuurd" afhankelijk van
-- sent_at). Bij eerstvolgende download vult 'ie zichzelf.
--
-- Volgorde:
--   1. Draai deze migratie (2 ALTER + 1 CREATE INDEX).
--   2. Deploy code met nieuwe endpoints + UI.
--   3. Vanaf nu wordt elke download-actie via de UI getrackt.

ALTER TABLE public.dunning_briefs
  ADD COLUMN IF NOT EXISTS downloaded_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS downloaded_by   uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

-- Overzichtspagina sorteert default op nieuwste-eerst. Bestaande index
-- idx_dunning_briefs_customer_id dekt per-klant listing (case-sheet); voor
-- platform-brede listing (overzicht) hebben we generated_at zonder
-- customer_id-filter nodig.
CREATE INDEX IF NOT EXISTS idx_dunning_briefs_generated_desc
  ON public.dunning_briefs (generated_at DESC);

COMMENT ON COLUMN public.dunning_briefs.downloaded_at IS
  'Timestamp van eerste (of laatste) download-actie via de UI —
   automatisch gezet door dunning-briefs-bulk-print en per-stuk
   downloads. NULL = nog niet gedownload sinds aanmaak.';
COMMENT ON COLUMN public.dunning_briefs.downloaded_by IS
  'User die de download-actie triggerde. NULL bij bewaarde brieven van
   vóór deze migratie of bij system-triggered downloads.';
