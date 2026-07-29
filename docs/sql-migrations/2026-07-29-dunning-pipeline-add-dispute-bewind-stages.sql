-- ============================================================================
-- 2026-07-29 — Wanbetalers-acties v1: nieuwe pipeline-stages 'dispuut' + 'bewind'
--
-- ACHTERGROND: de recon (uitkomsten-matrix) toonde 2 gaten in het huidige
-- stage-model:
--   * Geschil / betwist factuur: geen dedicated stage; klanten die betwisten
--     kregen ofwel 'in_gesprek' (niet-terminal, engine blijft aanmanen) of
--     'afschrijven' (terminal maar "kwijt"-semantiek — verkeerd bij betwisting
--     die later terug kan komen naar aanmanen).
--   * Bewind / faillissement / curator: alleen 'afschrijven' als exit —
--     verliest de curator-koppeling en de mogelijkheid om via de bewindvoerder
--     alsnog te innen.
--
-- NIEUWE STAGES:
--   * 'dispuut'  — klant betwist de factuur. Engine slaat over (net als
--                  terminal), maar de stage is OMKEERBAAR: geschil opgelost
--                  → terug naar 'nieuw' (aanmanen hervat) of 'opgelost'
--                  (klant had gelijk, factuur gecrediteerd). is_terminal=false.
--   * 'bewind'   — klant zit in schuldbewind/faillissement/curatele. Engine
--                  slaat over. curator_contact wordt in aparte migratie
--                  (2026-07-29-dunning-pipeline-add-curator-contact.sql) als
--                  jsonb-kolom op dunning_pipeline_customers toegevoegd.
--                  is_terminal=false zodat je 'em nog kan opheffen (bv. bij
--                  overname van boedel).
--
-- Idempotent (INSERT ... ON CONFLICT DO NOTHING). Non-breaking: bestaande
-- stages en rijen blijven ongewijzigd. De engine-guard leest de nieuwe
-- stages via PIPELINE_SKIP_STAGES in api/_lib/dunning-pipeline.js (breidt
-- de set uit van {opgelost,afschrijven} naar {opgelost,afschrijven,dispuut,
-- bewind}). Deze migratie MOET DAAROM DRAAIEN VÓÓR de code-deploy, anders
-- toont de UI stage-dropdown items die de DB nog niet accepteert (FK naar
-- dunning_pipeline_stages.slug).
--
-- Rollback aan de onderkant.
-- ============================================================================

BEGIN;

  -- sort_order: tussen 'incasso' (6) en 'afschrijven' (7) zit geen ruimte.
  -- We plakken de 2 nieuwe stages ná de terminals (8+9) zodat de bestaande
  -- volgorde-nummering intact blijft. De UI sorteert altijd op sort_order,
  -- dus dispuut/bewind verschijnen onderaan de fase-picker — bewust, want
  -- dat zijn uitzonderings-transities die niet in het normale traject horen.
  INSERT INTO public.dunning_pipeline_stages (slug, label, sort_order, color, is_active, is_terminal)
  VALUES
    ('dispuut', 'Dispuut',  8, '#f59e0b', true, false),  -- amber = "let op, staat stil"
    ('bewind',  'Bewind',   9, '#7c3aed', true, false)   -- paars = "extern juridisch traject"
  ON CONFLICT (slug) DO NOTHING;

  -- Documentation-comment (bestaande stages hebben er ook één qua patroon).
  COMMENT ON TABLE public.dunning_pipeline_stages IS
    'Alle mogelijke fasen in de wanbetalers-pipeline. is_terminal=true blokkeert alleen auto-callers via setStage(). De engine-guard skipt bovendien alle stages in PIPELINE_SKIP_STAGES (opgelost, afschrijven, dispuut, bewind) via api/_lib/dunning-pipeline.js.';

  NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK (indien nodig):
-- BEGIN;
--   -- Verplaats klanten uit deze stages terug naar 'nieuw' zodat de DELETE
--   -- geen FK-violation geeft (dunning_pipeline_customers.stage_slug FK'd
--   -- naar dunning_pipeline_stages.slug).
--   UPDATE public.dunning_pipeline_customers SET stage_slug = 'nieuw'
--     WHERE stage_slug IN ('dispuut','bewind');
--   DELETE FROM public.dunning_pipeline_stages WHERE slug IN ('dispuut','bewind');
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
