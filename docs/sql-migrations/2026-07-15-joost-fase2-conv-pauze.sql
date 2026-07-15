-- 2026-07-15-joost-fase2-conv-pauze.sql
-- Joost fase 2: gesprek pauzeert de aanmaningsflow + no-reply-reminders + hervatten.
--
-- DOEL: als een klant reageert, pauzeert de aanmaningsflow (2e pauze-reden
-- naast arrangement). Blijft de klant stil, dan volgen 2 reminders en
-- daarna hervat de aanmaningsflow. Beide pauze-redenen zijn onafhankelijk:
-- een run blijft paused zolang MINSTENS EEN reden actief is.
--
-- Model-keuze: aparte kolom `paused_by_conversation_id` naast bestaande
-- `paused_by_arrangement_id`. Hybrid met bestaande stijl (typed FK,
-- indexeerbaar). Alternatief was een jsonb-reasons-array; afgewogen tegen
-- migratie-complexiteit + query-vriendelijkheid gaat de aparte kolom voor.
-- Voor toekomstige extra pauze-redenen kunnen we altijd nog migreren.
--
-- Nieuwe kolommen op dunning_workflow_runs:
--   paused_by_conversation_id             uuid FK naar whatsapp_conversations
--   paused_conversation_reminder_count    int DEFAULT 0 (0/1/2)
--   paused_conversation_last_reminder_at  timestamptz
--
-- Config-keys op joost_config.autonomy_config voor 'finance':
--   no_reply.reminder_1_hours      = 20   (uren na klant-inbound → reminder 1)
--   no_reply.reminder_2_hours      = 24   (uren na reminder 1 → reminder 2)
--   no_reply.resume_after_hours    = 24   (uren na reminder 2 → hervat run)
--   no_reply.reminder_2_template_name = NULL (Meta-template naam, Jeffrey vult)
--
-- Dode config opruimen: outbound.no_reply_days_per_step (nergens gelezen).
--
-- SQL-string-conventie: geen losse apostrofs; tokenizer-check vóór oplevering.

BEGIN;

-- =============================================================================
-- 1) dunning_workflow_runs: 3 nieuwe kolommen voor gespreks-pauze
-- =============================================================================
ALTER TABLE public.dunning_workflow_runs
  ADD COLUMN IF NOT EXISTS paused_by_conversation_id uuid
    REFERENCES public.whatsapp_conversations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.dunning_workflow_runs.paused_by_conversation_id IS
  'Conversation-id die deze run pauzeert (Joost fase 2). Onafhankelijk van paused_by_arrangement_id: een run kan door beide pauze-redenen tegelijk paused zijn en blijft paused zolang minstens één reden actief is.';

ALTER TABLE public.dunning_workflow_runs
  ADD COLUMN IF NOT EXISTS paused_conversation_reminder_count int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.dunning_workflow_runs.paused_conversation_reminder_count IS
  'Aantal reminders al gestuurd binnen huidige gespreks-pauze (0 = nog geen, 1 = na reminder 1, 2 = na reminder 2). Reset bij nieuwe inbound van klant.';

ALTER TABLE public.dunning_workflow_runs
  ADD COLUMN IF NOT EXISTS paused_conversation_last_reminder_at timestamptz;

COMMENT ON COLUMN public.dunning_workflow_runs.paused_conversation_last_reminder_at IS
  'Timestamp van laatste verzonden reminder in huidige gespreks-pauze. Gebruikt door cron-dunning-conversation-reminders om reminder 2 en resume timing te bepalen.';

CREATE INDEX IF NOT EXISTS idx_dunning_runs_paused_by_conversation
  ON public.dunning_workflow_runs (paused_by_conversation_id)
  WHERE paused_by_conversation_id IS NOT NULL;

-- =============================================================================
-- 2) joost_config.autonomy_config: no_reply sub-object seeden voor 'finance'
-- =============================================================================
-- Idempotent: alleen zetten waar het no_reply-blok nog niet bestaat, en
-- daarna sub-keys aanvullen als ze ontbreken.
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{no_reply}',
      jsonb_build_object(
        'reminder_1_hours',           20,
        'reminder_2_hours',           24,
        'resume_after_hours',         24,
        'reminder_2_template_name',   null
      ),
      true
    ),
    updated_at = now()
WHERE module = 'finance'
  AND NOT (autonomy_config ? 'no_reply');

-- Als no_reply al bestaat: individuele sub-keys aanvullen zonder bestaande
-- te overschrijven. Per key een guarded jsonb_set.
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{no_reply,reminder_1_hours}',
      to_jsonb(20),
      true
    ),
    updated_at = now()
WHERE module = 'finance'
  AND autonomy_config ? 'no_reply'
  AND NOT (autonomy_config->'no_reply' ? 'reminder_1_hours');

UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{no_reply,reminder_2_hours}',
      to_jsonb(24),
      true
    ),
    updated_at = now()
WHERE module = 'finance'
  AND autonomy_config ? 'no_reply'
  AND NOT (autonomy_config->'no_reply' ? 'reminder_2_hours');

UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{no_reply,resume_after_hours}',
      to_jsonb(24),
      true
    ),
    updated_at = now()
WHERE module = 'finance'
  AND autonomy_config ? 'no_reply'
  AND NOT (autonomy_config->'no_reply' ? 'resume_after_hours');

UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{no_reply,reminder_2_template_name}',
      'null'::jsonb,
      true
    ),
    updated_at = now()
WHERE module = 'finance'
  AND autonomy_config ? 'no_reply'
  AND NOT (autonomy_config->'no_reply' ? 'reminder_2_template_name');

-- =============================================================================
-- 3) Dode config opruimen: outbound.no_reply_days_per_step
-- =============================================================================
-- Werd nergens gelezen door de engine; alleen door de UI geschreven. Ruim op.
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{outbound}',
      (autonomy_config->'outbound') - 'no_reply_days_per_step',
      false
    ),
    updated_at = now()
WHERE autonomy_config->'outbound' ? 'no_reply_days_per_step';

COMMIT;

-- =============================================================================
-- VERIFICATIE (handmatig na draaien)
-- =============================================================================
-- SELECT autonomy_config->'no_reply' AS no_reply,
--        autonomy_config->'outbound' AS outbound
-- FROM public.joost_config
-- WHERE module = 'finance';
-- Verwacht: no_reply = { reminder_1_hours: 20, reminder_2_hours: 24,
--                        resume_after_hours: 24, reminder_2_template_name: null }
--          outbound = zonder no_reply_days_per_step
--
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'dunning_workflow_runs'
--   AND column_name LIKE 'paused_%conversation%';
-- Verwacht: 3 rijen (id / reminder_count / last_reminder_at).
--
-- =============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- =============================================================================
-- BEGIN;
--   ALTER TABLE public.dunning_workflow_runs DROP COLUMN IF EXISTS paused_by_conversation_id;
--   ALTER TABLE public.dunning_workflow_runs DROP COLUMN IF EXISTS paused_conversation_reminder_count;
--   ALTER TABLE public.dunning_workflow_runs DROP COLUMN IF EXISTS paused_conversation_last_reminder_at;
--   UPDATE public.joost_config
--   SET autonomy_config = autonomy_config #- '{no_reply}'
--   WHERE autonomy_config ? 'no_reply';
-- COMMIT;
