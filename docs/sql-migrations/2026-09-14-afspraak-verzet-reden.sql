-- 2026-09-14 · follow_up_appointments: verzet_reden (verplichte reden bij verzetten)
--
-- CONTEXT
-- Nieuwe self-service-regel: een afspraak verzetten kan altijd, maar er moet
-- ALTIJD een serieuze reden mee (server-gevalideerd in api/public-afspraak-
-- verzetten.js). Die reden bewaren we per afspraak zodat we 'm in de CRM
-- (Opvolging → afspraak-detail) kunnen terugzien — analoog aan de bestaande
-- annulering_reden (migratie 2026-09-04).
--
--   verzet_reden  text  — vrije reden die de klant bij het verzetten opgaf
--
-- Raakt alleen public.follow_up_appointments (één kolom). 0 incasso-writes.
-- Idempotent: ADD COLUMN IF NOT EXISTS. Veilig om opnieuw te draaien.

BEGIN;

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS verzet_reden text;

COMMENT ON COLUMN public.follow_up_appointments.verzet_reden IS
  'Reden die de klant bij een self-service-verzetting opgaf (vrije tekst, min. 15 tekens, server-gevalideerd). Overschreven bij een volgende verzetting.';

COMMIT;

-- PostgREST/Supabase de nieuwe kolom laten oppikken (schema-cache herladen).
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='follow_up_appointments'
--      AND column_name = 'verzet_reden';
--   Verwacht: 1 rij (verzet_reden, text).
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   ALTER TABLE public.follow_up_appointments
--     DROP COLUMN IF EXISTS verzet_reden;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================
