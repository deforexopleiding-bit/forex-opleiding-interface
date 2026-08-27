-- migrations/049_call_log.sql
--
-- Generieke bel-log-tabel voor uitgaande klx-softphone-gesprekken (los van
-- dunning_call_log dat dunning-specifiek is: customer_id NOT NULL, invoice_id,
-- pending_action_id, dunning-outcome-enum). Aparte tabel houdt beide streams
-- schoon en voorkomt vervuiling van bestaande dunning-rapportage.
--
-- Append-only (INSERT via endpoint). RLS: user ziet eigen rijen; super_admin
-- ziet alles. Voys CDR-webhook (v2, apart onderzoek) zal duration_sec +
-- outcome later authoritative kunnen updaten.
--
-- Herstel-context (2026-08-27): dit bestand verdween in een rebase over 3
-- parallelle commits tijdens #snapshot-B. De tabel zelf bestaat sinds
-- #call-log-A-migratie in Supabase; dit SQL-bestand is voor repo-documentatie
-- en herhaalbare deploys. Idempotent (CREATE TABLE IF NOT EXISTS etc.).

create table if not exists call_log (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete set null,
  customer_id    uuid null references customers(id) on delete set null,
  lead_id        uuid null,                                                -- loose FK naar follow_up_leads
  to_number      text not null,                                            -- E.164 gebeld
  from_number    text null,                                                -- gekozen caller-ID
  line           text not null check (line in ('nl','be')),
  started_at     timestamptz not null,                                     -- INVITE-moment (client)
  ended_at       timestamptz null,                                         -- hangup-moment; null = onafgeronde/crashed call
  duration_sec   int null,                                                 -- server-computed (ended - started)
  outcome_hint   text null check (outcome_hint in ('answered','no_answer','busy','failed','local_cancel')),
                                                                            -- client-heuristiek uit state.lastState
  source         text not null default 'klx_softphone',                    -- reservering: voys_cdr in v2
  meta           jsonb null,                                                -- vrije context (event_attendee_id, followup_id, etc.)
  created_at     timestamptz not null default now()
);

create index if not exists idx_call_log_user_created  on call_log (user_id, created_at desc);
create index if not exists idx_call_log_customer      on call_log (customer_id, created_at desc);
create index if not exists idx_call_log_started_desc  on call_log (started_at desc);

alter table call_log enable row level security;

-- RLS: super_admin (via profiles.role, is_crm_staff bevestigd sinds mig 041)
-- ziet alles; overige rollen alleen eigen rijen. Endpoint gebruikt
-- supabaseAdmin (bypass RLS) voor writes; client leest via createUserClient
-- waar deze policy actief is.
drop policy if exists call_log_select_own on call_log;
create policy call_log_select_own on call_log
  for select using (
    user_id = auth.uid()
    or exists (select 1 from profiles where id = auth.uid() and role = 'super_admin')
  );

notify pgrst, 'reload schema';

-- ── VERIFICATIE (draai los, na commit) ────────────────────────────────
-- select count(*) from call_log;
-- select policyname, cmd, qual from pg_policies where tablename = 'call_log';
--   → 1 rij: call_log_select_own · SELECT.
