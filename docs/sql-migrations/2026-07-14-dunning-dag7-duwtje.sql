-- ============================================================================
-- 2026-07-14 — Vriendelijk dag-7 WhatsApp-duwtje (dunning-workflow, uit)
--
-- Introduceert een dunning-workflow die N dagen NA de factuurdatum een
-- vriendelijk WhatsApp-berichtje verstuurt als de factuur nog openstaat.
-- Default N=7 (betaaltermijn is 7 dagen). Onafhankelijk van de bestaande
-- 14-dagen/overdue-flow — deze vuurt vroeger, met een vriendelijke toon.
--
-- STAAT UIT: is_active=false. Zet aan via UI (Workflows → Aan) of via
--   UPDATE public.dunning_workflows SET is_active=true WHERE name = 'Vriendelijk duwtje (dag 7)';
--
-- Engine-trigger:
--   trigger_conditions = {
--     "min_days_since_invoice_date": 7,               -- N dagen NA issue_date
--     "run_once_per_customer_per_workflow": true,     -- max 1 duwtje ooit
--     "min_total_amount": 0
--   }
--
-- Verzending: hergebruikt de bestaande dunning_workflow_steps step_type='whatsapp'
-- + api/_lib/dunning-step-executors.js executeWhatsappStep. Die executor
-- retourneert momenteel status='skipped' met log_event='whatsapp_skipped_no_meta'
-- (Meta-credentials nog niet live in PR A2). Dus in de huidige stand:
-- effectief dry-run — er wordt geen echt bericht gestuurd, alleen een run
-- gestart en gelogd. Zodra de Meta-executor live is en de workflow AAN
-- staat, gaat het bericht ook echt de deur uit.
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING op de name-uniciteit.
-- Bij herhaald draaien geen effect. Verwijder later handmatig via
--   DELETE FROM public.dunning_workflows WHERE name='Vriendelijk duwtje (dag 7)';
-- als de workflow overbodig is (cascade wist steps + runs).
-- ============================================================================

BEGIN;

-- 1) Template (kind='whatsapp'). meta_template_name blijft NULL tot Jeffrey
--    een goedgekeurde Meta-template selecteert; body is een leesbare fallback
--    zodat de log-preview een menselijke tekst toont.
INSERT INTO public.dunning_templates (name, kind, subject, body, meta_template_name, language, is_active)
SELECT
  'Vriendelijk duwtje (dag 7)',
  'whatsapp',
  NULL,
  E'Hoi {{voornaam}} 😊\n\nMisschien had je ''m gemist, maar volgens onze administratie staat de factuur van ons nog open. Zou je er even naar willen kijken?\n\nAlvast bedankt!',
  NULL,
  'nl',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.dunning_templates
   WHERE name = 'Vriendelijk duwtje (dag 7)' AND kind = 'whatsapp'
);

-- 2) Workflow (is_active=false). Priority 50: hoger dan default 100 zodat de
--    duwtje eerder verwerkt wordt dan zwaardere aanmaan-workflows binnen
--    dezelfde engine-tick. Beïnvloedt de bestaande workflows niet want die
--    zijn per klant (uniciteit via active-run check).
INSERT INTO public.dunning_workflows (name, description, trigger_conditions, is_active, priority)
SELECT
  'Vriendelijk duwtje (dag 7)',
  'Vriendelijk WhatsApp-duwtje 7 dagen na factuurdatum als de factuur nog openstaat. Vuurt max 1× per klant. Standaard uit tot Jeffrey de workflow activeert.',
  jsonb_build_object(
    'min_days_since_invoice_date', 7,
    'run_once_per_customer_per_workflow', true,
    'min_total_amount', 0
  ),
  false,
  50
WHERE NOT EXISTS (
  SELECT 1 FROM public.dunning_workflows WHERE name = 'Vriendelijk duwtje (dag 7)'
);

-- 3) Step (step_type='whatsapp') die verwijst naar de template hierboven.
INSERT INTO public.dunning_workflow_steps (workflow_id, step_order, step_type, config)
SELECT
  wf.id,
  1,
  'whatsapp',
  jsonb_build_object('template_id', tpl.id)
FROM public.dunning_workflows wf
JOIN public.dunning_templates tpl
  ON tpl.name = 'Vriendelijk duwtje (dag 7)' AND tpl.kind = 'whatsapp'
WHERE wf.name = 'Vriendelijk duwtje (dag 7)'
  AND NOT EXISTS (
    SELECT 1 FROM public.dunning_workflow_steps s
     WHERE s.workflow_id = wf.id AND s.step_order = 1
  );

COMMIT;
