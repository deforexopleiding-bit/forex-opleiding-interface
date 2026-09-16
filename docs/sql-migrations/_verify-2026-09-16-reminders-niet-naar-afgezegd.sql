-- 2026-09-16 — VERIFICATIE: krijgt iemand die afgezegd heeft nog een reminder?
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
--  De tak `time_before_event` in loadCandidatesForAutomation had GEEN enkele
--  statusfilter — anders dan on_call_status (.eq('status','aangemeld')) en
--  on_assessment_completed (.in('status', CONFIRMED_STATUSES)).
--
--  De condition-stap van 'Warmup vroeg (waarde)' (120u) en 'Reminder laatste
--  uren' (1u) checkt `assessment_completed`, niet de status: wie de
--  vragenlijst invulde en daarna geannuleerd werd glipte er gewoon door.
--  'Reminder 24u' heeft helemaal geen condition. En `still_registered` in
--  buildConditionState sluit alleen switched_to_other_event en no_show uit,
--  dus 'geannuleerd' leest daar als nog-ingeschreven.
--
--  NULMETING 16 september, de drie komende events: 32 deelnemers, 27
--  aangemeld en 5 die niet meer komen —
--    23 sep: Achraf Deflaoui (belstatus leeg), Makbule Aydemir (komt_niet),
--            Florjan Xani (liever_zoom)
--    26 sep: Werner De Kesel (komt_niet), Dave Geelen (komt_niet)
--  Er liepen 0 actieve runs op de drie reminders, dus er ging nog niets fout
--  — maar de vensters van 120u en 24u openen binnen enkele dagen.
--
--  De fix: `q.in('status', REMINDER_STATUSSEN)` op die tak, plus een
--  stop-guard op lopende runs die ALLEEN send_email en send_whatsapp raakt.
--
-- ══════════════════════════════════════════════════════════════════════════
--  HOE JE DIT GEBRUIKT
-- ══════════════════════════════════════════════════════════════════════════
--   1. Draai 1 en 2 VOOR de merge en bewaar de uitkomst.
--   2. Merge de PR (Vercel deployt vanzelf).
--   3. Draai 1 en 2 opnieuw en vergelijk.
--
--  Query 1 rekent de kandidaat-query NA met de nieuwe filter erbij, dus die
--  geeft voor en na hetzelfde antwoord — hij laat zien WIE er wegvalt en
--  waarom. Query 2 is de echte voor/na-meting: die telt de runs die er
--  daadwerkelijk zijn ingeschreven.
--
--  BELANGRIJK: dit script kan niet zien of de gedeployde code de filter al
--  heeft. Zie query 4 voor de enige harde bevestiging daarvan.


-- ══════════════════════════════════════════════════════════════════════════
-- 1 · WIE ZOU ER NU INSTROMEN, EN WIE VALT WEG?
-- ══════════════════════════════════════════════════════════════════════════
-- Dit is loadCandidatesForAutomation voor trigger_type='time_before_event',
-- nagerekend in SQL. De filters zijn 1-op-1 die van de engine:
--   · event-window   events.starts_at > now() AND <= now() + hours_before
--   · automation_enabled = true   (opt-in herontwerp)
--   · is_test = false             (de is_test-filter van 15 september)
--   · scope          'all' / 'niveau' / 'events'
--   · new_only       registered_at >= enabled_at
-- De laatste kolom is de NIEUWE filter, apart gehouden zodat je ziet wie er
-- door wegvalt in plaats van alleen een kleiner getal.

WITH auto AS (
  SELECT a.id, a.name, a.enabled, a.enroll_mode, a.enabled_at,
         a.scope_type, a.scope_config,
         COALESCE((a.trigger_config->>'hours_before')::numeric, 0) AS hours_before
    FROM event_automations a
   WHERE a.trigger_type = 'time_before_event'
     AND a.enabled = true
)
SELECT
  au.name                                        AS automatisatie,
  au.hours_before                                AS uren_voor_event,
  e.starts_at::date                              AS event_datum,
  ea.first_name || ' ' || ea.last_name           AS deelnemer,
  ea.status,
  ea.call_status                                 AS belstatus,
  CASE WHEN ea.status IN ('aangemeld', 'aanwezig', 'sale')
       THEN 'KANDIDAAT'
       ELSE 'VALT WEG — ' || ea.status
  END                                            AS na_de_fix
FROM auto au
JOIN events e
  ON  e.starts_at >  now()
  AND e.starts_at <= now() + (au.hours_before * interval '1 hour')
  AND (
        au.scope_type = 'all'
     OR (au.scope_type = 'niveau' AND e.niveau = au.scope_config->>'niveau')
     OR (au.scope_type = 'events'
         AND e.id::text IN (SELECT jsonb_array_elements_text(au.scope_config->'event_ids')))
      )
JOIN event_attendees ea
  ON  ea.event_id = e.id
  AND ea.automation_enabled = true
  AND ea.is_test = false
  AND (au.enroll_mode <> 'new_only' OR au.enabled_at IS NULL
       OR ea.registered_at >= au.enabled_at)
ORDER BY au.name, e.starts_at, na_de_fix DESC, deelnemer;


-- ══════════════════════════════════════════════════════════════════════════
-- 2 · DE ECHTE VOOR/NA-METING: runs op mensen die niet meer komen
-- ══════════════════════════════════════════════════════════════════════════
-- Dit is het getal dat voor en na verschilt. Alle drie de kolommen horen NA
-- de fix op 0 te staan voor runs die ná de deploy zijn ingeschreven.
--
-- LET OP bij het lezen: runs die VOOR de deploy zijn ingeschreven blijven
-- staan — de fix verwijdert niets. Die worden door de stop-guard afgehandeld
-- (zie query 3): de run blijft bestaan, maar de send-stap wordt overgeslagen
-- en dat staat in het run-log. Vergelijk dus op `ingeschreven_na`, niet op
-- het totaal.

SELECT
  au.name                                                   AS automatisatie,
  count(*)                                                  AS runs_totaal,
  count(*) FILTER (WHERE ea.status IN ('geannuleerd','no_show','switched_to_other_event'))
                                                            AS op_iemand_die_niet_komt,
  count(*) FILTER (WHERE ea.status IN ('geannuleerd','no_show','switched_to_other_event')
                     AND r.status = 'active')               AS daarvan_nog_actief,
  min(r.started_at)                                         AS oudste,
  max(r.started_at)                                         AS nieuwste
FROM event_automation_runs r
JOIN event_automations au ON au.id = r.automation_id
JOIN event_attendees   ea ON ea.id = r.attendee_id
WHERE au.trigger_type = 'time_before_event'
  AND ea.is_test = false
GROUP BY au.name
ORDER BY op_iemand_die_niet_komt DESC, au.name;


-- ══════════════════════════════════════════════════════════════════════════
-- 3 · DE STOP-GUARD IN ACTIE: overgeslagen berichten in het run-log
-- ══════════════════════════════════════════════════════════════════════════
-- Voor een run die AL liep toen iemand afzegde verwijdert de fix niets — de
-- run blijft actief, maar send_email en send_whatsapp worden overgeslagen.
-- Dat gebeurt NIET STIL: de guard schrijft een regel in het run-log met
-- reden en status. Dit is dus ook de manier om te zien dat de guard leeft.
--
-- send_internal_notification en update_attendee_status horen HIER NIET in te
-- staan. Staat er zo'n regel bij, dan is de guard te breed geworden en gaat
-- de interne melding van 'Geen gehoor - laatste kans' stap 5 verloren.

SELECT
  l.created_at,
  au.name                                  AS automatisatie,
  l.step_index,
  l.step_type,
  ea.first_name || ' ' || ea.last_name      AS deelnemer,
  l.result->>'attendee_status'              AS status_op_dat_moment,
  l.result->>'reason'                       AS reden
FROM event_automation_run_log l
JOIN event_automation_runs r  ON r.id  = l.run_id
JOIN event_automations     au ON au.id = r.automation_id
JOIN event_attendees       ea ON ea.id = r.attendee_id
WHERE (l.result->>'skipped')::boolean IS TRUE
  AND l.result->>'reason' LIKE 'niet-meer-komend%'
ORDER BY l.created_at DESC
LIMIT 50;


-- ══════════════════════════════════════════════════════════════════════════
-- 4 · IS DE FIX ECHT GEDEPLOYD?
-- ══════════════════════════════════════════════════════════════════════════
-- SQL kan niet in de gedeployde code kijken, dus dit is een GEDRAGSTEST en
-- geen kolom-check. Doe hem pas ná de merge, en pas nadat cron-events-
-- automations minstens één keer gelopen heeft.
--
-- De linkerkolom is wie er volgens de OUDE code was ingestroomd; die hoort
-- nu 0 runs te hebben. Heeft zo iemand wél een run die NA de merge begon,
-- dan is de deploy niet langs geweest of pakt de filter niet.
--
-- Vul het deploy-moment in (UTC, ISO-8601) — te vinden in het Vercel-
-- dashboard bij de deployment van de merge-commit.

-- SELECT
--   ea.first_name || ' ' || ea.last_name  AS deelnemer,
--   ea.status,
--   e.starts_at::date                     AS event_datum,
--   au.name                               AS automatisatie,
--   r.id                                  AS run_id,
--   r.started_at,
--   CASE WHEN r.id IS NULL THEN 'GOED — geen run'
--        ELSE 'FOUT — run begon na de deploy' END AS uitkomst
-- FROM event_attendees ea
-- JOIN events e ON e.id = ea.event_id AND e.starts_at > now()
-- CROSS JOIN (SELECT id, name FROM event_automations
--              WHERE trigger_type = 'time_before_event' AND enabled = true) au
-- LEFT JOIN event_automation_runs r
--        ON  r.attendee_id   = ea.id
--        AND r.automation_id = au.id
--        AND r.started_at    > '<deploy-moment, bv. 2026-09-16T13:00:00Z>'
-- WHERE ea.status IN ('geannuleerd', 'no_show', 'switched_to_other_event')
--   AND ea.is_test = false
-- ORDER BY uitkomst DESC, e.starts_at, deelnemer;


-- ══════════════════════════════════════════════════════════════════════════
-- 5 · HET STATUSVOCABULAIRE — STAAT ER IETS IN DE DB DAT DE CODE NIET KENT?
-- ══════════════════════════════════════════════════════════════════════════
-- De code verdeelt de statussen in twee lijsten (REMINDER_STATUSSEN en
-- NIET_MEER_KOMEND_STATUSSEN) en een test dwingt af dat hun unie gelijk is
-- aan ATTENDEE_STATUSES in api/events-automation-save.js. Die test leest de
-- CODE. Deze query leest de DATA, en dat is de andere helft: een status die
-- in productie voorkomt maar in geen van beide lijsten staat, krijgt geen
-- reminder en dat zie je nergens aan.
--
-- VERWACHTING: alleen de zes bekende waarden, en 'onbekend_voor_de_code' leeg.
-- Staat er iets anders, dan hoort dat in een van de twee lijsten in
-- api/_lib/events-automation-engine.js — kies expliciet welke.

SELECT
  ea.status,
  count(*)                                 AS aantal,
  count(*) FILTER (WHERE e.starts_at > now()) AS op_komende_events,
  CASE
    WHEN ea.status IN ('aangemeld', 'aanwezig', 'sale')      THEN 'krijgt reminders'
    WHEN ea.status IN ('geannuleerd', 'no_show',
                       'switched_to_other_event')            THEN 'krijgt er geen'
    ELSE 'onbekend_voor_de_code — KIES EEN LIJST'
  END                                      AS behandeling
FROM event_attendees ea
JOIN events e ON e.id = ea.event_id
WHERE ea.is_test = false
GROUP BY ea.status
ORDER BY behandeling, aantal DESC;
