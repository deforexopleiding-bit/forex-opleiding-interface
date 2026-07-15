-- 2026-07-15-aanmaningsflow-setup.sql
-- Setup: complete aanmaningsflow dag 7 -> dag 30 in ÉÉN workflow, met 10
-- templates (5 dagen × WhatsApp + E-mail). Plus bugfix: de dag-7-duwtje
-- template gebruikte {{voornaam}} — die variabele bestaat NIET in
-- api/_lib/dunning-template-render.js (beschikbaar: NAAM, FACTUUR_LIJST,
-- FACTUUR_NR, TOTAAL_BEDRAG, DAGEN_OVERDUE, VERVAL_DATUM). Nu geflipt naar
-- {{NAAM}}. Live zou de klant anders letterlijk "Hoi {{voornaam}}" krijgen.
--
-- Idempotent — WHERE NOT EXISTS-guards op name (templates + workflow) en op
-- (workflow_id, step_order) voor de steps. Bij herhaald draaien: geen dubbele
-- rijen, geen wijzigingen aan bestaande.
--
-- Workflow "Aanmaningen" staat is_active=false. Jeffrey activeert 'm zelf
-- via de Workflows-UI zodra hij de teksten heeft aangepast.
--
-- Oude "Vriendelijk duwtje (dag 7)" wordt op is_active=false gezet als
-- terugval (blijft leesbaar in de UI). De template daarvan wordt geflipt van
-- {{voornaam}} naar {{NAAM}} zodat wie 'm later activeert geen letterlijke
-- placeholder in de klant-tekst krijgt.
--
-- SQL-STRING-CONVENTIE (les uit #758): geen losse apostrofs in string-
-- literals. Alle template-teksten in dit bestand zijn apostrof-vrij; als er
-- ooit een moet komen: gebruik '' escape of E'...\''...'-notatie.

BEGIN;

-- ===========================================================================
-- 0. BUGFIX: dag-7 duwtje template van {{voornaam}} -> {{NAAM}}
-- ===========================================================================
-- Idempotent: alleen updaten waar de oude placeholder nog in staat.
UPDATE public.dunning_templates
SET body = replace(body, '{{voornaam}}', '{{NAAM}}'),
    updated_at = now()
WHERE name = 'Vriendelijk duwtje (dag 7)'
  AND kind = 'whatsapp'
  AND body LIKE '%{{voornaam}}%';

-- Zet oude duwtje-workflow uit (blijft als terugval leesbaar in de UI).
UPDATE public.dunning_workflows
SET is_active = false,
    updated_at = now()
WHERE name = 'Vriendelijk duwtje (dag 7)'
  AND is_active = true;

-- ===========================================================================
-- 1. TEMPLATES — 10 stuks (5 dagen × WhatsApp + E-mail)
-- ===========================================================================
-- meta_template_name = NULL: Jeffrey koppelt ze later na Meta-goedkeuring.
-- WhatsApp-steps zonder approved meta_template_name worden door de executor
-- als 'skipped' behandeld — geen kwaad tijdens dry-run of eerste tests.

-- --- DAG 7 -----------------------------------------------------------------
INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 7 (WhatsApp)', 'whatsapp', NULL,
E'Hoi {{NAAM}},\n\nMisschien had je het gemist: factuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} staat nog open. De vervaldatum was {{VERVAL_DATUM}}.\n\nZou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 7 (WhatsApp)');

INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 7 (E-mail)', 'email',
'Herinnering: factuur {{FACTUUR_NR}}',
E'Beste {{NAAM}},\n\nVolgens onze administratie staat factuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} nog open. De vervaldatum was {{VERVAL_DATUM}}.\n\nWil je de betaling alsnog voldoen? Heb je al betaald, dan kun je deze mail negeren.\n\nKom je er niet uit of wil je een betalingsregeling bespreken? Laat het ons weten, dan kijken we samen naar een oplossing.\n\nMet vriendelijke groet,\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 7 (E-mail)');

-- --- DAG 14 ----------------------------------------------------------------
INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 14 (WhatsApp)', 'whatsapp', NULL,
E'Hoi {{NAAM}},\n\nFactuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} staat inmiddels {{DAGEN_OVERDUE}} dagen open. We hebben nog geen betaling ontvangen.\n\nWil je vandaag betalen, of laat je ons even weten wanneer het lukt? Dan houden we het netjes samen.\n\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 14 (WhatsApp)');

INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 14 (E-mail)', 'email',
'Betalingsherinnering: factuur {{FACTUUR_NR}} staat {{DAGEN_OVERDUE}} dagen open',
E'Beste {{NAAM}},\n\nFactuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} is inmiddels {{DAGEN_OVERDUE}} dagen verlopen. Ondanks onze eerdere herinnering hebben wij nog geen betaling ontvangen.\n\nWij verzoeken je het bedrag binnen 5 dagen te voldoen.\n\nLukt betalen in een keer niet? Neem dan contact met ons op — een betalingsregeling is bespreekbaar. Reageren is altijd beter dan wachten.\n\nMet vriendelijke groet,\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 14 (E-mail)');

-- --- DAG 17 ----------------------------------------------------------------
INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 17 (WhatsApp)', 'whatsapp', NULL,
E'Hoi {{NAAM}},\n\nWe hebben nog niets van je gehoord over factuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}}, nu {{DAGEN_OVERDUE}} dagen open.\n\nLaat je even weten hoe we dit oplossen? Een kort berichtje is genoeg.\n\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 17 (WhatsApp)');

INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 17 (E-mail)', 'email',
'Reactie gevraagd: factuur {{FACTUUR_NR}}',
E'Beste {{NAAM}},\n\nWij hebben nog geen betaling en geen reactie ontvangen op factuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}}, inmiddels {{DAGEN_OVERDUE}} dagen verlopen.\n\nWij vragen je dringend te betalen of contact op te nemen. Zonder reactie zijn wij genoodzaakt verdere stappen voor te bereiden — dat willen we graag voorkomen.\n\nMet vriendelijke groet,\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 17 (E-mail)');

-- --- DAG 21 ----------------------------------------------------------------
INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 21 (WhatsApp)', 'whatsapp', NULL,
E'Hoi {{NAAM}},\n\nFactuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} staat nu {{DAGEN_OVERDUE}} dagen open. Wij hebben je meerdere keren benaderd zonder reactie.\n\nWij sturen je vandaag ook een brief. Als wij niets van je horen, bereiden wij juridische stappen voor. Neem alsjeblieft contact op, dan lossen we het samen op.\n\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 21 (WhatsApp)');

INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 21 (E-mail)', 'email',
'Laatste kans op een oplossing: factuur {{FACTUUR_NR}}',
E'Beste {{NAAM}},\n\nFactuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} is {{DAGEN_OVERDUE}} dagen verlopen. Ondanks meerdere herinneringen hebben wij geen betaling en geen reactie ontvangen.\n\nWij sturen je vandaag tevens een brief per post. Blijft betaling of reactie uit, dan bereiden wij juridische stappen voor. De kosten daarvan komen voor jouw rekening.\n\nWij lossen dit liever samen op. Neem contact op en we bespreken de mogelijkheden.\n\nMet vriendelijke groet,\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 21 (E-mail)');

-- --- DAG 30 ----------------------------------------------------------------
INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 30 (WhatsApp)', 'whatsapp', NULL,
E'Hoi {{NAAM}},\n\nLaatste bericht: factuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} staat {{DAGEN_OVERDUE}} dagen open.\n\nOntvangen wij binnen 24 uur geen betaling of reactie, dan dragen wij de vordering over aan ons incassobureau. De extra kosten komen dan voor jouw rekening.\n\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 30 (WhatsApp)');

INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT 'Aanmaning dag 30 (E-mail)', 'email',
'Laatste aankondiging: incasso binnen 24 uur — factuur {{FACTUUR_NR}}',
E'Beste {{NAAM}},\n\nFactuur {{FACTUUR_NR}} van EUR {{TOTAAL_BEDRAG}} staat inmiddels {{DAGEN_OVERDUE}} dagen open. Ondanks herhaalde herinneringen, een brief en meerdere pogingen tot contact hebben wij niets ontvangen.\n\nDit is onze laatste aankondiging. Ontvangen wij binnen 24 uur geen betaling of reactie, dan dragen wij de vordering over aan ons incassobureau. De incassokosten en wettelijke rente komen dan voor jouw rekening.\n\nBetalen of contact opnemen kan nog steeds.\n\nMet vriendelijke groet,\nTeam De Forex Opleiding',
NULL, 'nl', true
WHERE NOT EXISTS (SELECT 1 FROM public.dunning_templates WHERE name = 'Aanmaning dag 30 (E-mail)');

-- ===========================================================================
-- 2. WORKFLOW "Aanmaningen" (is_active=false, priority 45)
-- ===========================================================================
-- trigger_conditions:
--   min_days_since_invoice_date=7 → start op dag 7 na factuurdatum
--   run_once_per_customer_per_workflow=true → geen dubbele run per klant
--   min_total_amount=0 → geen minimum
-- Priority 45: tussen "Betaalafspraak verbroken" (40) en "Vriendelijk duwtje
-- dag 7" (50). Bestaande workflows blijven ordering-technisch intact.
INSERT INTO public.dunning_workflows (name, description, trigger_conditions, is_active, priority)
SELECT
  'Aanmaningen',
  'Complete aanmaningsflow: dag 7 (WA+mail), dag 14, dag 17, dag 21 (met brief + task), dag 30 (laatste aankondiging incasso). Staat standaard uit tot Jeffrey de teksten heeft nagelopen.',
  jsonb_build_object(
    'min_days_since_invoice_date', 7,
    'run_once_per_customer_per_workflow', true,
    'min_total_amount', 0
  ),
  false,
  45
WHERE NOT EXISTS (
  SELECT 1 FROM public.dunning_workflows WHERE name = 'Aanmaningen'
);

-- ===========================================================================
-- 3. STEPS — 16 stappen in de juiste volgorde
-- ===========================================================================
-- Elke step verwijst naar template_id via subquery op template-naam (niet
-- hardcoded). Idempotent guard: (workflow_id, step_order) NOT EXISTS.
-- Step-executors lezen config.template_id voor whatsapp/email (bevestigd
-- in api/_lib/dunning-step-executors.js loadTemplate() r26-27).

-- Helper CTE aanpak zou schoner zijn, maar per-step INSERT ... WHERE NOT
-- EXISTS is idempotent én leesbaar. 16× dezelfde patroon.

-- Step 1: WhatsApp dag 7
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 1, 'whatsapp',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 7 (WhatsApp)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 1);

-- Step 2: E-mail dag 7
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 2, 'email',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 7 (E-mail)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 2);

-- Step 3: wachten 7 dagen (naar dag 14)
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 3, 'wait', jsonb_build_object('days', 7)
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 3);

-- Step 4: WhatsApp dag 14
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 4, 'whatsapp',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 14 (WhatsApp)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 4);

-- Step 5: E-mail dag 14
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 5, 'email',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 14 (E-mail)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 5);

-- Step 6: wachten 3 dagen (naar dag 17)
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 6, 'wait', jsonb_build_object('days', 3)
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 6);

-- Step 7: WhatsApp dag 17
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 7, 'whatsapp',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 17 (WhatsApp)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 7);

-- Step 8: E-mail dag 17
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 8, 'email',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 17 (E-mail)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 8);

-- Step 9: wachten 4 dagen (naar dag 21)
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 9, 'wait', jsonb_build_object('days', 4)
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 9);

-- Step 10: WhatsApp dag 21
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 10, 'whatsapp',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 21 (WhatsApp)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 10);

-- Step 11: E-mail dag 21
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 11, 'email',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 21 (E-mail)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 11);

-- Step 12: task — stuur aangetekende brief (dag 21)
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 12, 'task',
  jsonb_build_object(
    'title', 'Stuur aangetekende brief',
    'description', 'Klant is 21 dagen te laat. Stuur de aangetekende brief met aankondiging juridische stappen.',
    'assignee_role', 'manager'
  )
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 12);

-- Step 13: wachten 9 dagen (naar dag 30)
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 13, 'wait', jsonb_build_object('days', 9)
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 13);

-- Step 14: WhatsApp dag 30
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 14, 'whatsapp',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 30 (WhatsApp)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 14);

-- Step 15: E-mail dag 30
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 15, 'email',
  jsonb_build_object('template_id', (SELECT id FROM public.dunning_templates WHERE name = 'Aanmaning dag 30 (E-mail)'))
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 15);

-- Step 16: stop — workflow eindigt (na dag 30 gaat het naar incasso via
-- aparte flow / dossier — deze workflow markeert einde reguliere aanmanings-
-- cyclus).
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT wf.id, 16, 'stop', '{}'::jsonb
FROM public.dunning_workflows wf
WHERE wf.name = 'Aanmaningen'
  AND NOT EXISTS (SELECT 1 FROM public.dunning_workflow_steps s WHERE s.workflow_id = wf.id AND s.step_order = 16);

COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- ============================================================================
-- BEGIN;
--   -- 3. steps (cascade via workflow-delete, maar expliciet voor rollback-window)
--   DELETE FROM public.dunning_workflow_steps
--    WHERE workflow_id IN (SELECT id FROM public.dunning_workflows WHERE name = 'Aanmaningen');
--   -- 2. workflow
--   DELETE FROM public.dunning_workflows WHERE name = 'Aanmaningen';
--   -- 1. templates
--   DELETE FROM public.dunning_templates
--    WHERE name IN (
--      'Aanmaning dag 7 (WhatsApp)','Aanmaning dag 7 (E-mail)',
--      'Aanmaning dag 14 (WhatsApp)','Aanmaning dag 14 (E-mail)',
--      'Aanmaning dag 17 (WhatsApp)','Aanmaning dag 17 (E-mail)',
--      'Aanmaning dag 21 (WhatsApp)','Aanmaning dag 21 (E-mail)',
--      'Aanmaning dag 30 (WhatsApp)','Aanmaning dag 30 (E-mail)'
--    );
--   -- 0. bugfix reverten (optioneel — {{NAAM}} is inhoudelijk correct)
--   -- UPDATE public.dunning_templates
--   -- SET body = replace(body, '{{NAAM}}', '{{voornaam}}')
--   -- WHERE name = 'Vriendelijk duwtje (dag 7)' AND kind = 'whatsapp';
--   -- UPDATE public.dunning_workflows SET is_active = true
--   -- WHERE name = 'Vriendelijk duwtje (dag 7)';
-- COMMIT;
