-- Migration: event_attendees.automation_enabled
--
-- Bepaalt of deze attendee door automations wordt opgepakt.
-- - true (default): automation-flow loopt normaal.
-- - false: uitgesloten van ALLE automations (bv. handmatig-stille toevoeging
--   door admin via 'Aanwezige toevoegen' modal met vinkje uit).
--
-- Bestaande rijen krijgen via DEFAULT direct true zonder backfill, dus de
-- on_signup-flow blijft voor alle huidige attendees ongewijzigd werken.

BEGIN;

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS automation_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.event_attendees.automation_enabled IS
  'Bepaalt of deze attendee door automations wordt opgepakt. true (default) = ja, automation-flow loopt normaal. false = uitgesloten van ALLE automations (bv. handmatig-stille toevoeging door admin). Bestaande rijen krijgen via DEFAULT direct true zonder backfill.';

-- Partial index op (event_id, automation_enabled) waar enabled=false. Klein
-- (de minderheid is uitgesloten) maar versnelt rapportage-queries naar
-- "welke attendees op event X staan op stil".
CREATE INDEX IF NOT EXISTS idx_event_attendees_automation_enabled
  ON public.event_attendees (event_id, automation_enabled)
  WHERE automation_enabled = false;

COMMIT;
