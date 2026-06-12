-- ============================================================================
-- Events Blok 1 - lifecycle "aanmelding gesloten"
-- ============================================================================
-- Datum: 2026-06-12
-- Branch: feat/events-blok1-lifecycle
--
-- Doel: events kunnen aanmelding sluiten ZONDER status te flippen. Status
-- blijft 'published' (event vindt nog plaats), aanmelding dicht. Effecten:
-- (a) uit GHL-dropdown, (b) Webflow-item naar draft.
--
-- 3-veld model (OQ1 lock): signups_closed boolean + signups_closed_at +
-- signups_closed_reason ('auto_time'|'auto_full'|'manual'). auto_full in
-- enum voor forward-compat met F6 (GHL inbound capacity-detect), nu geen
-- cron-write. signups_closed_by_user_id voor audit van manual closes.
--
-- Check-constraint: ofwel alle 3 NULL (open) ofwel alle 3 gezet (gesloten).
-- Index voor cron-scan: published + niet-gesloten + index op starts_at.
-- ============================================================================

BEGIN;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS signups_closed             boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signups_closed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS signups_closed_reason      text,
  ADD COLUMN IF NOT EXISTS signups_closed_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Drop bestaande check-constraint indien aanwezig (idempotent re-run)
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_signups_closed_reason_valid;
ALTER TABLE public.events
  ADD CONSTRAINT events_signups_closed_reason_valid CHECK (
    signups_closed_reason IS NULL OR
    signups_closed_reason IN ('auto_time','auto_full','manual')
  );

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_signups_closed_consistency;
ALTER TABLE public.events
  ADD CONSTRAINT events_signups_closed_consistency CHECK (
    (signups_closed = false AND signups_closed_at IS NULL AND signups_closed_reason IS NULL)
    OR
    (signups_closed = true  AND signups_closed_at IS NOT NULL AND signups_closed_reason IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_events_open_for_signup
  ON public.events (starts_at)
  WHERE status = 'published' AND signups_closed = false;

COMMIT;

-- Verify queries:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='events' AND column_name LIKE 'signups_closed%';
--   -- verwacht 4 rijen
--   SELECT conname FROM pg_constraint WHERE conrelid='public.events'::regclass
--   AND conname LIKE 'events_signups_closed%';
--   -- verwacht 2 constraints
