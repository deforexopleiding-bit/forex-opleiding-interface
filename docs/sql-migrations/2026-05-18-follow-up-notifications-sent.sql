-- Follow-up Module — Fase 5 migratie
-- Datum: 2026-05-18
-- Doel: dedup-tabel voor admin-rapporten (dagelijks + wekelijks)
--       zodat dezelfde dag/week niet dubbel verstuurd wordt bij retry.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS follow_up_notifications_sent;

BEGIN;

CREATE TABLE IF NOT EXISTS public.follow_up_notifications_sent (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type text NOT NULL
    CHECK (notification_type IN ('admin_daily', 'admin_weekly')),
  reference_date   date NOT NULL,
  recipient        text NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  meta             jsonb,
  UNIQUE (notification_type, reference_date, recipient)
);

COMMENT ON TABLE public.follow_up_notifications_sent IS
  'Dedup-log voor automatische admin-notificaties. Voorkomt dubbele '
  'verzending bij cron-herstart of Vercel retries.';

CREATE INDEX IF NOT EXISTS idx_notifications_sent_lookup
  ON public.follow_up_notifications_sent (notification_type, reference_date);

ALTER TABLE public.follow_up_notifications_sent ENABLE ROW LEVEL SECURITY;

-- Alleen admin-rollen mogen lezen (audit trail)
CREATE POLICY "notifications_sent_admin_read"
  ON public.follow_up_notifications_sent
  FOR SELECT
  USING (has_any_role(ARRAY['super_admin', 'admin', 'manager']));

-- Service-role (supabaseAdmin) schrijft via RLS bypass — geen INSERT policy nodig

COMMIT;
