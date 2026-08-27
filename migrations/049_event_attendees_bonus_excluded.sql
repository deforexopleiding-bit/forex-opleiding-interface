-- ============================================================================
-- Migratie 049: event_attendees.bonus_excluded — expliciete bonus-uitsluiting
-- Datum: 2026-08-27
-- Doel:  losstaand van deal_id/customer_id een expliciete "geen bonus"-vlag
--        op event_attendees. Nodig voor de "Ontkoppel deal"-actie in de v2
--        events-afronden-flow: als een gebruiker een deal ontkoppelt, mag
--        de bonus-motor NIET automatisch terugvallen op de customer_id
--        (meest recente accepted/signed deal van diezelfde klant) — anders
--        krijgt de mentor alsnog bonus voor een klant die je bewust hebt
--        losgekoppeld.
--
-- Bonus-motor pikt deze vlag op in api/_lib/events-complete-core.js sectie 7:
--   bonus_excluded=true → skip ALLE deal-lookups, tel als
--   'bonus_expliciet_uitgesloten' in summary.skipped. customer_id blijft
--   behouden voor andere doeleinden (rapportages "welke klant kwam").
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DEFAULT false.
--
-- 0 incasso-writes. Incasso-zone (finance.html, *dunning*, *arrangement*,
-- pending-action*, _lib/dunning-*) onaangeroerd.
-- ============================================================================

BEGIN;

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS bonus_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.event_attendees.bonus_excluded IS
  'Expliciete "geen bonus"-vlag. Wordt gezet door de "Ontkoppel deal"-actie in de v2 events-afronden-flow: deal_id=NULL zetten alleen zou de bonus-motor via customer_id-fallback laten terugvallen op de meest recente accepted/signed deal — bonus_excluded=true onderbreekt die fallback. Bij (her)koppelen van een deal automatisch weer false.';

-- Partial index voor snelle "welke attendees zijn uitgesloten"-lookups
-- (weinig rows verwacht — TRUE-branch).
CREATE INDEX IF NOT EXISTS idx_event_attendees_bonus_excluded
  ON public.event_attendees (event_id)
  WHERE bonus_excluded = true;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Kolom staat:
--    SELECT column_name, data_type, is_nullable, column_default
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='event_attendees'
--       AND column_name='bonus_excluded';
--    Verwacht: bonus_excluded | boolean | NO | false.
--
-- 2. Geen rows uitgesloten (na migratie):
--    SELECT COUNT(*) FROM public.event_attendees WHERE bonus_excluded = true;
--    Verwacht: 0.
--
-- 3. Index staat:
--    SELECT indexname FROM pg_indexes
--     WHERE tablename='event_attendees'
--       AND indexname='idx_event_attendees_bonus_excluded';
--    Verwacht: 1 rij.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS public.idx_event_attendees_bonus_excluded;
--   ALTER TABLE public.event_attendees DROP COLUMN IF EXISTS bonus_excluded;
-- COMMIT;
-- ============================================================================
