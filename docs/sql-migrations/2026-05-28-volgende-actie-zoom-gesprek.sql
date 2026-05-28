-- Migratie: voeg 'zoom_gesprek' toe aan volgende_actie CHECK
-- Datum: 2026-05-28
-- Context: outcome-modal herontwerp introduceert 'zoom_gesprek' optie
--          naast bestaande bellen/email/event/sluiten/niet_meer_opvolgen/
--          onboarding_starten. De huidige CHECK-constraint sluit
--          'zoom_gesprek' uit waardoor inserts/updates met die waarde
--          falen op DB-niveau.

ALTER TABLE follow_up_outcomes
  DROP CONSTRAINT IF EXISTS follow_up_outcomes_volgende_actie_check;

ALTER TABLE follow_up_outcomes
  ADD CONSTRAINT follow_up_outcomes_volgende_actie_check
  CHECK (
    volgende_actie = ANY (ARRAY[
      'bellen',
      'email',
      'event',
      'sluiten',
      'niet_meer_opvolgen',
      'onboarding_starten',
      'zoom_gesprek'
    ])
    OR volgende_actie IS NULL
  );

-- ROLLBACK:
-- ALTER TABLE follow_up_outcomes DROP CONSTRAINT follow_up_outcomes_volgende_actie_check;
-- ALTER TABLE follow_up_outcomes ADD CONSTRAINT follow_up_outcomes_volgende_actie_check
--   CHECK (volgende_actie = ANY (ARRAY['bellen','email','event','sluiten',
--                                      'niet_meer_opvolgen','onboarding_starten'])
--          OR volgende_actie IS NULL);
