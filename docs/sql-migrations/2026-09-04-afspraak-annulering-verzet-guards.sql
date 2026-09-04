-- 2026-09-04 · follow_up_appointments: annulering/verzet-bevestiging guards + reden
--
-- CONTEXT
-- Fundament voor de annuleer/verzet-bevestiging (WhatsApp-template + mail). We
-- bewaren per afspraak of de bevestiging al verstuurd is (idempotentie) en, bij
-- annuleren, de reden.
--
--   annulering_sent_at    timestamptz — guard: annuleer-bevestiging verstuurd
--   verzet_sent_at        timestamptz — guard: verzet-bevestiging verstuurd
--                         (wordt bij een NIEUWE verzetting weer op NULL gezet,
--                          zodat een volgende verzet opnieuw bevestigt)
--   annulering_reden      text        — vrije reden (of tekst bij 'Anders')
--   annulering_reden_code text        — vaste keuze-code (geen-interesse/geen-tijd/…)
--
-- Raakt alleen public.follow_up_appointments (kolommen). 0 incasso-writes.
-- Idempotent: ADD COLUMN IF NOT EXISTS. Veilig om opnieuw te draaien.

BEGIN;

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS annulering_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS verzet_sent_at        timestamptz,
  ADD COLUMN IF NOT EXISTS annulering_reden      text,
  ADD COLUMN IF NOT EXISTS annulering_reden_code text;

COMMENT ON COLUMN public.follow_up_appointments.annulering_sent_at IS
  'Afspraak-flow: annuleer-bevestiging (mail+WA) verstuurd. NULL = nog niet.';
COMMENT ON COLUMN public.follow_up_appointments.verzet_sent_at IS
  'Afspraak-flow: verzet-bevestiging verstuurd. Wordt bij een nieuwe verzetting op NULL gezet zodat een volgende verzet opnieuw bevestigt.';
COMMENT ON COLUMN public.follow_up_appointments.annulering_reden IS
  'Reden van annulering (vrije tekst, of tekst bij keuze "Anders").';
COMMENT ON COLUMN public.follow_up_appointments.annulering_reden_code IS
  'Vaste keuze-code van de annulering (bv. geen-interesse / geen-tijd / iets-tussen / financieel / anders).';

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='follow_up_appointments'
--      AND column_name IN ('annulering_sent_at','verzet_sent_at',
--                          'annulering_reden','annulering_reden_code')
--    ORDER BY column_name;
--   Verwacht: 4 rijen.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   ALTER TABLE public.follow_up_appointments
--     DROP COLUMN IF EXISTS annulering_sent_at,
--     DROP COLUMN IF EXISTS verzet_sent_at,
--     DROP COLUMN IF EXISTS annulering_reden,
--     DROP COLUMN IF EXISTS annulering_reden_code;
-- ============================================================================
