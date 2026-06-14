-- Events automation engine: configureerbare lifecycle-flows (trigger -> wait -> condition -> action)

-- 1) Automations (de configureerbare flows)
create table if not exists public.event_automations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  description        text,
  enabled            boolean not null default false,
  enabled_at         timestamptz,
  trigger_type       text not null check (trigger_type in ('on_signup','on_assessment_completed','time_before_event')),
  trigger_config     jsonb not null default '{}'::jsonb,
  scope_type         text not null default 'all' check (scope_type in ('all','niveau','events')),
  scope_config       jsonb not null default '{}'::jsonb,
  enroll_mode        text not null default 'new_only' check (enroll_mode in ('new_only','include_existing')),
  steps              jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by_user_id uuid
);
create index if not exists idx_event_automations_enabled on public.event_automations (enabled) where enabled = true;

-- 2) Runs (per attendee x automation: cursor + planning)
create table if not exists public.event_automation_runs (
  id                 uuid primary key default gen_random_uuid(),
  automation_id      uuid not null references public.event_automations(id) on delete cascade,
  attendee_id        uuid not null references public.event_attendees(id) on delete cascade,
  event_id           uuid,
  status             text not null default 'active' check (status in ('active','completed','exited','failed','cancelled')),
  current_step_index int not null default 0,
  next_run_at        timestamptz,
  steps_snapshot     jsonb not null,
  context            jsonb not null default '{}'::jsonb,
  attempts           int not null default 0,
  last_error         text,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  updated_at         timestamptz not null default now(),
  unique (automation_id, attendee_id)
);
create index if not exists idx_eauto_runs_due on public.event_automation_runs (status, next_run_at);

-- 3) Run-log (per uitgevoerde stap: audit + idempotency)
create table if not exists public.event_automation_run_log (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.event_automation_runs(id) on delete cascade,
  step_index   int not null,
  step_type    text,
  executed_at  timestamptz not null default now(),
  result       jsonb,
  unique (run_id, step_index)
);

-- 4) Assessment-link watermerk op attendees (voor on_assessment_completed + conditie)
alter table public.event_attendees add column if not exists assessment_linked_at timestamptz;
update public.event_attendees
   set assessment_linked_at = coalesce(registered_at, now())
 where assessment_response_id is not null and assessment_linked_at is null;

-- 5) RLS: service-role-only (geen policies; toegang via endpoints met supabaseAdmin + RBAC)
alter table public.event_automations        enable row level security;
alter table public.event_automation_runs    enable row level security;
alter table public.event_automation_run_log enable row level security;
