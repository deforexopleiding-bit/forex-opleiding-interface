-- Migratie: nieuwe velden voor Commit C
-- Datum: 2026-05-19
-- Items: 4 (zoom-link), 5 (screenshot-audit), 8 (notities)

-- Item 4: Zoom join URL
ALTER TABLE follow_up_appointments
  ADD COLUMN IF NOT EXISTS zoom_join_url text;

-- Item 8: Notities-tab (lijst van notes per appointment)
CREATE TABLE IF NOT EXISTS follow_up_notities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES follow_up_appointments(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fu_notities_appointment
  ON follow_up_notities(appointment_id, created_at DESC);

-- ROLLBACK:
-- DROP TABLE IF EXISTS follow_up_notities CASCADE;
-- ALTER TABLE follow_up_appointments DROP COLUMN IF EXISTS zoom_join_url;
