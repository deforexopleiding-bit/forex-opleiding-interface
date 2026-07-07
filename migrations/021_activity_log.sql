-- 021_activity_log.sql — Activiteitenlogboek fundament (PR1)
--
-- Twee tabellen:
--   * activity_log        — append-only log van elke permission-check (allow + deny) + login
--   * user_last_activity  — snapshot per user voor snel "laatst ingelogd/actief"-overzicht
--
-- Beide tabellen zijn RLS-beveiligd: alleen service-role schrijft (via
-- api/_lib/activity-logger.js). Client-reads worden geblokkeerd; het
-- logboek-scherm (PR2) leest via een beschermd server-endpoint dat de
-- 'audit.log.view'-permission afdwingt.
--
-- 90-dagen opschoning gebeurt via api/cron-activity-log-cleanup.js
-- (dagelijkse cron).
--
-- Idempotent: veilig opnieuw te draaien (IF NOT EXISTS, DROP POLICY IF EXISTS).

-- ── 1) activity_log ──────────────────────────────────────────────────────────
create table if not exists activity_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid null,                       -- auth.uid van de actor (null bij anoniem)
  user_email   text null,                       -- snapshot voor leesbaarheid (blijft leesbaar als user later weg is)
  user_role    text null,                       -- rol-snapshot op moment van actie
  action       text not null,                   -- permission-key of endpoint-naam
  endpoint     text null,                       -- API-pad
  method       text null,                       -- GET/POST/…
  status_code  int  null,                       -- HTTP-resultaat
  success      boolean null,                    -- status_code < 400
  module       text null,                       -- sidebar-module afgeleid uit endpoint (Finance/Onboarding/…)
  ip           text null,
  user_agent   text null,
  detail       jsonb null,                      -- ruimte voor latere verrijking
  created_at   timestamptz not null default now()
);

-- module-kolom kan ontbreken bij een bestaande activity_log uit een eerdere
-- run — voeg 'em idempotent toe.
alter table activity_log add column if not exists module text null;

create index if not exists activity_log_user_id_idx    on activity_log (user_id);
create index if not exists activity_log_created_at_idx on activity_log (created_at desc);
create index if not exists activity_log_action_idx     on activity_log (action);
create index if not exists activity_log_module_idx     on activity_log (module);

-- ── 2) user_last_activity ────────────────────────────────────────────────────
create table if not exists user_last_activity (
  user_id           uuid primary key,
  user_email        text,
  last_login_at     timestamptz null,
  last_activity_at  timestamptz null,
  last_ip           text null,
  updated_at        timestamptz default now()
);

-- ── 3) RLS ───────────────────────────────────────────────────────────────────
-- Beide tabellen: RLS AAN + default-deny voor alle client-rollen
-- (authenticated/anon). Service-role bypasst RLS altijd → server-side
-- inserts/reads werken transparant. Het logboek-scherm (PR2) leest via een
-- server-endpoint dat de 'audit.log.view'-permission afdwingt.

alter table activity_log       enable row level security;
alter table user_last_activity enable row level security;

-- Drop bestaande policies (idempotent).
drop policy if exists "activity_log_no_client_read"        on activity_log;
drop policy if exists "user_last_activity_no_client_read"  on user_last_activity;

-- Expliciete deny-policies voor client-rollen. Zonder USING true zou een
-- ontbrekende policy sowieso alles blokkeren, maar dit maakt de intentie
-- expliciet in de policy-lijst.
create policy "activity_log_no_client_read"
  on activity_log
  for select
  to authenticated, anon
  using (false);

create policy "user_last_activity_no_client_read"
  on user_last_activity
  for select
  to authenticated, anon
  using (false);

-- ── 4) Schema-reload ────────────────────────────────────────────────────────
notify pgrst, 'reload schema';
