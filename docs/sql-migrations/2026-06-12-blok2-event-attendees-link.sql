-- =============================================================================
-- Events Module Blok 2 - PR 3: event_attendees koppeling (mini-migratie)
-- =============================================================================
-- Datum: 2026-06-12
-- Branch: feat/events-blok2-event-koppeling
--
-- Doel: 2 kleine schema-aanpassingen op event_attendees zodat de
-- assessment-flow een 1:N persoonsgebonden koppeling kan maken (een
-- assessment kan meerdere event-inschrijvingen dragen, max 1 per event).
--
-- 1. NIEUWE KOLOM: `created_via text DEFAULT 'assessment'`
--    Discriminator voor de bron van een attendee-rij. 'assessment' voor
--    de publieke assessment-flow; nullable + default zodat bestaande
--    rijen niet aangetast worden en handmatige/F1-flows zelf 'manual'
--    of 'webhook' kunnen zetten.
--
-- 2. NIEUWE PARTIAL UNIQUE INDEX op (event_id, assessment_response_id)
--    WHERE assessment_response_id IS NOT NULL.
--    Zorgt dat dezelfde assessment hooguit 1x per event kan registreren.
--    Verschillende events: prima (1:N model). Attendees zonder assessment
--    (NULL): geen constraint, blijven onbeperkt.
--
-- WAAROM GEEN nieuwe enum-waarde 'confirmed':
--   De F1 event_attendee_status enum heeft al 'aangemeld' = NL voor
--   "registered/confirmed-to-come". Een nieuwe 'confirmed' zou semantisch
--   identiek zijn maar bestaande F1-dashboards en kanban niet kennen,
--   waardoor assessment-registraties onzichtbaar zouden worden in de
--   bestaande UI. We hergebruiken 'aangemeld' voor consistentie en
--   gebruiken `created_via='assessment'` als discriminator. Spec sprak
--   van "status confirmed" als concept; we mappen het naar de enum-waarde
--   die F1 al heeft.
-- =============================================================================

BEGIN;

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS created_via text DEFAULT 'assessment';

-- Geen CHECK op created_via - de waardenset groeit met de tijd
-- (assessment / manual / webhook / import / api / ...). Vrije text
-- houdt het uitbreidbaar; conventies handhaven we in code.

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_attendees_event_assessment
  ON public.event_attendees (event_id, assessment_response_id)
  WHERE assessment_response_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- Smoke-test queries (run handmatig in Supabase SQL editor na deploy):
-- =============================================================================
-- 1) Kolom aanwezig:
--    SELECT column_name, data_type, column_default
--    FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='event_attendees'
--      AND column_name='created_via';
--    -- verwacht: 1 rij, text, 'assessment'::text
--
-- 2) Partial unique index aanwezig:
--    SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname='public' AND tablename='event_attendees'
--      AND indexname='uq_event_attendees_event_assessment';
--    -- verwacht: definitie eindigt met WHERE (assessment_response_id IS NOT NULL)
--
-- 3) Uniqueness werkt (verwacht ERROR bij tweede insert):
--    -- Stap A: insert eerst rij met willekeurige assessment_response_id + event_id
--    -- Stap B: insert tweede rij met dezelfde combinatie -> verwacht
--    --   duplicate key value violates unique constraint
--    --   "uq_event_attendees_event_assessment"
-- =============================================================================
