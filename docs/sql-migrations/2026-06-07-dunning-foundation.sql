-- 2026-06-07-dunning-foundation.sql
-- Wanbetalers-module fundament (PR B1). 5 tabellen voor workflow-engine.
-- Idempotent. RLS aan met phase-1 stub policies (write=false; alleen service-role kan muteren).
-- Granulaire policies komen in latere PRs zodra finance.dunning.* permissions gemapt zijn.

BEGIN;

-- 1. Workflows definitie
CREATE TABLE IF NOT EXISTS public.dunning_workflows (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  description        text,
  trigger_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active          boolean NOT NULL DEFAULT false,
  priority           integer NOT NULL DEFAULT 100,
  created_by_user_id uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dunning_workflows_active
  ON public.dunning_workflows (is_active, priority) WHERE is_active = true;

-- 2. Steps in workflow
CREATE TABLE IF NOT EXISTS public.dunning_workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.dunning_workflows(id) ON DELETE CASCADE,
  step_order  integer NOT NULL,
  step_type   text NOT NULL CHECK (step_type IN ('email','whatsapp','wait','task','stop')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_dunning_steps_workflow
  ON public.dunning_workflow_steps (workflow_id, step_order);

-- 3. Actieve runs per klant
CREATE TABLE IF NOT EXISTS public.dunning_workflow_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id            uuid NOT NULL REFERENCES public.dunning_workflows(id) ON DELETE RESTRICT,
  customer_id            uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','paused','completed','cancelled')),
  current_step_id        uuid REFERENCES public.dunning_workflow_steps(id),
  next_action_at         timestamptz,
  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  completion_reason      text,
  trigger_invoice_count  integer,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dunning_runs_active
  ON public.dunning_workflow_runs (status, next_action_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_dunning_runs_customer
  ON public.dunning_workflow_runs (customer_id);

-- 4. Templates (email + whatsapp)
CREATE TABLE IF NOT EXISTS public.dunning_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('email','whatsapp')),
  subject            text,
  body               text NOT NULL,
  meta_template_name text,
  language           text DEFAULT 'nl',
  is_active          boolean DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 5. Log van events
CREATE TABLE IF NOT EXISTS public.dunning_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid REFERENCES public.dunning_workflow_runs(id) ON DELETE CASCADE,
  step_id    uuid REFERENCES public.dunning_workflow_steps(id),
  event_type text NOT NULL,
  payload    jsonb,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dunning_log_run
  ON public.dunning_log (run_id, created_at DESC);

-- 6. RLS aan (write=false; alleen service-role kan muteren)
ALTER TABLE public.dunning_workflows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_workflow_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_log            ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dunning_wf_select       ON public.dunning_workflows;
DROP POLICY IF EXISTS dunning_wf_write        ON public.dunning_workflows;
CREATE POLICY dunning_wf_select       ON public.dunning_workflows      FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY dunning_wf_write        ON public.dunning_workflows      FOR ALL    USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS dunning_steps_select    ON public.dunning_workflow_steps;
DROP POLICY IF EXISTS dunning_steps_write     ON public.dunning_workflow_steps;
CREATE POLICY dunning_steps_select    ON public.dunning_workflow_steps FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY dunning_steps_write     ON public.dunning_workflow_steps FOR ALL    USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS dunning_runs_select     ON public.dunning_workflow_runs;
DROP POLICY IF EXISTS dunning_runs_write      ON public.dunning_workflow_runs;
CREATE POLICY dunning_runs_select     ON public.dunning_workflow_runs  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY dunning_runs_write      ON public.dunning_workflow_runs  FOR ALL    USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS dunning_tpl_select      ON public.dunning_templates;
DROP POLICY IF EXISTS dunning_tpl_write       ON public.dunning_templates;
CREATE POLICY dunning_tpl_select      ON public.dunning_templates      FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY dunning_tpl_write       ON public.dunning_templates      FOR ALL    USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS dunning_log_select      ON public.dunning_log;
DROP POLICY IF EXISTS dunning_log_write       ON public.dunning_log;
CREATE POLICY dunning_log_select      ON public.dunning_log            FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY dunning_log_write       ON public.dunning_log            FOR ALL    USING (false) WITH CHECK (false);

COMMIT;
