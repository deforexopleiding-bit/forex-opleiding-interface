-- ============================================================================
-- website_events-view: bezet = STRIKTE telling (vragenlijst afgerond)
-- ============================================================================
-- Beslissing: een plek is bezet zodra de vragenlijst is afgerond. De view moet
-- daarom dezelfde regel gebruiken als getConfirmedCount (api/_lib/event-
-- registration.js), de single source of truth:
--     is_test = false
--     AND status IN ('aangemeld','aanwezig')
--     AND assessment_response_id IS NOT NULL
-- ('switched_to_other_event' valt hier vanzelf buiten — die status telt niet mee.)
--
-- Twee wijzigingen t.o.v. de huidige (losse) view:
--   (a) bezet = strikte telling (hierboven);
--   (b) WHERE ... AND e.signups_closed = false — gesloten events verdwijnen uit
--       de view, zodat de hoofdsite ze niet meer als boekbaar toont (gelijk aan
--       getOpenEventsWithSpace, de canonieke funnel-telling).
--
-- De view staat DIRECT in Supabase (niet in een repo). Draai daarom STAP 0 eerst
-- en verzoen de SELECT-lijst + de rest van de WHERE met die output. Laat kolom-
-- namen en overige filters exact gelijk aan de huidige view; alleen de bezet-
-- formule en de signups_closed-filter zijn de bedoelde wijziging. Jeffrey draait
-- dit zelf; niets gemerged.
-- ============================================================================


-- STAP 0 — HUIDIGE definitie dumpen (vergelijk kolommen + WHERE met STAP 1).
SELECT pg_get_viewdef('public.website_events'::regclass, true);


-- STAP 0b — VÓÓR-controle (draai dit vóór STAP 1). Verwacht voor 5-aug:
--   plekken=8, bezet=10, vrij=0.
SELECT id, titel, plekken, bezet, vrij
FROM public.website_events
WHERE id = '274e91b8-91da-4f1b-9245-c1620e120e59';


-- STAP 1 — view vervangen met de strikte bezet-telling.
-- LET OP: reconcilieer de SELECT-lijst + WHERE met de STAP 0-output vóór je draait.
CREATE OR REPLACE VIEW public.website_events AS
SELECT
  e.id,
  e.title    AS titel,
  e.starts_at,
  e.ends_at,
  e.location AS locatie,
  e.niveau,
  e.capacity AS plekken,
  b.bezet,
  GREATEST(0, e.capacity - b.bezet) AS vrij
FROM public.events e
CROSS JOIN LATERAL (
  SELECT count(*)::int AS bezet
  FROM public.event_attendees a
  WHERE a.event_id = e.id
    AND a.is_test = false
    AND a.status IN ('aangemeld','aanwezig')
    AND a.assessment_response_id IS NOT NULL
) b
WHERE e.status = 'published'
  AND e.starts_at > now()
  AND e.signups_closed = false;   -- gesloten events niet meer als boekbaar tonen
                                  -- (gelijk aan getOpenEventsWithSpace: .eq('signups_closed', false))


-- STAP 2 — NÁ-controle (draai na STAP 1). Verwacht voor 5-aug:
--   plekken=8, bezet=7, vrij=1.
-- (Jeffrey's eigen aanmelding staat nu op is_test=true en valt dus uit de
--  strikte telling; 7 echte afgeronde vragenlijsten < 8 → 1 plek vrij.)
SELECT id, titel, plekken, bezet, vrij
FROM public.website_events
WHERE id = '274e91b8-91da-4f1b-9245-c1620e120e59';
