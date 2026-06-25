-- ============================================================================
-- Onboarding automation engine — Fase 1 foundation
-- Datum: 2026-06-25
-- Branch: feat/onboarding-automations-fase1
--
-- Port van event_automations (zie 2026-06-14-events-automations.sql +
-- 2026-06-18-events-automations-fase-4a.sql + 2026-06-19-event-attendees-
-- automation-enabled.sql) naar onboardings. Events tabellen blijven 100%
-- ongemoeid. Onboardings krijgen een eigen lifecycle-engine.
--
-- Tabellen:
--   onboarding_automations           — configureerbare flows
--   onboarding_automation_runs       — per-onboarding cursor
--   onboarding_automation_run_log    — audit + idempotency
--
-- Schema-keuzes vs. events-versie:
--   - Geen scope_type/scope_config: onboardings hebben geen niveau/event-pool.
--     Trigger-config is genoeg om "welke onboardings horen erbij" te bepalen.
--   - enroll_mode kept (new_only / include_existing) voor terugcompat-flexibility.
--   - Triggers: on_onboarding_created / on_wizard_completed / time_after_signup /
--     on_wizard_not_started_after. De eerste twee worden ZOWEL door de hook in
--     onboarding-create.js / onboarding-complete.js direct geënroleerd (instant)
--     ALS in de cron-poll opgepakt voor de catch-up van missers (fail-soft).
--
-- Per-onboarding opt-out: onboardings.automation_enabled boolean, default true.
-- Mirror van event_attendees.automation_enabled (zie 2026-06-19-…sql).
--
-- RBAC: 2 nieuwe feature_keys (onboarding.automation.view + .edit) toegekend
-- aan manager + admin. super_admin krijgt alles automatisch via
-- user_has_permission().
--
-- Idempotent: IF NOT EXISTS-guards + DROP/RE-ADD voor checks.
-- ============================================================================

BEGIN;

-- 1) onboarding_automations (de configureerbare flows) ----------------------
CREATE TABLE IF NOT EXISTS public.onboarding_automations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  description        text,
  enabled            boolean NOT NULL DEFAULT false,
  enabled_at         timestamptz,
  trigger_type       text NOT NULL,
  trigger_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enroll_mode        text NOT NULL DEFAULT 'new_only',
  steps              jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid
);

ALTER TABLE public.onboarding_automations
  DROP CONSTRAINT IF EXISTS onboarding_automations_trigger_type_check;
ALTER TABLE public.onboarding_automations
  ADD CONSTRAINT onboarding_automations_trigger_type_check
  CHECK (trigger_type IN (
    'on_onboarding_created',
    'on_wizard_completed',
    'time_after_signup',
    'on_wizard_not_started_after'
  ));

ALTER TABLE public.onboarding_automations
  DROP CONSTRAINT IF EXISTS onboarding_automations_enroll_mode_check;
ALTER TABLE public.onboarding_automations
  ADD CONSTRAINT onboarding_automations_enroll_mode_check
  CHECK (enroll_mode IN ('new_only','include_existing'));

CREATE INDEX IF NOT EXISTS idx_onboarding_automations_enabled
  ON public.onboarding_automations (enabled) WHERE enabled = true;

COMMENT ON COLUMN public.onboarding_automations.trigger_type IS
  'Wanneer de engine een onboarding aan deze automation moet koppelen. '
  '- on_onboarding_created: zodra de onboarding bestaat (hook + catch-up cron). '
  '- on_wizard_completed: zodra status=afgerond (hook + catch-up cron). '
  '- time_after_signup: X uur/dagen na onboardings.created_at. '
  '- on_wizard_not_started_after: X uur/dagen na created_at, wizard niet gestart.';

-- 2) onboarding_automation_runs (per-onboarding cursor + planning) ----------
CREATE TABLE IF NOT EXISTS public.onboarding_automation_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id      uuid NOT NULL REFERENCES public.onboarding_automations(id) ON DELETE CASCADE,
  onboarding_id      uuid NOT NULL REFERENCES public.onboardings(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','exited','failed','cancelled')),
  current_step_index int NOT NULL DEFAULT 0,
  next_run_at        timestamptz,
  steps_snapshot     jsonb NOT NULL,
  context            jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts           int NOT NULL DEFAULT 0,
  last_error         text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, onboarding_id)
);

CREATE INDEX IF NOT EXISTS idx_onb_auto_runs_due
  ON public.onboarding_automation_runs (status, next_run_at);

-- 3) onboarding_automation_run_log (per uitgevoerde stap: audit + idempotency)
CREATE TABLE IF NOT EXISTS public.onboarding_automation_run_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES public.onboarding_automation_runs(id) ON DELETE CASCADE,
  step_index   int NOT NULL,
  step_type    text,
  executed_at  timestamptz NOT NULL DEFAULT now(),
  result       jsonb,
  UNIQUE (run_id, step_index)
);

-- 4) Per-onboarding opt-out (mirror event_attendees.automation_enabled) -----
ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS automation_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.onboardings.automation_enabled IS
  'Bepaalt of deze onboarding door automations wordt opgepakt. true (default) = ja. '
  'false = uitgesloten van ALLE onboarding-automations (admin-override).';

CREATE INDEX IF NOT EXISTS idx_onboardings_automation_enabled
  ON public.onboardings (automation_enabled)
  WHERE automation_enabled = false;

-- 5) RLS: service-role-only (geen policies; toegang via endpoints + RBAC) ---
ALTER TABLE public.onboarding_automations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_automation_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_automation_run_log ENABLE ROW LEVEL SECURITY;

-- 6) RBAC: nieuwe feature_keys voor automation CRUD ------------------------
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r, k, true
FROM (VALUES ('manager'), ('admin')) AS roles(r)
CROSS JOIN (VALUES
  ('onboarding.automation.view'),   -- list / templates-list
  ('onboarding.automation.edit')    -- save / delete
) AS keys(k)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = roles.r AND rp.feature_key = keys.k
);

COMMIT;

-- ROLLBACK:
--   DROP TABLE IF EXISTS public.onboarding_automation_run_log CASCADE;
--   DROP TABLE IF EXISTS public.onboarding_automation_runs    CASCADE;
--   DROP TABLE IF EXISTS public.onboarding_automations        CASCADE;
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS automation_enabled;
--   DELETE FROM public.role_permissions
--     WHERE feature_key IN ('onboarding.automation.view','onboarding.automation.edit');
