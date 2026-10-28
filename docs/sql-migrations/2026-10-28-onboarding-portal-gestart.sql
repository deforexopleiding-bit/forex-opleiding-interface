-- PROJECT: forex-command-center (CRM)
--
-- 2026-10-28-onboarding-portal-gestart.sql — wie is al in de NIEUWE onboarding begonnen?
--
-- WAAROM
-- ------
-- current_step betekent twee dingen: in de klassieke wizard een pagina (tot
-- 10), in de nieuwe portal (www.deforexopleiding.nl/onboarding) een scherm
-- van de nieuwe flow (1-op-1 en membership verschillen). Gemeten 28 okt: 14
-- onboardings op 'bezig', bijna allemaal begonnen in de klassieke wizard vóór
-- de portal live ging (27 okt 16:26 UTC). Het overzicht toonde "Stap 3" en
-- dat leest als de nieuwe onboarding. Raden op de sleutels in answers kan
-- niet: beide wizards schrijven dezelfde sleutels.
--
-- WAT DIT DOET (ADDITIEF)
-- -----------------------
--   portal_gestart_op  — gezet door api/onboarding-portal.js bij de EERSTE save
--                        (of bij afronden) in de nieuwe onboarding. NULL =
--                        nog nooit iets bewaard in de nieuwe onboarding.
--   portal_geopend_op  — gezet bij het eerste openen met de startcode.
-- De klassieke wizard (api/onboarding-step-save.js) raakt ze NIET aan.
--
-- GEEN BACKFILL, bewust: gemeten 28 okt 2026 heeft geen enkele open
-- onboarding (aangemeld/bezig) sinds 27 okt 16:26 UTC in de portal bewaard
-- (de enige portal-klant sindsdien is al afgerond, en die telt als afgerond).
-- Wie vóór het draaien van deze migratie nog in de portal bewaart, ziet het
-- overzicht als "oude wizard" tot zijn volgende save — de controle onderaan
-- toont die rijen.
--
-- Zolang dit niet gedraaid is: het overzicht valt terug op de oude
-- afleiding (geen onderscheid oude/nieuwe wizard) en de portal werkt gewoon.
--
-- Herhaalbaar. Rollback: beide kolommen droppen.

-- ── CONTROLE VOORAF (alleen lezen) — verwacht 0 ──────────────────────────────
select count(*) as kolommen from information_schema.columns
 where table_schema = 'public' and table_name = 'onboardings'
   and column_name in ('portal_gestart_op', 'portal_geopend_op');

alter table public.onboardings
  add column if not exists portal_gestart_op timestamptz,
  add column if not exists portal_geopend_op timestamptz;

comment on column public.onboardings.portal_gestart_op is
  'Eerste save (of afronden) in de NIEUWE onboarding-portal. NULL = nooit in de portal bewaard. Gezet door api/onboarding-portal.js; de klassieke wizard raakt hem niet.';
comment on column public.onboardings.portal_geopend_op is
  'Eerste keer dat de klant de nieuwe onboarding-portal opende met zijn startcode. Gezet door api/onboarding-portal.js.';

-- ── CONTROLE ACHTERAF (alleen lezen) — verwacht 2 ───────────────────────────
select count(*) as kolommen from information_schema.columns
 where table_schema = 'public' and table_name = 'onboardings'
   and column_name in ('portal_gestart_op', 'portal_geopend_op');

-- Wie het overzicht nu als "oude wizard (onvolledig)" toont — ter info.
-- Een rij met updated_at NA 2026-10-27 16:26 UTC kan in de portal bewaard
-- hebben vóór deze migratie: die zet zichzelf recht bij de volgende save.
select customer_name, status, current_step, started_at::date, updated_at
  from public.onboardings
 where status = 'bezig' and is_test = false and portal_gestart_op is null
 order by start_date nulls last;
