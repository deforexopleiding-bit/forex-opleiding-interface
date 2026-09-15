-- 2026-09-15 — VERIFICATIE: stroomt er nog een testdeelnemer in een live automatisatie?
--
-- ══════════════════════════════════════════════════════════════════════════
--  LEES DIT EERST — DIT BESTAND SCHRIJFT NIETS
-- ══════════════════════════════════════════════════════════════════════════
--  Alleen SELECTs. Geen ALTER, geen UPDATE, geen DELETE. De fix zelf zit in
--  code (api/_lib/events-automation-engine.js) en heeft geen migratie nodig.
--  Vandaar de `_verify-`-prefix: dit hoort bij de losse hulp-scripts, niet bij
--  de migratiereeks.
--
-- ══════════════════════════════════════════════════════════════════════════
--  WAT ER GEMETEN IS, EN WAAROM
-- ══════════════════════════════════════════════════════════════════════════
--  Op 15 september had de testdeelnemer van één testrun
--  (2ea7e337-68f2-4279-ab0e-aa2d1b72be99, is_test=true) DRIE runs:
--
--    e65d8d6b  'Geen gehoor - laatste kans'   is_test=true    exited op stap 3
--    273a3cdd  'Welkom + vragenlijst'         is_test=FALSE   completed
--    b1018890  'Vragenlijst-herinnering'      is_test=FALSE   ACTIVE
--
--  Binnen twee seconden stroomde een synthetische rij dus in twee LIVE
--  on_signup-automatisaties, en de derde stond nog te draaien.
--
--  Oorzaak: loadCandidatesForAutomation filterde `is_test` niet, en
--  event_attendees.automation_enabled staat default true. De fix zet
--  `.eq('is_test', false)` op de basis-query, dus voor alle trigger-types.
--
-- ══════════════════════════════════════════════════════════════════════════
--  HOE JE DIT GEBRUIKT
-- ══════════════════════════════════════════════════════════════════════════
--   1. Draai 1 en 2 VÓÓR de merge en bewaar de uitkomst.
--   2. Merge de PR (Vercel deployt vanzelf).
--   3. Start één verse testrun via Automatiseringen > Events > Test.
--   4. Draai 3 en daarna 1 en 2 opnieuw.
--
--  VERWACHTING NA DE FIX: query 3 geeft precies ÉÉN rij — de run van de
--  automatisatie die je test, met is_test = true. Staat er een tweede rij met
--  is_test = false, dan stroomt er nog steeds iets door en is de fix niet
--  actief (check of de deploy langs is geweest).


-- ══════════════════════════════════════════════════════════════════════════
-- 1 · DE TELLING. Hoeveel runs hangen er aan testdeelnemers, en hoeveel
--     daarvan zijn LIVE runs (is_test = false op de run zelf)?
-- ══════════════════════════════════════════════════════════════════════════
-- Dit is het getal dat voor en na vergeleken wordt. `live_runs` hoort 0 te
-- zijn; `actieve_live_runs` is het getal dat écht kwaad kan, want dat staat
-- nog te draaien.

SELECT
  count(*)                                                   AS runs_op_testdeelnemers,
  count(*) FILTER (WHERE r.is_test IS NOT TRUE)              AS live_runs,
  count(*) FILTER (WHERE r.is_test IS NOT TRUE
                     AND r.status = 'active')                AS actieve_live_runs,
  count(DISTINCT r.attendee_id)                              AS betrokken_testdeelnemers
FROM event_automation_runs r
JOIN event_attendees a ON a.id = r.attendee_id
WHERE a.is_test = true;


-- ══════════════════════════════════════════════════════════════════════════
-- 2 · WELKE AUTOMATISATIES PIKKEN TESTDEELNEMERS OP, en via welke trigger?
-- ══════════════════════════════════════════════════════════════════════════
-- Zo zie je of het bij on_signup blijft of dat time_before_event er ook bij
-- zit (dat laatste gebeurde op 26 september Gent).

SELECT
  au.name,
  au.trigger_type,
  au.enabled,
  r.is_test                          AS run_is_test,
  r.status,
  count(*)                           AS aantal,
  min(r.started_at)                  AS oudste,
  max(r.started_at)                  AS nieuwste
FROM event_automation_runs r
JOIN event_attendees   a  ON a.id  = r.attendee_id
JOIN event_automations au ON au.id = r.automation_id
WHERE a.is_test = true
GROUP BY au.name, au.trigger_type, au.enabled, r.is_test, r.status
ORDER BY aantal DESC, au.name;


-- ══════════════════════════════════════════════════════════════════════════
-- 3 · NA DE FIX: de runs van één verse testrun
-- ══════════════════════════════════════════════════════════════════════════
-- Vul het attendee-id in dat het testvenster meldt (het staat ook in de
-- runkop: "deelnemer 2ea7e337…").
--
-- VERWACHTING: precies één rij, is_test = true, de automatisatie die je test.

-- SELECT
--   r.id AS run_id,
--   au.name,
--   au.trigger_type,
--   r.is_test AS run_is_test,
--   r.status,
--   r.current_step_index,
--   r.started_at
-- FROM event_automation_runs r
-- JOIN event_automations au ON au.id = r.automation_id
-- WHERE r.attendee_id = '<attendee-id uit het testvenster>'
-- ORDER BY r.started_at;


-- ══════════════════════════════════════════════════════════════════════════
-- 4 · OPRUIMEN
-- ══════════════════════════════════════════════════════════════════════════
-- Niet met SQL. Gebruik de knop "Testrijen opruimen" in
-- Automatiseringen > Events; die gaat via api/events-test-attendees-cleanup.js
-- en laat de FK-CASCADE de runs, het run-log, de tags en de audit-regels
-- meenemen. Een DELETE met de hand slaat die cascade-logica over en laat
-- makkelijk wezen achter.
--
-- Wat er nog stáát te draaien op testdeelnemers (handig vóór je opruimt):

-- SELECT r.id AS run_id, au.name, r.status, r.current_step_index, r.next_run_at,
--        a.id AS attendee_id, a.first_name, a.last_name, a.email
--   FROM event_automation_runs r
--   JOIN event_attendees   a  ON a.id  = r.attendee_id
--   JOIN event_automations au ON au.id = r.automation_id
--  WHERE a.is_test = true AND r.status = 'active'
--  ORDER BY r.next_run_at NULLS FIRST;
