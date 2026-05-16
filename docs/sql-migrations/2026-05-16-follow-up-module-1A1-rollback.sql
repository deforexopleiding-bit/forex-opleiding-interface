-- Rollback voor 2026-05-16-follow-up-module-1A1.sql
--
-- DESTRUCTIEF: verwijdert alle Follow-up Module tabellen + bucket + storage policies.
-- Gebruik alleen bij failed deploy of bewuste teardown.

BEGIN;

-- Storage policies eerst (anders kan bucket niet weg)
DROP POLICY IF EXISTS "Sales upload own screenshots" ON storage.objects;
DROP POLICY IF EXISTS "Sales view own + ADMIN_ROLES view all screenshots" ON storage.objects;
DROP POLICY IF EXISTS "ADMIN_ROLES delete screenshots (cleanup)" ON storage.objects;

-- Storage bucket
DELETE FROM storage.buckets WHERE id = 'follow-up-screenshots';

-- Trigger en functie
DROP TRIGGER IF EXISTS fu_appointments_updated_at ON public.follow_up_appointments;
DROP FUNCTION IF EXISTS public.fu_appointments_set_updated_at();

-- Tabellen in omgekeerde FK-volgorde (children eerst)
DROP TABLE IF EXISTS public.follow_up_notifications_sent CASCADE;
DROP TABLE IF EXISTS public.follow_up_screenshot_audit CASCADE;
DROP TABLE IF EXISTS public.follow_up_events_log CASCADE;
DROP TABLE IF EXISTS public.follow_up_messages_sent CASCADE;
DROP TABLE IF EXISTS public.follow_up_messages CASCADE;
DROP TABLE IF EXISTS public.follow_up_outcomes CASCADE;
DROP TABLE IF EXISTS public.follow_up_appointments CASCADE;

COMMIT;
