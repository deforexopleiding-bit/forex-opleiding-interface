-- ============================================================================
-- Comms — Onboarding-reminders FASE C2 — schema + config-stub.
-- Datum: 2026-06-24
-- Branch: feat/comms-onboarding-reminders
--
-- Twee onderdelen:
--   1) Schema-uitbreiding op public.onboardings — kolommen reminder_count en
--      last_reminder_at om de cron-idempotentie te bewaken.
--      Toevoegen via ADD COLUMN IF NOT EXISTS is veilig idempotent.
--   2) Config-stub in public.joost_config (module='onboarding') — UPDATE op
--      knowledge_base->'reminders' met enabled=false en lege schedule (cron
--      doet niets in deze staat). Jeffrey vult schedule + zet enabled=true
--      wanneer de reminder-templates APPROVED zijn.
--
-- BEIDE BLOKKEN ZIJN IDEMPOTENT — re-run is veilig.
-- ============================================================================

BEGIN;

-- ── A. onboardings.reminder_count + last_reminder_at ──────────────────────
ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS reminder_count int NOT NULL DEFAULT 0;

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;

COMMENT ON COLUMN public.onboardings.reminder_count IS
  'Aantal succesvol verzonden reminder-stappen. Gebruikt door '
  'api/cron/onboarding-reminders.js: cron pakt schedule[reminder_count] en '
  'verhoogt na succes. Cap = joost_config.knowledge_base.reminders.max_reminders '
  '(default 1).';

COMMENT ON COLUMN public.onboardings.last_reminder_at IS
  'Timestamp van de laatste succesvol verzonden reminder. Audit + UI. NULL = '
  'nooit een reminder verzonden.';

-- ── B. joost_config.reminders-stub voor module='onboarding' ───────────────
-- Default UIT (enabled=false) + lege schedule. Cron doet zo niets tot
-- Jeffrey de echte template-namen + day_offsets invult en enabled=true zet.
--
-- Hoe Jeffrey invult (PROD), voorbeeld met 2 reminders op dag 3 en dag 7:
--   UPDATE public.joost_config
--   SET knowledge_base = jsonb_set(
--         coalesce(knowledge_base, '{}'::jsonb),
--         '{reminders}',
--         jsonb_build_object(
--           'enabled',             true,
--           'schedule',            jsonb_build_array(
--             jsonb_build_object('day_offset', 3, 'template_name', '<reminder_template_dag_3>', 'language', 'nl'),
--             jsonb_build_object('day_offset', 7, 'template_name', '<reminder_template_dag_7>', 'language', 'nl')
--           ),
--           'max_reminders',       2,
--           'only_if_not_started', true,
--           'stop_on_inbound',     true
--         )
--       )
--   WHERE module = 'onboarding';
--
-- Variabelen die de reminder-template kan gebruiken (zelfde resolver als
-- invite — zie api/_lib/template-variables.js):
--   {{klant.voornaam}}            — voornaam van de student
--   {{klant.naam}}                — voor- + achternaam
--   {{onboarding.wizard_link}}    — persoonlijke wizard-URL
--   {{onboarding.traject_label}}  — label van het gekozen traject
--   {{onboarding.status}}         — 'aangemeld' / 'bezig' / etc.
--   {{bedrijf.naam}} / {{afdeling.*}}

UPDATE public.joost_config
SET knowledge_base = jsonb_set(
      coalesce(knowledge_base, '{}'::jsonb),
      '{reminders}',
      jsonb_build_object(
        'enabled',             false,
        'schedule',            '[]'::jsonb,
        'max_reminders',       1,
        'only_if_not_started', true,
        'stop_on_inbound',     true
      ),
      true
    )
WHERE module = 'onboarding'
  AND NOT (coalesce(knowledge_base, '{}'::jsonb) ? 'reminders');

COMMIT;

-- Verificatie:
--   SELECT id, reminder_count, last_reminder_at
--   FROM public.onboardings
--   WHERE invite_sent_at IS NOT NULL ORDER BY invite_sent_at DESC LIMIT 5;
--
--   SELECT module, knowledge_base->'reminders' AS reminders
--   FROM public.joost_config WHERE module='onboarding';
--
-- ROLLBACK schema:
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS reminder_count;
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS last_reminder_at;
--   UPDATE public.joost_config
--     SET knowledge_base = knowledge_base - 'reminders'
--     WHERE module='onboarding';
