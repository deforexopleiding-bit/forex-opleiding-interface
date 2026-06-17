-- Migratie: event_attendees.notes (FEATURE B)
-- Datum: 17 juni 2026
--
-- Doel:
--   Vrije-tekst notitie per attendee voor organisator/manager-gebruik.
--   Zichtbaar in events-detail uitklaprij (Aanwezigen-tab). Geen impact op
--   deelnemer-flow, geen RLS-wijziging.
--
-- Status van deze migratie:
--   Stap 1 — alleen SCHEMA-uitbreiding (deze SQL).
--   Stap 2 — codewijzigingen in api/events-attendee-update.js +
--           api/events-attendees-list.js + modules/events-detail.html
--           (zie aparte logging-code-PR).
--
-- Geen data-backfill nodig: kolom is nullable.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS — re-runs zijn no-op.

BEGIN;

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.event_attendees.notes IS
  'Vrije notitie van organisator/manager — zichtbaar in events-detail uitklaprij. Geen impact op deelnemer-flow.';

COMMIT;
