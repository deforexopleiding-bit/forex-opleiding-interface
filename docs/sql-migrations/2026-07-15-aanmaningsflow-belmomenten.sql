-- 2026-07-15-aanmaningsflow-belmomenten.sql
-- Workflow "Aanmaningen" uitbreiden van 16 -> 22 stappen: 4 bel-taken
-- toevoegen op dag 15 / 17 / 21 / 36 zodat bellen niet vergeten wordt.
--
-- Eindtoestand (22 stappen):
--    1  whatsapp  dag 7   -> template
--    2  email     dag 7   -> template
--    3  wait      7       -> dag 14
--    4  whatsapp  dag 14  -> template
--    5  email     dag 14  -> template
--    6  wait      1       -> dag 15   (was 3 dagen op step 6)
--    7  task      dag 15  -> BEL 1 (NIEUW)
--    8  wait      2       -> dag 17   (NIEUW)
--    9  whatsapp  dag 17  -> template
--   10  email     dag 17  -> template
--   11  task      dag 17  -> BEL 2 (NIEUW)
--   12  wait      4       -> dag 21
--   13  whatsapp  dag 21  -> template
--   14  email     dag 21  -> template
--   15  task      dag 21  -> BEL 3 (NIEUW)
--   16  task      dag 21  -> WIK-brief (BESTAANDE, tekst ONGEWIJZIGD)
--   17  wait      15      -> dag 36   (was 16 dagen op step 13)
--   18  task      dag 36  -> BEL 4 (NIEUW)
--   19  wait      1       -> dag 37   (NIEUW)
--   20  whatsapp  dag 37  -> template
--   21  email     dag 37  -> template
--   22  stop
--
-- WIK-termijn intact: brief op dag 21 -> incasso-aankondiging op dag 37 =
-- 16 dagen (7+15+1 in de nieuwe tellijn). Voldoet aan de wettelijke
-- WIK-14-dagentermijn + postbezorging.
--
-- RECON:
--   * UNIQUE (workflow_id, step_order) op dunning_workflow_steps (foundation
--     r32). Hernummeren mag daarom niet in-place: eerst +1000 shiften, dan
--     definitief. Dat gebeurt binnen 1 transactie.
--   * Bestaande whatsapp/email-stappen worden ALLEEN hernummerd — hun
--     config.template_id blijft ongewijzigd (jsonb wordt niet aangeraakt).
--   * De WIK-brief-taak (huidige step 12) wordt hernummerd naar 16; z'n
--     config (title/description/assignee_role) wordt NIET aangepast.
--   * Wait-stappen 6 en 13 krijgen nieuwe `days`-waarden (3->1 en 16->15).
--     Zonder deze aanpassing zou de rekensom niet kloppen.
--   * Bel-cadans in app_settings.dunning_call_cadence: max_attempts 3 -> 4
--     (de tracker in het dossier toont "Poging N van 4" na deze migratie).
--     interval_days ongewijzigd (belmomenten zijn nu vast in de workflow).
--
-- Idempotent: kijkt of step_order 22 (stop) al bestaat -> dan skip. Bij
-- re-run doet 'ie niets. SQL-strings apostrof-vrij (les uit #758).

BEGIN;

-- =============================================================================
-- 1) Workflow-steps hernummeren + nieuwe bel-taken toevoegen
-- =============================================================================
DO $mig$
DECLARE
  v_workflow_id uuid;
BEGIN
  SELECT id INTO v_workflow_id
  FROM public.dunning_workflows
  WHERE name = 'Aanmaningen'
  LIMIT 1;

  IF v_workflow_id IS NULL THEN
    RAISE NOTICE 'workflow Aanmaningen niet gevonden - migratie skipt.';
    RETURN;
  END IF;

  -- Al gemigreerd? step 22 met type stop bestaat -> re-run skipt.
  IF EXISTS (
    SELECT 1 FROM public.dunning_workflow_steps
    WHERE workflow_id = v_workflow_id
      AND step_order = 22
      AND step_type = 'stop'
  ) THEN
    RAISE NOTICE 'workflow Aanmaningen heeft al 22 stappen - migratie skipt (idempotent).';
    RETURN;
  END IF;

  -- Tijdelijk +1000 shiften om UNIQUE (workflow_id, step_order) conflicten
  -- tijdens hernummering te vermijden.
  UPDATE public.dunning_workflow_steps
  SET step_order = step_order + 1000
  WHERE workflow_id = v_workflow_id;

  -- Definitieve hernummering. Bestaande step_order (na -1000) -> nieuw:
  --   1..5  blijven 1..5  (whatsapp/email dag 7 + wait 7 + whatsapp/email dag 14)
  --   6     blijft 6      (wait; days wordt hierna 1 gezet)
  --   7,8   -> 9,10       (whatsapp/email dag 17)
  --   9     -> 12         (wait 4)
  --   10,11 -> 13,14      (whatsapp/email dag 21)
  --   12    -> 16         (WIK-brief-taak, config ONAANGERAAKT)
  --   13    -> 17         (wait; days wordt hierna 15 gezet)
  --   14,15 -> 20,21      (whatsapp/email dag 37)
  --   16    -> 22         (stop)
  UPDATE public.dunning_workflow_steps
  SET step_order = CASE (step_order - 1000)
    WHEN 1  THEN 1
    WHEN 2  THEN 2
    WHEN 3  THEN 3
    WHEN 4  THEN 4
    WHEN 5  THEN 5
    WHEN 6  THEN 6
    WHEN 7  THEN 9
    WHEN 8  THEN 10
    WHEN 9  THEN 12
    WHEN 10 THEN 13
    WHEN 11 THEN 14
    WHEN 12 THEN 16
    WHEN 13 THEN 17
    WHEN 14 THEN 20
    WHEN 15 THEN 21
    WHEN 16 THEN 22
    ELSE step_order - 1000
  END
  WHERE workflow_id = v_workflow_id;

  -- Wait step 6: was 3 dagen (dag 14 -> dag 17), wordt 1 dag (dag 14 -> dag 15).
  UPDATE public.dunning_workflow_steps
  SET config = jsonb_set(config, '{days}', to_jsonb(1))
  WHERE workflow_id = v_workflow_id
    AND step_order = 6
    AND step_type = 'wait';

  -- Wait step 17: was 16 dagen (dag 21 -> dag 37), wordt 15 dagen
  -- (dag 21 -> dag 36). Dag 36 -> 37 zit in nieuwe wait step 19 (1 dag).
  UPDATE public.dunning_workflow_steps
  SET config = jsonb_set(config, '{days}', to_jsonb(15))
  WHERE workflow_id = v_workflow_id
    AND step_order = 17
    AND step_type = 'wait';

  -- 4 nieuwe bel-taken + 2 nieuwe wait-stappen invoegen.
  INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
  VALUES
    (v_workflow_id, 7, 'task', jsonb_build_object(
      'title',         'Bel klant — geen reactie op de aanmaning',
      'description',   'De klant heeft niet gereageerd op de aanmaning van gisteren (dag 14) en niet betaald. Bel na via het dossier (Bellen-kaart) en noteer de uitkomst. Maakt de klant een betaalafspraak? Leg die vast — dan pauzeren de aanmaningen automatisch.',
      'assignee_role', 'manager'
    )),
    (v_workflow_id, 8, 'wait', jsonb_build_object('days', 2)),
    (v_workflow_id, 11, 'task', jsonb_build_object(
      'title',         'Bel klant — tweede poging',
      'description',   'Nog steeds geen reactie en geen betaling (dag 17). Tweede belpoging. Noteer de uitkomst in het dossier.',
      'assignee_role', 'manager'
    )),
    (v_workflow_id, 15, 'task', jsonb_build_object(
      'title',         'Bel klant — laatste poging voor de brief',
      'description',   'Dag 21: vandaag gaat de WIK-brief eruit. Laatste kans om er telefonisch uit te komen voordat we juridisch escaleren. Noteer de uitkomst.',
      'assignee_role', 'manager'
    )),
    (v_workflow_id, 18, 'task', jsonb_build_object(
      'title',         'Bel klant — laatste poging voor incasso',
      'description',   'Dag 36: morgen kondigen we incasso aan. Allerlaatste belpoging. Komt er niets uit, dan gaat de vordering naar het incassobureau.',
      'assignee_role', 'manager'
    )),
    (v_workflow_id, 19, 'wait', jsonb_build_object('days', 1));

  -- Workflow-description bijwerken naar de nieuwe cadans.
  UPDATE public.dunning_workflows
  SET description = 'Aanmaningsflow dag 7 -> 37 met 4 bel-taken (dag 15/17/21/36) en de WIK-14-dagenbrief op dag 21. 22 stappen. Pauzeert automatisch bij inbound (Joost fase 2) en bij actieve betaalafspraak (arrangement-hooks).',
      updated_at  = now()
  WHERE id = v_workflow_id;

  RAISE NOTICE 'workflow Aanmaningen uitgebreid naar 22 stappen.';
END
$mig$;

-- =============================================================================
-- 2) app_settings.dunning_call_cadence.max_attempts 3 -> 4
-- =============================================================================
-- interval_days ongewijzigd (belmomenten in de workflow zijn nu vast; die
-- 3-daagse cadans was voor de oude tracker-suggestie).
INSERT INTO public.app_settings (key, value)
VALUES (
  'dunning_call_cadence',
  jsonb_build_object('max_attempts', 4, 'interval_days', 3)
)
ON CONFLICT (key) DO UPDATE
SET value = jsonb_set(
      COALESCE(public.app_settings.value, '{}'::jsonb),
      '{max_attempts}',
      to_jsonb(4)
    );

COMMIT;

-- =============================================================================
-- VERIFICATIE (handmatig na draaien)
-- =============================================================================
-- SELECT s.step_order, s.step_type, s.config
-- FROM public.dunning_workflow_steps s
-- JOIN public.dunning_workflows w ON w.id = s.workflow_id
-- WHERE w.name = 'Aanmaningen'
-- ORDER BY s.step_order;
--
-- Verwacht: 22 rijen.
--   step_order 1..5:  whatsapp/email dag 7/14 (config.template_id INGEVULD)
--   step_order 6:     wait days=1
--   step_order 7:     task title='Bel klant — geen reactie ...'
--   step_order 8:     wait days=2
--   step_order 9,10:  whatsapp/email dag 17 (config.template_id INGEVULD)
--   step_order 11:    task title='Bel klant — tweede poging'
--   step_order 12:    wait days=4
--   step_order 13,14: whatsapp/email dag 21 (config.template_id INGEVULD)
--   step_order 15:    task title='Bel klant — laatste poging voor de brief'
--   step_order 16:    task title='Stuur WIK-14-dagenbrief (aangetekend)'
--                     (tekst uit 2026-07-15-aanmaningsflow-wik-termijn.sql
--                      ONGEWIJZIGD)
--   step_order 17:    wait days=15
--   step_order 18:    task title='Bel klant — laatste poging voor incasso'
--   step_order 19:    wait days=1
--   step_order 20,21: whatsapp/email dag 37 (config.template_id INGEVULD)
--   step_order 22:    stop
--
-- Template-koppelingen check (zonder deze zijn de whatsapp/email-stappen dood):
-- SELECT s.step_order, s.step_type, s.config->>'template_id' AS template_id
-- FROM public.dunning_workflow_steps s
-- JOIN public.dunning_workflows w ON w.id = s.workflow_id
-- WHERE w.name = 'Aanmaningen'
--   AND s.step_type IN ('whatsapp','email')
-- ORDER BY s.step_order;
-- Alle 10 rijen moeten een template_id hebben (geen NULLs).
--
-- WIK-termijn check:
-- SELECT (17-wait-days) + (19-wait-days) AS dagen_tussen_brief_en_incasso;
-- Verwacht: 15 + 1 = 16 dagen (brief dag 21 -> aankondiging dag 37).
--
-- Cadans check:
-- SELECT value FROM public.app_settings WHERE key = 'dunning_call_cadence';
-- Verwacht: {"max_attempts": 4, "interval_days": 3}
--
-- =============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- =============================================================================
-- Deze migratie voegt 6 stappen toe en verplaatst 16 andere. Rollback vereist
-- reconstructie van de oude nummering + verwijdering van de nieuwe stappen.
-- Handmatig (voorbeeld skeleton):
-- BEGIN;
--   DELETE FROM public.dunning_workflow_steps
--   WHERE workflow_id = (SELECT id FROM public.dunning_workflows WHERE name = 'Aanmaningen')
--     AND step_type = 'task'
--     AND config->>'title' IN (
--       'Bel klant — geen reactie op de aanmaning',
--       'Bel klant — tweede poging',
--       'Bel klant — laatste poging voor de brief',
--       'Bel klant — laatste poging voor incasso'
--     );
--   -- + verwijder de 2 nieuwe wait-stappen (step_order 8 en 19)
--   -- + hernummer de rest terug naar 1..16
--   -- + revert wait days (step 6: 1->3, step 17: 15->16)
--   -- + revert app_settings.dunning_call_cadence max_attempts 4->3
-- COMMIT;
