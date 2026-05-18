-- Migratie: uitbreiding outcome enum met 5 nieuwe waarden
-- Datum: 2026-05-18
-- Reden: oorspronkelijk plan vroeg om meer granulaire outcomes
-- Versie 2: corrigeert outcome-namen naar afgesproken set

ALTER TABLE follow_up_outcomes
  DROP CONSTRAINT IF EXISTS follow_up_outcomes_outcome_check;

ALTER TABLE follow_up_outcomes
  ADD CONSTRAINT follow_up_outcomes_outcome_check
  CHECK (outcome IN (
    'klant_geworden',
    'geen_klant',
    'no_show',
    'niet_bereikt',
    'interesse_uitstel',
    'interesse_overleg',
    'geen_interesse',
    'niet_geschikt'
  ));

-- ROLLBACK:
-- ALTER TABLE follow_up_outcomes DROP CONSTRAINT follow_up_outcomes_outcome_check;
-- UPDATE follow_up_outcomes SET outcome = 'geen_klant'
--   WHERE outcome IN ('niet_bereikt','interesse_uitstel','interesse_overleg','geen_interesse','niet_geschikt');
-- ALTER TABLE follow_up_outcomes ADD CONSTRAINT follow_up_outcomes_outcome_check
--   CHECK (outcome IN ('klant_geworden','geen_klant','no_show'));
