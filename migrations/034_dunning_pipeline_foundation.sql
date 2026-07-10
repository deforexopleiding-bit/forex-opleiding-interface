-- Migratie 034 — Dunning Pipeline foundation (Fase 1: datalaag)
--
-- Nieuwe menselijke overzicht/afspraken/logboek-laag voor wanbetalers.
-- APART van dunning_workflow_runs (die is de verzend-sequence). De
-- pipeline krijgt SIGNALEN van bestaande systemen (bulk-send, inbound
-- WA, betaal-registratie, dagelijkse engine-cron) via helpers in
-- api/_lib/dunning-pipeline.js — pipeline-schrijf-paden zijn fail-soft
-- zodat een pipeline-fout de onderliggende actie nooit laat falen.
--
-- pgcrypto (gen_random_uuid) is Supabase-default, geen CREATE EXTENSION
-- vereist.
--
-- Idempotent (IF NOT EXISTS). Jeffrey draait handmatig.

-- ────────────────────────────────────────────────────────────────────
-- 1) STAGES — aanpasbare fase-definities
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.dunning_pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  label        text not null,
  sort_order   int  not null default 0,
  color        text,
  is_active    boolean not null default true,
  is_terminal  boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Seed 8 default-fases (idempotent via ON CONFLICT slug DO NOTHING).
insert into public.dunning_pipeline_stages (slug, label, sort_order, color, is_terminal) values
  ('nieuw',           'Nieuw',            0, '#94a3b8', false),
  ('aangemaand',      'Aangemaand',       1, '#f59e0b', false),
  ('in_gesprek',      'In gesprek',       2, '#3b82f6', false),
  ('regeling',        'Regeling',         3, '#8b5cf6', false),
  ('brief_verstuurd', 'Brief verstuurd',  4, '#0ea5e9', false),
  ('incasso',         'Incasso',          5, '#ef4444', false),
  ('afschrijven',     'Afschrijven',      6, '#6b7280', true),
  ('opgelost',        'Opgelost',         7, '#10b981', true)
on conflict (slug) do nothing;

-- ────────────────────────────────────────────────────────────────────
-- 2) CUSTOMERS — fase per klant (één rij per wanbetaler)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.dunning_pipeline_customers (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null unique,
  stage_slug         text not null default 'nieuw',
  stage_changed_at   timestamptz not null default now(),
  stage_changed_by   text,
  last_activity_at   timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_dun_pipeline_cust_stage
  on public.dunning_pipeline_customers (stage_slug);

-- ────────────────────────────────────────────────────────────────────
-- 3) LOG — chronologisch logboek per klant
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.dunning_pipeline_log (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null,
  entry_type   text not null check (entry_type in ('note','auto_event','stage_change','appointment')),
  body         text,
  meta         jsonb,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_dun_pipeline_log_cust
  on public.dunning_pipeline_log (customer_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────
-- 4) APPOINTMENTS — afspraken met datum
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.dunning_pipeline_appointments (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null,
  title         text not null,
  due_at        timestamptz not null,
  status        text not null default 'open' check (status in ('open','done','missed')),
  note          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists idx_dun_pipeline_appt_status_due
  on public.dunning_pipeline_appointments (status, due_at);
create index if not exists idx_dun_pipeline_appt_cust
  on public.dunning_pipeline_appointments (customer_id);

-- ────────────────────────────────────────────────────────────────────
-- 5) AUTO-TOGGLES via app_settings (GEEN nieuwe tabel)
-- ────────────────────────────────────────────────────────────────────
-- Key 'dunning_pipeline_auto' met jsonb-value van 4 booleans.
-- Default alles AAN. isAutoEnabled(key) leest deze; ontbrekend/false → default true.
insert into public.app_settings (key, value)
select 'dunning_pipeline_auto',
       jsonb_build_object(
         'on_overdue_to_nieuw',        true,
         'on_bulk_sent_to_aangemaand', true,
         'on_inbound_to_in_gesprek',   true,
         'on_paid_to_opgelost',        true
       )
where not exists (select 1 from public.app_settings where key = 'dunning_pipeline_auto');

notify pgrst, 'reload schema';
