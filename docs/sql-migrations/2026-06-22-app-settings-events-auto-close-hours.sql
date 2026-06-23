-- ---------------------------------------------------------------------------
-- 2026-06-22 — Globale instelling voor signup-auto-close uren.
--
-- Voegt key 'events_signups_auto_close_hours_before' toe aan app_settings
-- met default { "hours": 24 } (= huidige semantiek "1 dag voor event-start"
-- maar dan op de start-tijd in plaats van midnight NL).
--
-- Operator past dit aan via Events → Instellingen → Signup-deadline.
-- Cron-events-signups-auto-close.js leest de waarde bij elke run; cutoff
-- per event = starts_at - N hours (UTC, exact).
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO public.app_settings (key, value)
VALUES ('events_signups_auto_close_hours_before', '{"hours": 24}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Toelichting:
-- Cutoff voor signup-auto-close = starts_at - N hours (UTC, exact).
-- Default 24u behoudt "1 dag voor event-start" semantiek maar dan op
-- start-tijd ipv midnight NL. Operator kan via Events → Instellingen aanpassen.

COMMIT;
