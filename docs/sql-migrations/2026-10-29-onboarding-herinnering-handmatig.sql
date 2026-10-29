-- PROJECT: forex-command-center (CRM)
--
-- 2026-10-29-onboarding-herinnering-handmatig.sql — "Herinnering nu versturen"
-- vanaf het onboardingbord in het LMS (Maxim, 29 okt 2026).
--
-- ADDITIEF en HERHAALBAAR: drie kolommen op het logboek
-- onboarding_herinneringen (2026-10-28-onboarding-opvolgflow.sql).
--   handmatig  true = met de hand verstuurd (niet door de dagelijkse cron)
--   door       wie het deed (naam + e-mail, "via het LMS")
--   tekst      welke tekst (herinnering_1 · herinnering_2 · laatste); bij een
--              tweede keer dezelfde tekst is de soort 'handmatig:<YYYY-MM-DD>'
--
-- Zonder deze migratie: de voorvertoning werkt, versturen weigert (503
-- migratie_ontbreekt) — er vertrekt dan NIETS met de hand. De cron merkt niets.
--
-- Rollback (alleen als het echt moet):
--   alter table public.onboarding_herinneringen
--     drop column if exists handmatig, drop column if exists door, drop column if exists tekst;

-- ── CONTROLE VOORAF (alleen lezen) — verwacht: 0 ───────────────────────────
select count(*) as kolommen_al
from information_schema.columns
where table_schema = 'public' and table_name = 'onboarding_herinneringen'
  and column_name in ('handmatig', 'door', 'tekst');

alter table public.onboarding_herinneringen add column if not exists handmatig boolean not null default false;
alter table public.onboarding_herinneringen add column if not exists door text;
alter table public.onboarding_herinneringen add column if not exists tekst text;

-- ── CONTROLE ACHTERAF (alleen lezen) — verwacht: 3, true, 0 ─────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'onboarding_herinneringen'
      and column_name in ('handmatig', 'door', 'tekst')) as kolommen,
  (select relrowsecurity from pg_class where oid = 'public.onboarding_herinneringen'::regclass) as rls_aan,
  (select count(*) from public.onboarding_herinneringen where handmatig) as handmatig_rijen;
