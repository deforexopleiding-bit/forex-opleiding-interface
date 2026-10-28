-- PROJECT: crm (nsjnsvlmdhunzqkdvagm)
--
-- 2026-10-28-onboarding-opvolgflow.sql — de opvolgflow onboarding ↔ check-in
-- (Maxim, 28 okt 2026). ADDITIEF en HERHAALBAAR. Niets wordt verwijderd of
-- overschreven; geen bestaande rij verandert.
--
-- 1. onboardings.auto_afgerond_reden — WAAROM een onboarding automatisch dicht
--    ging, naast het bestaande "door welke sessie" (auto_afgerond_sessie_*):
--      'sessie'               de eerste afgeronde sessie (1-op-1, bestond al)
--      'membership_start'     membership: startdatum bereikt en ingevuld
--      'oud_dossier'          start > 30 dagen geleden, nooit ingevuld, en 7
--                             dagen na de laatste herinnering nog altijd niet
--    Geen CHECK: een nieuw woord moet zichtbaar zijn, niet geweigerd worden.
--    ZONDER deze kolom werkt alles; de reden wordt dan alleen niet bewaard
--    (de code schrijft hem pas als de kolom er is).
--
-- 2. onboardings.geen_herinneringen_op / _door — de schakelaar "Geen
--    herinneringen" per student (drawer van het LMS-onboardingbord en het
--    CRM-dossier). Staat hij aan, dan vertrekt er voor die student GEEN enkele
--    automatische onboarding-herinnering. NULL = uit.
--
-- 3. onboarding_herinneringen — het logboek: welke herinnering wanneer naar
--    wie vertrok (of waarom niet). Eén rij per (onboarding, soort): de unieke
--    sleutel is meteen de grendel tegen een tweede mail van dezelfde soort,
--    ook als twee cronlopen elkaar kruisen. RLS aan, geen policies: alleen de
--    service role (de API) leest en schrijft.
--
-- De HOOFDSCHAKELAAR en de teksten staan in app_settings (geen migratie):
--   onboarding_herinneringen  {"aan": false, ...}  — standaard UIT
-- Zie api/_lib/onboarding-herinneringen.js.
--
-- Rollback (alleen als er nog niets in het logboek staat dat je wil houden):
--   drop table if exists public.onboarding_herinneringen;
--   alter table public.onboardings drop column if exists geen_herinneringen_door,
--     drop column if exists geen_herinneringen_op, drop column if exists auto_afgerond_reden;

-- ── CONTROLE VOORAF (alleen lezen) — verwacht: 0, false ─────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'onboardings'
      and column_name in ('auto_afgerond_reden', 'geen_herinneringen_op', 'geen_herinneringen_door')) as kolommen_al,
  exists (select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'onboarding_herinneringen') as tabel_al;

alter table public.onboardings add column if not exists auto_afgerond_reden text;
alter table public.onboardings add column if not exists geen_herinneringen_op timestamptz;
alter table public.onboardings add column if not exists geen_herinneringen_door text;

create table if not exists public.onboarding_herinneringen (
  id            uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.onboardings(id) on delete cascade,
  -- herinnering_1 · herinnering_2 · bijna_start · laatste · signaal_geen_reactie
  soort         text not null,
  -- verstuurd · mislukt · overgenomen (de oude automation stuurde hem al)
  status        text not null,
  naar          text,
  fout          text,
  aangemaakt_op timestamptz not null default now(),
  unique (onboarding_id, soort)
);
create index if not exists onboarding_herinneringen_ob_idx
  on public.onboarding_herinneringen (onboarding_id, aangemaakt_op desc);

alter table public.onboarding_herinneringen enable row level security;
revoke all on table public.onboarding_herinneringen from anon, authenticated;

-- ── CONTROLE ACHTERAF (alleen lezen) — verwacht: 3, true, true, 0 ───────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'onboardings'
      and column_name in ('auto_afgerond_reden', 'geen_herinneringen_op', 'geen_herinneringen_door')) as kolommen,
  exists (select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'onboarding_herinneringen') as tabel,
  (select relrowsecurity from pg_class where oid = 'public.onboarding_herinneringen'::regclass) as rls_aan,
  (select count(*) from public.onboarding_herinneringen) as rijen;
