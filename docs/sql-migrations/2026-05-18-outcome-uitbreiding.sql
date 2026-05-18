-- ============================================================
-- 2026-05-18 — Outcome uitbreiding (Fase 6, commit 3a)
-- Voegt 5 nieuwe outcome-waarden toe aan de CHECK constraint:
--   terugbellen, niet_bereikt, in_beraad, offerte_verzonden, afgesloten
-- ============================================================

-- Stap 1: Drop de bestaande CHECK constraint
ALTER TABLE follow_up_outcomes
  DROP CONSTRAINT IF EXISTS follow_up_outcomes_outcome_check;

-- Stap 2: Voeg nieuwe constraint toe met alle 8 geldige waarden
ALTER TABLE follow_up_outcomes
  ADD CONSTRAINT follow_up_outcomes_outcome_check
  CHECK (outcome IN (
    'klant_geworden',
    'geen_klant',
    'no_show',
    'terugbellen',
    'niet_bereikt',
    'in_beraad',
    'offerte_verzonden',
    'afgesloten'
  ));

-- Verificatie: controleer dat bestaande rijen nog geldig zijn
-- SELECT outcome, COUNT(*) FROM follow_up_outcomes GROUP BY outcome ORDER BY COUNT(*) DESC;
