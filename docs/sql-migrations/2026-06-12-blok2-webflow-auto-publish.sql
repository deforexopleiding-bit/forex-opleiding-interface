-- =============================================================================
-- Events Module Blok 2 - PR 4: Webflow auto-publish toggle + state
-- =============================================================================
-- Datum: 2026-06-12
-- Branch: feat/events-blok2-webflow-auto-publish
--
-- Doel: 2 nieuwe rijen in de bestaande `app_settings` config-store voor:
--   1. webflow_auto_publish_enabled - admin-toggle (default AAN)
--   2. webflow_publish_state - runtime-state (pending, last_publish_at,
--      in_progress, in_progress_started_at) voor lock + debounce + catch-up
--
-- GEEN nieuwe tabel: app_settings bestaat al sinds
-- 2026-06-06-payment-match-candidates.sql (key text PK + value jsonb +
-- updated_at + updated_by_user_id). Idempotent ON CONFLICT DO NOTHING.
--
-- Schema-shape (jsonb) per key:
--   webflow_auto_publish_enabled = { "enabled": true }
--   webflow_publish_state        = { "pending": false,
--                                     "last_publish_at": null,
--                                     "in_progress": false,
--                                     "in_progress_started_at": null }
-- =============================================================================

BEGIN;

INSERT INTO public.app_settings (key, value) VALUES
  ('webflow_auto_publish_enabled',
   '{"enabled": true}'::jsonb),
  ('webflow_publish_state',
   '{"pending": false, "last_publish_at": null, "in_progress": false, "in_progress_started_at": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- =============================================================================
-- Smoke-test queries (run handmatig in Supabase SQL editor na deploy):
-- =============================================================================
-- 1) Beide settings aanwezig:
--    SELECT key, value FROM public.app_settings
--    WHERE key IN ('webflow_auto_publish_enabled', 'webflow_publish_state')
--    ORDER BY key;
--    -- verwacht: 2 rijen met de jsonb default-waardes hierboven.
--
-- 2) Toggle handmatig uitzetten + checken:
--    UPDATE public.app_settings
--    SET value = '{"enabled": false}'::jsonb,
--        updated_at = now()
--    WHERE key = 'webflow_auto_publish_enabled';
--    -- verwacht: 1 row updated.
--
-- 3) Toggle terug aan (default-state):
--    UPDATE public.app_settings
--    SET value = '{"enabled": true}'::jsonb,
--        updated_at = now()
--    WHERE key = 'webflow_auto_publish_enabled';
-- =============================================================================
