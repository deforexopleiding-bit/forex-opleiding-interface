-- 2026-07-17 — joost_suggestions.proposal_* velden voor gestructureerde output
--
-- Achtergrond (#789):
--   Joost's mandaat-checks in evaluateAutonomy (proposal_termijnen,
--   proposal_uitstel_dagen) waren dood: het LLM-schema (JOOST_TOOL) zette
--   deze velden nooit. Voor autonome verzending was er dus GEEN harde rem
--   op wat Joost aan klanten toezei — alleen prompt-instructies, die een
--   LLM kan hallucineren of overslaan.
--
--   Optie A uit het #789-rapport: tool-schema uitbreiden met 3 optionele
--   proposal-velden + fail-safe naar mens bij ontbreken.
--
-- Nieuwe kolommen:
--   proposal_termijnen           int      Aantal termijnen bij SPLITSING.
--   proposal_uitstel_dagen       int      Dagen uitstel bij UITSTEL.
--   proposal_termijn_bedrag_eur  numeric  EUR per termijn (concreet bedrag
--                                          dat Joost aan de klant belooft).
--
-- Alle 3 nullable + fail-soft: bestaande rijen krijgen NULL en gedragen
-- zich exact als voor deze migratie (geen check triggert). Alleen NIEUWE
-- suggesties waarin de LLM de velden invult, worden gevalideerd tegen het
-- mandaat vóór de send. Zie evaluateAutonomy fail-safe.
--
-- Idempotent (IF NOT EXISTS).

BEGIN;

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS proposal_termijnen          integer,
  ADD COLUMN IF NOT EXISTS proposal_uitstel_dagen      integer,
  ADD COLUMN IF NOT EXISTS proposal_termijn_bedrag_eur numeric(10,2);

COMMENT ON COLUMN public.joost_suggestions.proposal_termijnen IS
  '#789 — Aantal termijnen als Joost een SPLITSING voorstelt. Wordt gecheckt tegen mandate.splitsing.max_termijnen_total voor autonome verzending.';
COMMENT ON COLUMN public.joost_suggestions.proposal_uitstel_dagen IS
  '#789 — Dagen uitstel als Joost UITSTEL voorstelt. Wordt gecheckt tegen mandate.uitstel.max_dagen_total.';
COMMENT ON COLUMN public.joost_suggestions.proposal_termijn_bedrag_eur IS
  '#789 — EUR per termijn (concreet bedrag). Wordt gecheckt tegen dynamische ondergrens (maandbedrag klant #788, fallback mandate.min_termijn_bedrag_eur).';

COMMIT;
