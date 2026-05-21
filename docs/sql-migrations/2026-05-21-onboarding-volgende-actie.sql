-- Migratie: voeg 'onboarding_starten' toe aan volgende_actie enum
-- Datum: 2026-05-21
-- Reden: outcome-modal krijgt nieuwe "Volgende actie" optie "Onboarding starten"
--        (alleen bij outcome klant_geworden). Voorlopig enkel vastleggen, geen flow.

ALTER TABLE follow_up_outcomes
  DROP CONSTRAINT IF EXISTS follow_up_outcomes_volgende_actie_check;

ALTER TABLE follow_up_outcomes
  ADD CONSTRAINT follow_up_outcomes_volgende_actie_check
  CHECK (volgende_actie IN (
    'bellen',
    'email',
    'event',
    'sluiten',
    'niet_meer_opvolgen',
    'onboarding_starten'
  ) OR volgende_actie IS NULL);

-- ROLLBACK:
-- ALTER TABLE follow_up_outcomes DROP CONSTRAINT follow_up_outcomes_volgende_actie_check;
-- UPDATE follow_up_outcomes SET volgende_actie = NULL WHERE volgende_actie = 'onboarding_starten';
-- ALTER TABLE follow_up_outcomes ADD CONSTRAINT follow_up_outcomes_volgende_actie_check
--   CHECK (volgende_actie IN ('bellen','email','event','sluiten','niet_meer_opvolgen') OR volgende_actie IS NULL);
