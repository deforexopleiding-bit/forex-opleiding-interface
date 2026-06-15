-- Per aanmelding markeren of de deelnemer al gebeld is.
-- Owner draait deze migratie handmatig op prod.
ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS called_at timestamptz;
