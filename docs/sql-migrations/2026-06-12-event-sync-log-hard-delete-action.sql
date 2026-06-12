-- ============================================================================
-- Events Blok 1 - event_sync_log.action CHECK uitbreiden met 'hard_delete'
-- ============================================================================
-- Datum: 2026-06-12
-- Branch: feat/events-blok1-lifecycle
--
-- Probleem (smoke scenario 13):
--   hardDeleteEventOutbound() schrijft action='hard_delete' naar
--   event_sync_log voor audit van permanente Webflow-verwijdering. De
--   oorspronkelijke F2-migratie 2026-06-11-events-f2-sync-log.sql definieerde:
--     CHECK (action IN ('create','update','unpublish'))
--   waardoor de insert stil gewerigerd werd door PostgREST (CHECK fail).
--   Hard-delete naar Webflow ging wel goed; alleen het audit-spoor verdween.
--
-- Audit van alle action-waarden die Blok 1-flows naar event_sync_log
-- schrijven (bron: api/_lib/event-sync-orchestrator.js):
--   - syncWebflow (create)            -> action='create'      [in CHECK]
--   - syncWebflow (update)            -> action='update'      [in CHECK]
--   - unpublishWebflow (close)        -> action='unpublish'   [in CHECK]
--   - republishWebflow (reopen)       -> action='update'      [in CHECK]
--   - hardDeleteWebflow (delete/cron) -> action='hard_delete' [ONTBREEKT]
--   - syncGhl (recompute)             -> action='update'      [in CHECK]
--
-- Enige ontbrekende waarde: 'hard_delete'. Bewust BEHOUDEN als eigen
-- enum-waarde i.p.v. te hergebruiken als 'unpublish' - de semantiek
-- verschilt (unpublish = staged record blijft staan, hard_delete = item
-- weg uit Webflow CMS). Downstream tooling (sync-retry, dashboards) moet
-- onderscheid kunnen maken zonder de jsonb-payload te scannen.
--
-- Idempotent: DROP IF EXISTS + re-ADD. Mag onbeperkt vaak draaien.
-- ============================================================================

BEGIN;

ALTER TABLE public.event_sync_log
  DROP CONSTRAINT IF EXISTS event_sync_log_action_check;

ALTER TABLE public.event_sync_log
  ADD CONSTRAINT event_sync_log_action_check CHECK (
    action IN ('create','update','unpublish','hard_delete')
  );

COMMIT;

-- Verify queries:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid='public.event_sync_log'::regclass
--     AND conname='event_sync_log_action_check';
--   -- verwacht: CHECK ((action = ANY (ARRAY['create'::text, 'update'::text,
--   --                                       'unpublish'::text, 'hard_delete'::text])))
--
--   -- Smoke na migratie + opnieuw archiveren:
--   SELECT id, target, action, status, attempted_at
--   FROM public.event_sync_log
--   WHERE action='hard_delete'
--   ORDER BY attempted_at DESC
--   LIMIT 5;
--   -- verwacht: minstens 1 rij per nieuwe archive-actie sinds migratie
