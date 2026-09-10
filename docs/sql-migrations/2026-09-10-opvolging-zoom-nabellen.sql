-- 2026-09-10 · reden 'zoom_nabellen' + is_test op opvolging_taken
-- ============================================================================
--
-- ⚠ BLOKKEREND. Draai dit VÓÓR of DIRECT NA de merge van de PR die
--   api/cron-opvolging-zoom-nabel.js toevoegt.
--
--   Zonder deze migratie faalt ELKE kaart die die cron aanmaakt met
--   `violates check constraint "opvolging_taken_reden_chk"`, en dan doet de
--   instroom van 12:00 helemaal niets. De cron logt dat per afspraak (elke
--   insert zit in een eigen try/catch), dus de rest van het platform blijft
--   overeind — maar de functie werkt niet.
--
-- ── WAT ER VERANDERT ──────────────────────────────────────────────────────
--
--  1. reden 'zoom_nabellen' erbij in opvolging_taken_reden_chk.
--     De kaarten van cron-opvolging-zoom-nabel zeggen: 'deze lead heeft
--     vanmiddag een zoomcall, kreeg vanochtend een spraakbericht en reageerde
--     niet — bel hem'. Dat is geen van de bestaande redenen: het is geen
--     no-show (de call moet nog komen), geen afmelding en geen 'wil nog
--     beslissen' (er is nog helemaal geen gesprek geweest).
--
--     De reden_code eronder (`zoom_geen_reactie` / `zoom_geen_spraakbericht`)
--     is een vrije tekstkolom zonder CHECK en hoeft hier dus niets.
--
--  2. is_test op opvolging_taken.
--     Een proefafspraak hoort een proefkaart op te leveren en geen echte.
--     follow_up_appointments kreeg die kolom op 9 september
--     (2026-09-09-follow-up-appointments-is-test.sql); opvolging_taken nog
--     niet, terwijl de inhaalslag-SQL en de crons er wel op filteren.
--
--     `IF NOT EXISTS`, dus dit is een no-op als de kolom er al staat.
--
-- ── LOSSE STATEMENTS, MET OPZET ───────────────────────────────────────────
-- De Supabase SQL-editor knipt input op statement-grenzen en draait elk
-- statement in een eigen transactie. Er staat hier daarom geen DO-block dat
-- state uit een ander block verwacht, en geen TEMP TABLE. Alles is idempotent:
-- twee keer draaien verandert de tweede keer niets.
-- ============================================================================

-- ── 1 · reden: 'zoom_nabellen' erbij ────────────────────────────────────────
-- De volledige lijst opnieuw, want een CHECK is niet uit te breiden zonder
-- hem te vervangen. Ontbreekt hier een bestaande waarde, dan mislukt elke
-- toekomstige insert met die reden — dus de lijst is die van
-- 2026-09-05-opvolging-aanmelding-en-wacht-verplaatsing.sql, plus de nieuwe.
ALTER TABLE public.opvolging_taken
  DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk;

ALTER TABLE public.opvolging_taken
  ADD CONSTRAINT opvolging_taken_reden_chk CHECK (reden IN (
    'wil_nog_beslissen',
    'no_show_event',
    'no_show_call',
    'afgemeld',
    'niet_ingepland',
    'aanmelding',         -- 2026-09-05: instroom bij aanmelding voor een event
    'zoom_nabellen'       -- 2026-09-10: instroom om 12:00 bij een zoomcall
  ));

-- ── 2 · is_test ─────────────────────────────────────────────────────────────
ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.opvolging_taken.is_test IS
  'Proefkaart. Wordt overgenomen van follow_up_appointments.is_test door '
  'cron-opvolging-zoom-nabel; rapporten en crons filteren erop.';

-- ── Nakijken ────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.opvolging_taken'::regclass
--    AND conname = 'opvolging_taken_reden_chk';
--
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'opvolging_taken'
--    AND column_name = 'is_test';
