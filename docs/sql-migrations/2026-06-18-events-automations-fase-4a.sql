-- Migration: events_automations trigger_type uitbreiden met
--   on_assessment_not_completed_after (fase 4A).
--
-- De rest van fase 4A (3 condities, 3 step-types) is pure app-validatie
-- en heeft GEEN DB-wijziging nodig.
--
-- Strategie: drop bestaande named check-constraint + recreate met
-- uitgebreide enum-set. Idempotent: drop alleen als 'ie bestaat.

BEGIN;

ALTER TABLE public.event_automations
  DROP CONSTRAINT IF EXISTS event_automations_trigger_type_check;

ALTER TABLE public.event_automations
  ADD CONSTRAINT event_automations_trigger_type_check
  CHECK (trigger_type IN (
    'on_signup',
    'on_assessment_completed',
    'time_before_event',
    'on_assessment_not_completed_after'
  ));

COMMENT ON COLUMN public.event_automations.trigger_type IS
  'Wanneer enrollDueAttendees een attendee aan deze automation moet koppelen. '
  '- on_signup: zodra de attendee aangemaakt is. '
  '- on_assessment_completed: zodra assessment_response_id gevuld is. '
  '- time_before_event: binnen trigger_config.hours_before van events.starts_at. '
  '- on_assessment_not_completed_after: attendee zonder assessment, X uur na '
  '  registered_at (trigger_config.hours_after_signup).';

COMMIT;
