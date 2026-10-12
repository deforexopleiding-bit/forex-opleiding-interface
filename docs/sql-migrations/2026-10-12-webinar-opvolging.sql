-- 2026-10-12-webinar-opvolging.sql
--
-- STATUS: handmatig draaien in de Supabase SQL-editor (Jeffrey). Muterend (schema).
--
-- Webinar fase 3 — na-webinar opvolging. Per aanmelder per nudge een claim-
-- kolom (zelfde patroon als reminder_dag_op / reminder_uur_op / live_op):
--   opvolging_1_op — nudge 1, de webinar-avond (verstuurd óf overgeslagen)
--   opvolging_2_op — nudge 2, de dag erna       (verstuurd óf overgeslagen)
-- Het resultaat (mail/WhatsApp, of de reden van overslaan) staat in
-- webinar_aanmeldingen.berichten.opvolging_1 / .opvolging_2.
--
-- NIET blokkerend voor de merge: zonder deze kolommen slaat de cron de nudges
-- over (api/_lib/webinar-opvolging.js meldt "kolommen ontbreken") en loopt de
-- rest (bevestiging + reminders) gewoon door. MET de kolommen gaan de nudges
-- aan zodra er een webinar geweest is.
--
-- Elk statement los en herhaalbaar.

ALTER TABLE public.webinar_aanmeldingen ADD COLUMN IF NOT EXISTS opvolging_1_op timestamptz;
ALTER TABLE public.webinar_aanmeldingen ADD COLUMN IF NOT EXISTS opvolging_2_op timestamptz;

COMMENT ON COLUMN public.webinar_aanmeldingen.opvolging_1_op IS
  'Fase 3: nudge 1 (webinar-avond, tot 21:30 NL) verstuurd of overgeslagen; reden/resultaat in berichten.opvolging_1.';
COMMENT ON COLUMN public.webinar_aanmeldingen.opvolging_2_op IS
  'Fase 3: nudge 2 (dag erna, 10:00-20:00 NL) verstuurd of overgeslagen; reden/resultaat in berichten.opvolging_2.';

-- Controle (lezend):
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'webinar_aanmeldingen' AND column_name LIKE 'opvolging_%';
