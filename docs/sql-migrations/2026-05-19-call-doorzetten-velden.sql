-- Migratie: velden voor call-doorzetten feature (Fase 6.3)
-- Datum: 2026-05-19

-- Parent-link voor historie-tracking bij verplaatsing
ALTER TABLE follow_up_appointments
  ADD COLUMN IF NOT EXISTS parent_appointment_id uuid
  REFERENCES follow_up_appointments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fu_appointments_parent
  ON follow_up_appointments(parent_appointment_id)
  WHERE parent_appointment_id IS NOT NULL;

-- Optioneel: nieuwe status 'verplaatst' voor oude appointment-rij na move
ALTER TABLE follow_up_appointments
  DROP CONSTRAINT IF EXISTS follow_up_appointments_status_check;

ALTER TABLE follow_up_appointments
  ADD CONSTRAINT follow_up_appointments_status_check
  CHECK (status IN ('scheduled', 'in_progress', 'completed', 'no_show', 'cancelled', 'verplaatst'));

-- ROLLBACK:
-- ALTER TABLE follow_up_appointments DROP CONSTRAINT follow_up_appointments_status_check;
-- ALTER TABLE follow_up_appointments ADD CONSTRAINT follow_up_appointments_status_check
--   CHECK (status IN ('scheduled','in_progress','completed','no_show','cancelled'));
-- DROP INDEX IF EXISTS idx_fu_appointments_parent;
-- ALTER TABLE follow_up_appointments DROP COLUMN IF EXISTS parent_appointment_id;
