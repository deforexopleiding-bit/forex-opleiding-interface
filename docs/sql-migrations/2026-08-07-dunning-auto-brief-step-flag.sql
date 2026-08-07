-- 2026-08-07 — Activeer auto-WIK-brief op de dag-17-WhatsApp-stap
--
-- De dunning-engine haakt op een STAP-VLAG, niet op een hardcoded step_order of
-- template_id (de stappen zijn al eens hernummerd). shouldAutoGenerateBrief()
-- vuurt alleen als:  step_type='whatsapp'  EN  config.auto_generate_brief=true
-- EN de send succesvol was (log_event='whatsapp_sent').
--
-- ⚠ DRAAI EERST DE VERIFICATIE. Bevestig dat step_order 9 (whatsapp) van
-- 'Aanmaningen' inderdaad het "vandaag krijg je een brief"-bericht is — en
-- NIET step 10 (e-mail). Zet de vlag alleen op de bevestigde WhatsApp-stap.
--
-- Vereist: 2026-08-07-dunning-briefs-run-id-dedup.sql is al gedraaid.

-- ── VERIFICATIE (read-only) ─────────────────────────────────────────────────
-- Verwacht: step 9 = whatsapp met een body die de brief aankondigt.
--   SELECT s.step_order, s.step_type, t.name, t.body
--   FROM public.dunning_workflow_steps s
--   JOIN public.dunning_workflows w  ON w.id = s.workflow_id
--   LEFT JOIN public.dunning_templates t ON t.id = (s.config->>'template_id')::uuid
--   WHERE w.name = 'Aanmaningen' AND s.step_order IN (9, 10)
--   ORDER BY s.step_order;

-- ── ACTIVATIE (idempotent) ──────────────────────────────────────────────────
-- Zet config.auto_generate_brief = true op de dag-17-WhatsApp-stap. Dubbel-gate
-- op step_type='whatsapp' zodat de vlag nooit per ongeluk op de e-mailstap komt.
BEGIN;

UPDATE public.dunning_workflow_steps s
SET config = jsonb_set(s.config, '{auto_generate_brief}', 'true'::jsonb, true),
    step_type = s.step_type  -- no-op, houdt de rij "aangeraakt" consistent
FROM public.dunning_workflows w
WHERE s.workflow_id = w.id
  AND w.name = 'Aanmaningen'
  AND s.step_order = 9
  AND s.step_type = 'whatsapp';

COMMIT;

-- ── CONTROLE ────────────────────────────────────────────────────────────────
-- Verwacht: 1 rij met auto_brief = true.
--   SELECT s.step_order, s.step_type, s.config->>'auto_generate_brief' AS auto_brief
--   FROM public.dunning_workflow_steps s
--   JOIN public.dunning_workflows w ON w.id = s.workflow_id
--   WHERE w.name = 'Aanmaningen' AND s.step_order = 9;

-- ============================================================================
-- ROLLBACK (zet de auto-generatie uit — vlag verwijderen)
-- ============================================================================
-- BEGIN;
--   UPDATE public.dunning_workflow_steps s
--   SET config = s.config - 'auto_generate_brief'
--   FROM public.dunning_workflows w
--   WHERE s.workflow_id = w.id AND w.name = 'Aanmaningen'
--     AND s.step_order = 9 AND s.step_type = 'whatsapp';
-- COMMIT;
