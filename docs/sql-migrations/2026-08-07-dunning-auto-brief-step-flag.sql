-- 2026-08-07 — Activeer auto-WIK-brief op de dag-21-WhatsApp-stap (step_order 12)
--
-- De dunning-engine haakt op een STAP-VLAG, niet op een hardcoded step_order of
-- template_id (de stappen zijn al eens hernummerd). shouldAutoGenerateBrief()
-- vuurt alleen als:  step_type='whatsapp'  EN  config.auto_generate_brief=true
-- EN de send succesvol was (log_event='whatsapp_sent').
--
-- WELKE STAP: het "vandaag krijg je een brief"-bericht is NIET dag 17 (step 8
-- belooft geen brief) maar step_order 12 — "Aanmaning dag 21 (WhatsApp)", met in
-- de body: "…Wij sturen je vandaag ook een brief…". Een query op WhatsApp-stappen
-- met 'brief' in de body gaf uitsluitend step_order 12 terug. Daarom zetten we de
-- vlag op step 12.
--
-- Vereist: 2026-08-07-dunning-briefs-run-id-dedup.sql is al gedraaid.

-- ── VERIFICATIE VOORAF (read-only) ──────────────────────────────────────────
-- Toont de doelstap zodat je vóór én ná kunt controleren (step_order, step_type,
-- config, template-naam + body-snippet). Verwacht: step 12 = whatsapp, body
-- kondigt de brief aan, config.auto_generate_brief nog afwezig/null.
--   SELECT s.step_order, s.step_type, s.config,
--          s.config->>'auto_generate_brief' AS auto_brief,
--          t.name AS template_naam,
--          left(t.body, 160) AS body_snippet
--   FROM public.dunning_workflow_steps s
--   JOIN public.dunning_workflows w  ON w.id = s.workflow_id
--   LEFT JOIN public.dunning_templates t ON t.id = (s.config->>'template_id')::uuid
--   WHERE w.name = 'Aanmaningen' AND s.step_order = 12;

-- ── ACTIVATIE (idempotent) ──────────────────────────────────────────────────
-- Zet config.auto_generate_brief = true op de dag-21-WhatsApp-stap (step 12).
-- Dubbel-gate op step_type='whatsapp' zodat de vlag nooit op een andere stap komt.
BEGIN;

UPDATE public.dunning_workflow_steps s
SET config = jsonb_set(s.config, '{auto_generate_brief}', 'true'::jsonb, true),
    step_type = s.step_type  -- no-op, houdt de rij "aangeraakt" consistent
FROM public.dunning_workflows w
WHERE s.workflow_id = w.id
  AND w.name = 'Aanmaningen'
  AND s.step_order = 12
  AND s.step_type = 'whatsapp';

COMMIT;

-- ── CONTROLE ACHTERAF ───────────────────────────────────────────────────────
-- Verwacht: 1 rij met auto_brief = true op de whatsapp-stap step_order 12.
--   SELECT s.step_order, s.step_type, s.config->>'auto_generate_brief' AS auto_brief
--   FROM public.dunning_workflow_steps s
--   JOIN public.dunning_workflows w ON w.id = s.workflow_id
--   WHERE w.name = 'Aanmaningen' AND s.step_order = 12;

-- ============================================================================
-- ROLLBACK (zet de auto-generatie uit — vlag verwijderen)
-- ============================================================================
-- BEGIN;
--   UPDATE public.dunning_workflow_steps s
--   SET config = s.config - 'auto_generate_brief'
--   FROM public.dunning_workflows w
--   WHERE s.workflow_id = w.id AND w.name = 'Aanmaningen'
--     AND s.step_order = 12 AND s.step_type = 'whatsapp';
-- COMMIT;
