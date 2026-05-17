-- Follow-up Module — Fase 2A migratie
-- Datum: 17 mei 2026
-- Doel: follow_up_notifications_sent tabel voor deduplicatie van EOD/daily/weekly crons
--
-- VOORWAARDEN:
-- - follow_up_appointments tabel bestaat (Fase 1A.1)
-- - ADMIN_ROLES helpers bestaan: has_any_role(text[]), is_super_admin()
--
-- Bij twijfel: voer eerst rollback-SQL onderaan uit.

BEGIN;

-- =============================================================================
-- 1. follow_up_notifications_sent
-- =============================================================================

CREATE TABLE public.follow_up_notifications_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type text NOT NULL
    CHECK (notification_type IN ('eod_reminder', 'daily_flags', 'weekly_report')),
  reference_date date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipient text NOT NULL
    CHECK (recipient IN ('dave', 'admin')),
  payload jsonb,
  UNIQUE (notification_type, reference_date, recipient)
);

COMMENT ON TABLE public.follow_up_notifications_sent IS
  'Dedup-log voor automatische notificaties (EOD, daily flags, weekly rapport). '
  'Voorkomt dubbele verzending bij cron-herstart of Vercel retries.';

-- =============================================================================
-- 2. Index
-- =============================================================================

CREATE INDEX idx_notifications_sent_lookup
  ON public.follow_up_notifications_sent (notification_type, reference_date, recipient);

-- =============================================================================
-- 3. RLS
-- =============================================================================

ALTER TABLE public.follow_up_notifications_sent ENABLE ROW LEVEL SECURITY;

-- Alleen super_admin en admin kunnen lezen (audit trail)
CREATE POLICY "notifications_sent_read_admin"
  ON public.follow_up_notifications_sent
  FOR SELECT
  USING (has_any_role(ARRAY['super_admin', 'admin']));

-- Service-role (supabaseAdmin) schrijft via RLS bypass — geen INSERT policy nodig

COMMIT;

-- =============================================================================
-- ROLLBACK (voer uit als losse transactie bij ongedaan maken)
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS public.follow_up_notifications_sent CASCADE;
-- COMMIT;
