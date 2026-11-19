-- 2026-11-17 — De brieven van het bord (LMS Administratie) samen met Wanbetalers › Brieven.
--
-- ADDITIEF: twee nullable kolommen + een index. Geen data, geen drop.
-- lms_dossier_id = het betalingsdossier op het bord (hlms_admin_dossier.id in het LMS),
-- lms_brief_nr   = 1 (tussenbrief) of 2 (pre-incassobrief).
-- Gezet door api/_lib/brieven-lms.js (de enige schrijver); leeg = niet gekoppeld.
-- Zonder deze migratie werkt de spiegel niet (de code meldt dat), de rest van Brieven blijft werken.

alter table public.dunning_briefs add column if not exists lms_dossier_id uuid;
alter table public.dunning_briefs add column if not exists lms_brief_nr smallint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dunning_briefs_lms_brief_nr_check') then
    alter table public.dunning_briefs add constraint dunning_briefs_lms_brief_nr_check check (lms_brief_nr in (1, 2));
  end if;
end $$;

create index if not exists dunning_briefs_lms_dossier_idx on public.dunning_briefs (lms_dossier_id) where lms_dossier_id is not null;

-- Controle na (alleen lezen): twee kolommen, alle rijen nog leeg.
select
  (select count(*) from information_schema.columns where table_name = 'dunning_briefs' and column_name in ('lms_dossier_id', 'lms_brief_nr')) as kolommen,
  (select count(*) from public.dunning_briefs where lms_dossier_id is not null) as gekoppeld;
