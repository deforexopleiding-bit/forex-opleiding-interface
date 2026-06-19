-- Migration: event_attendees.source — kanaal-tracking per attendee.
--
-- Verwachte waarden (free-text, géén CHECK):
--   - 'webflow'         publieke Webflow-flow (assessment.html submit /
--                       event-choice-submit met token)
--   - 'ghl'             inbound webhook events-signup-inbound (GHL)
--   - 'manual'          admin handmatige insert via events-detail UI
--                       (events-attendee-add)
--   - 'automation_test' synthetische attendee via events-automation-test
--   - NULL              pre-migration data (onbekend)
--
-- Free-text bewust: nieuwe bronnen (bv. 'simone', 'csv_import') kunnen
-- worden toegevoegd zonder constraint-migratie.

BEGIN;

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.event_attendees.source IS
  'Kanaal waarvia deze attendee is aangemaakt. Verwachte waarden: webflow, ghl, manual, automation_test. NULL voor pre-migration data (onbekend).';

CREATE INDEX IF NOT EXISTS idx_event_attendees_source
  ON public.event_attendees (source) WHERE source IS NOT NULL;

COMMIT;
