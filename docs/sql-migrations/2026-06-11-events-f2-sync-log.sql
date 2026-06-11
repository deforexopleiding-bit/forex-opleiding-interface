-- ===========================================================================
-- Events F2 - event_sync_log voor Webflow + GHL outbound publish-sync
-- ===========================================================================
-- Audit-tabel voor elke sync-poging naar Webflow CMS of GHL custom-field
-- options. Een rij per (event x target x action x attempted_at).
--
-- Retry-cron leest WHERE status='failure' AND next_retry_at <= now().
-- Retry-strategie in api/_lib/event-sync-orchestrator.js:
--   1e fail: next_retry_at = now() + 15min
--   2e fail: +1h
--   3e fail: +6h
--   4e fail: +24h
--   5e fail: STOP (next_retry_at=NULL, alarm in UI)
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_sync_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  target            text NOT NULL CHECK (target IN ('webflow','ghl')),
  action            text NOT NULL CHECK (action IN ('create','update','unpublish')),
  request_payload   jsonb,
  response_payload  jsonb,
  status            text NOT NULL CHECK (status IN ('success','failure')),
  error_code        text,
  error_message     text,
  retry_count       integer NOT NULL DEFAULT 0,
  attempted_at      timestamptz NOT NULL DEFAULT now(),
  next_retry_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_event_sync_log_event_target
  ON public.event_sync_log (event_id, target);

CREATE INDEX IF NOT EXISTS idx_event_sync_log_failed_retry
  ON public.event_sync_log (next_retry_at)
  WHERE status = 'failure' AND next_retry_at IS NOT NULL;

ALTER TABLE public.event_sync_log ENABLE ROW LEVEL SECURITY;
-- Geen authenticated-read policy; service_role bypassed RLS; UI leest via API
-- met events.event.view RBAC-gate.

COMMIT;

-- Verify queries:
--   SELECT count(*) FROM event_sync_log;  -- verwacht 0 (vers)
--   SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname='idx_event_sync_log_failed_retry';
