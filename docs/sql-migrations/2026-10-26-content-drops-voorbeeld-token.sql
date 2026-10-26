-- ============================================================================
-- content_drops.voorbeeld_token — preview van een Weekeditie vóór publicatie
-- Datum: 2026-10-26 (Contentmachine 2.0, fase 1) — AL GEDRAAID op 26 okt (ook in dfo-website docs/sql-migrations/)
--
-- Het werkblad in het CRM toont de echte pagina in een iframe:
--   training.deforexopleiding.nl/voorbeeld/<voorbeeld_token>
-- De website leest de drop met de service-key op dit token (elke status behalve
-- gearchiveerd), zonder te publiceren. Het token is een willekeurige uuid per
-- drop (niet raadbaar, staat nergens publiek); het CRM kan het vernieuwen.
--
-- NIET blokkerend: zonder kolom geeft de preview-route 404, de rest werkt.
-- Additief: één kolom (bestaande rijen krijgen meteen een token) + unieke index.
-- ============================================================================

ALTER TABLE public.content_drops ADD COLUMN IF NOT EXISTS voorbeeld_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS content_drops_voorbeeld_token_uidx ON public.content_drops (voorbeeld_token);
