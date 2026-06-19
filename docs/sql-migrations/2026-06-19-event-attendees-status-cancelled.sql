-- Migration: voeg 'geannuleerd' toe aan ENUM event_attendee_status.
--
-- Use-case: niet-NL spreker vult de vragenlijst in → routing_result='incomplete'
-- → assessment-submit zet de gekoppelde attendees op status='geannuleerd'
-- zodat ze NIET meer in de gastenlijst-capaciteit meetellen.
-- CONFIRMED_STATUSES (= 'aangemeld','aanwezig') blijft ongewijzigd; de nieuwe
-- status valt daar bewust buiten.
--
-- N.B. ALTER TYPE … ADD VALUE kan NIET binnen een transactie in Postgres,
-- dus geen BEGIN/COMMIT. IF NOT EXISTS maakt het idempotent.

ALTER TYPE public.event_attendee_status ADD VALUE IF NOT EXISTS 'geannuleerd';

COMMENT ON TYPE public.event_attendee_status IS
  'Status van een event_attendee. aangemeld (default na signup), aanwezig, no_show, sale, switched_to_other_event, geannuleerd (sinds 2026-06-19: bv. niet-NL spreker, telt niet in CONFIRMED_STATUSES).';
