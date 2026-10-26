-- PROJECT: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- 2026-10-26-trial-belpogingen.sql — de bellijst van Leadsonderhoud › The Lab
--
-- Elke trial-lead (minicursus, 7-daagse, webinar, website, The Lab) staat in
-- het overzicht Leadsonderhoud › The Lab. De BELLIJST daar zet de leads in de
-- volgorde waarin ze het meest waard zijn om te bellen; wie belt (Dave, een
-- collega, later een AI-beller) noteert per poging een resultaat + notitie.
-- Eén rij per poging, nooit bijgewerkt (een logboek).
--
-- Toegang: RLS aan, geen policies, REVOKE voor anon/authenticated — enkel de
-- service role (api/trial-belpoging.js na leads.view). Zelfde patroon als de
-- contentmachine-tabellen.
--
-- Niet blokkerend: zonder deze tabel toont de bellijst alles, maar is
-- "resultaat noteren" uitgeschakeld met een melding.
--
-- Rollback (enkel zolang er geen pogingen in staan):
--   drop table if exists public.trial_belpogingen;

-- Controle VÓÓR — verwacht: false
select to_regclass('public.trial_belpogingen') is not null as bestaat;

create table if not exists public.trial_belpogingen (
  id            uuid        primary key default gen_random_uuid(),
  aangemaakt    timestamptz not null default now(),
  lead_id       uuid        references public.leads (id) on delete set null,
  email         text        not null,
  aanmelding_id uuid,
  resultaat     text        not null check (resultaat in (
                  'geen_antwoord', 'voicemail', 'gesproken', 'sessie_geboekt',
                  'terugbellen', 'geen_interesse', 'verkeerd_nummer')),
  notitie       text,
  door_user_id  uuid,
  door_naam     text,
  bron          text        not null default 'leadsonderhoud'   -- 'leadsonderhoud' | 'ai' | …
);

create index if not exists trial_belpogingen_email_idx on public.trial_belpogingen (lower(email), aangemaakt desc);
create index if not exists trial_belpogingen_lead_idx  on public.trial_belpogingen (lead_id, aangemaakt desc);

alter table public.trial_belpogingen enable row level security;
revoke all on public.trial_belpogingen from anon, authenticated;

comment on table public.trial_belpogingen is
  'Belpogingen uit de bellijst van Leadsonderhoud › The Lab (alle trial-leads). Logboek: één rij per poging.';

-- Controle NA — verwacht: true, 0 policies
select to_regclass('public.trial_belpogingen') is not null as bestaat,
       (select count(*) from pg_policies where tablename = 'trial_belpogingen') as policies;
