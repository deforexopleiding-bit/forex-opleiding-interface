-- 2026-10-06 · Onboarding met de hand afronden (forex-command-center).
--
-- Drie nieuwe, lege kolommen op `onboardings`: wie een onboarding met de hand
-- afrondde, wanneer en waarom. Naast de automatische afsluiting
-- (`auto_afgerond_*`), niet in plaats ervan. Zie api/_lib/onboarding-handmatig.js
-- en api/_lib/onboarding-einde.js.
--
-- Additief en herhaalbaar: alleen `add column if not exists`. Er wordt geen
-- bestaande rij gewijzigd.
--
-- NIET BLOKKEREND: de code leest deze kolommen in een aparte, faalzachte
-- query. Zonder migratie werkt alles zoals vandaag; alleen de knop "Onboarding
-- afronden (handmatig)" geeft dan "kan pas na de migratie".
--
-- Elk statement staat los (Supabase SQL-editor).

-- ── 0. Vooraf (alleen lezen): bestaan ze al? ────────────────────────────────
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'onboardings'
--    and column_name like 'handmatig_afgerond%';

alter table public.onboardings add column if not exists handmatig_afgerond_op timestamptz;
alter table public.onboardings add column if not exists handmatig_afgerond_door text;
alter table public.onboardings add column if not exists handmatig_afgerond_reden text;

comment on column public.onboardings.handmatig_afgerond_op is
  'Met de hand afgerond (hoofdmentor/admin), naast auto_afgerond_op. Zie api/_lib/onboarding-handmatig.js.';

-- ── Controle (alleen lezen) — verwacht 3 ────────────────────────────────────
-- select count(*) from information_schema.columns
--  where table_schema = 'public' and table_name = 'onboardings'
--    and column_name in ('handmatig_afgerond_op', 'handmatig_afgerond_door', 'handmatig_afgerond_reden');
