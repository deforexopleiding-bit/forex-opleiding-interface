-- 2026-07-15-aanmaningsflow-wik-termijn.sql
-- Aanpassing workflow "Aanmaningen" (#759): WIK-14-dagentermijn respecteren.
--
-- Achtergrond: de brief-taak op dag 21 kondigt aan dat incassokosten in
-- rekening gebracht kunnen worden. Voor particulieren geldt de WIK: pas 14
-- dagen NA ONTVANGST van die brief mogen die kosten daadwerkelijk worden
-- opgelegd. 9 dagen (dag 21 -> dag 30) is te kort — postbezorging + 14 dg
-- wettelijke termijn zit al op 15-16 dg minimum.
--
-- WIJZIGING (drie stappen, alle idempotent):
--   1) Wait op step_order 13 van 9 -> 16 dagen. (dag 21 + 16 = dag 37,
--      ruim marge voor postbezorging + wettelijke termijn.)
--   2) Templates op dag 30 hernoemen naar dag 37. Koppeling in de workflow
--      loopt via template_id (UUID) — de rename is puur label. Body-tekst
--      blijft ongewijzigd; die gebruikt {{DAGEN_OVERDUE}} en past zichzelf
--      automatisch aan de nieuwe timing.
--   3) Brief-taak (step_order 12): titel + omschrijving updaten zodat 'ie
--      naar de bestaande WIK-brief-generator verwijst i.p.v. "schrijf zelf
--      een brief". Route bevestigd via /api/incasso-pre-brief.js + de
--      #incPreBriefBtn-knop in het incasso-dossier-detailscherm
--      (modules/finance.html r19356).
--
-- SQL-STRING-CONVENTIE (les uit #758): geen losse apostrofs in string-
-- literals. Alle teksten hieronder zijn apostrof-vrij; gevalideerd via
-- tokenizer.
--
-- Andere workflows/templates/steps: niet aangeraakt. Workflow blijft
-- is_active=false (Jeffrey activeert zelf).

BEGIN;

-- ===========================================================================
-- 1. WAIT step 13: 9 -> 16 dagen
-- ===========================================================================
-- Idempotent: alleen updaten waar days=9 nog staat (na eerdere run heeft
-- 'ie al days=16 → deze WHERE-clausule doet niets bij re-run).
UPDATE public.dunning_workflow_steps s
SET config = jsonb_set(s.config, '{days}', to_jsonb(16)),
    -- (dunning_workflow_steps heeft geen updated_at kolom in de foundation-
    -- migratie — dus alleen config bijwerken.)
    step_type = s.step_type
FROM public.dunning_workflows w
WHERE s.workflow_id = w.id
  AND w.name = 'Aanmaningen'
  AND s.step_order = 13
  AND s.step_type = 'wait'
  AND (s.config->>'days')::int = 9;

-- ===========================================================================
-- 2. Rename dag-30 templates -> dag-37
-- ===========================================================================
-- Bodies zelf blijven ongewijzigd (gebruiken {{DAGEN_OVERDUE}} dus vullen
-- zichzelf correct in). Alleen de NAAM verandert; de UUID (en daarmee de
-- workflow-koppeling) blijft intact.
UPDATE public.dunning_templates
SET name = 'Aanmaning dag 37 (WhatsApp)',
    updated_at = now()
WHERE name = 'Aanmaning dag 30 (WhatsApp)'
  AND kind = 'whatsapp';

UPDATE public.dunning_templates
SET name = 'Aanmaning dag 37 (E-mail)',
    updated_at = now()
WHERE name = 'Aanmaning dag 30 (E-mail)'
  AND kind = 'email';

-- ===========================================================================
-- 3. Brief-taak (step 12): titel + omschrijving vernieuwen
-- ===========================================================================
-- Verwijs naar de bestaande WIK-brief-generator: Wanbetalers > Opruimen >
-- Incasso > dossier openen > knop "Verstuur pre-incassobrief" (endpoint
-- /api/incasso-pre-brief.js). Voor NL rendert die de WIK-14-dagenbrief;
-- voor BE de eerste kosteloze herinnering.
UPDATE public.dunning_workflow_steps s
SET config = jsonb_build_object(
      'title',         'Stuur WIK-14-dagenbrief (aangetekend)',
      'description',   E'Klant is 21 dagen te laat. Genereer de WIK-14-dagenbrief via Wanbetalers > Opruimen > Incasso: open (of maak) het incassodossier van deze klant en klik "Verstuur pre-incassobrief" (NL-variant; BE-klanten krijgen automatisch de BE-eerste-herinnering). Stuur de gegenereerde PDF aangetekend per post.\n\nLET OP: dit is wettelijk vereist voordat incassokosten bij particulieren in rekening gebracht mogen worden. Na verzending mag de vordering pas 14 dagen na ontvangst worden overgedragen — de workflow kondigt incasso daarom pas op dag 37 aan.',
      'assignee_role', 'manager'
    ),
    step_type = s.step_type
FROM public.dunning_workflows w
WHERE s.workflow_id = w.id
  AND w.name = 'Aanmaningen'
  AND s.step_order = 12
  AND s.step_type = 'task';

COMMIT;

-- ============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- ============================================================================
-- BEGIN;
--   -- 1. wait terug van 16 naar 9
--   UPDATE public.dunning_workflow_steps s
--   SET config = jsonb_set(s.config, '{days}', to_jsonb(9))
--   FROM public.dunning_workflows w
--   WHERE s.workflow_id = w.id AND w.name = 'Aanmaningen'
--     AND s.step_order = 13 AND s.step_type = 'wait';
--
--   -- 2. templates terug van dag 37 -> dag 30
--   UPDATE public.dunning_templates SET name = 'Aanmaning dag 30 (WhatsApp)'
--   WHERE name = 'Aanmaning dag 37 (WhatsApp)' AND kind = 'whatsapp';
--   UPDATE public.dunning_templates SET name = 'Aanmaning dag 30 (E-mail)'
--   WHERE name = 'Aanmaning dag 37 (E-mail)' AND kind = 'email';
--
--   -- 3. brief-taak terug naar oorspronkelijke tekst
--   UPDATE public.dunning_workflow_steps s
--   SET config = jsonb_build_object(
--     'title', 'Stuur aangetekende brief',
--     'description', 'Klant is 21 dagen te laat. Stuur de aangetekende brief met aankondiging juridische stappen.',
--     'assignee_role', 'manager'
--   )
--   FROM public.dunning_workflows w
--   WHERE s.workflow_id = w.id AND w.name = 'Aanmaningen'
--     AND s.step_order = 12 AND s.step_type = 'task';
-- COMMIT;
