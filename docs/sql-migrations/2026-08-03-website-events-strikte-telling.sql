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
-- De view staat DIRECT in Supabase (niet in een repo). Draai daarom STAP 0 eerst
-- en verzoen de SELECT-lijst + WHERE hieronder met die output. ALLEEN de
-- bezet/vrij-berekening is de bedoelde wijziging — laat kolomnamen en filters
-- verder exact gelijk aan de huidige view. Jeffrey draait dit zelf; niets gemerged.
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
  AND e.starts_at > now();


-- STAP 2 — NÁ-controle (draai na STAP 1). Verwacht voor 5-aug:
--   plekken=8, bezet=8, vrij=0.
-- NB: vrij blijft 0 want de strikte telling (8) = capaciteit (8). Er komt pas
-- een plek vrij als een van de 8 afgeronde-vragenlijst-attendees niet legitiem
-- is (Jeffrey verifieert welke de 8e is t.o.v. zijn eigen 7).
SELECT id, titel, plekken, bezet, vrij
FROM public.website_events
WHERE id = '274e91b8-91da-4f1b-9245-c1620e120e59';
