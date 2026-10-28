-- PROJECT: crm (nsjnsvlmdhunzqkdvagm)
--
-- 2026-10-28-checkin-mails.sql — "Jouw DFO-check-in" ook per mail (Maxim,
-- 28 okt 2026). ADDITIEF en HERHAALBAAR.
--
-- Het logboek van de check-in-mails: welke mail (uitnodiging, herinnering na
-- 5 en na 10 dagen) wanneer naar welke toewijzing vertrok. Eén rij per
-- (toewijzing, soort): de unieke sleutel is de grendel tegen een tweede mail,
-- ook als twee cronlopen elkaar kruisen. toewijzing_id/campagne_id verwijzen
-- naar het LMS (hlms_checkin_toewijzing / hlms_checkin_campagne, ander
-- project) — daarom geen foreign key. RLS aan, geen policies: alleen de
-- service role (de API).
--
-- De hoofdschakelaar en de teksten staan in app_settings `checkin_mails`
-- (geen migratie; standaard UIT). Zonder deze tabel vertrekt er niets.
--
-- Rollback: drop table if exists public.checkin_mails;

-- ── CONTROLE VOORAF — verwacht: false ──────────────────────────────────────
select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'checkin_mails') as bestaat_al;

create table if not exists public.checkin_mails (
  id            uuid primary key default gen_random_uuid(),
  toewijzing_id uuid not null,
  campagne_id   uuid,
  -- uitnodiging · herinnering_5 · herinnering_10
  soort         text not null,
  -- bezig · verstuurd · mislukt
  status        text not null,
  naar          text,
  fout          text,
  aangemaakt_op timestamptz not null default now(),
  unique (toewijzing_id, soort)
);
create index if not exists checkin_mails_campagne_idx on public.checkin_mails (campagne_id, soort);

alter table public.checkin_mails enable row level security;
revoke all on table public.checkin_mails from anon, authenticated;

-- ── CONTROLE ACHTERAF — verwacht: true, true, 0 ────────────────────────────
select
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'checkin_mails') as bestaat,
  (select relrowsecurity from pg_class where oid = 'public.checkin_mails'::regclass) as rls_aan,
  (select count(*) from public.checkin_mails) as rijen;
