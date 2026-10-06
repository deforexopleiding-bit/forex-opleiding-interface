-- 2026-10-06 · Onboarding naar incasso-opvolging (forex-command-center).
--
-- Vijf nieuwe, lege kolommen op `onboardings`: wanneer, door wie en waarom een
-- onboarding naar incasso-opvolging ging, en wanneer/door wie hij terug actief
-- werd. NIET annuleren: status, facturen, abonnementen, toegang en aanmaningen
-- blijven zoals ze zijn. Zie api/_lib/onboarding-incasso.js.
--
-- Additief en herhaalbaar: alleen `add column if not exists`.
--
-- NIET BLOKKEREND: de code leest deze kolommen in een aparte, faalzachte
-- query. Zonder migratie staat niemand in incasso en geven de knoppen
-- "Naar incasso-opvolging" / "Terug activeren" een duidelijke 503.
--
-- Elk statement staat los (Supabase SQL-editor).

alter table public.onboardings add column if not exists incasso_op timestamptz;
alter table public.onboardings add column if not exists incasso_door text;
alter table public.onboardings add column if not exists incasso_reden text;
alter table public.onboardings add column if not exists incasso_terug_op timestamptz;
alter table public.onboardings add column if not exists incasso_terug_door text;

comment on column public.onboardings.incasso_op is
  'Naar incasso-opvolging (niet geannuleerd). In incasso = incasso_op gezet en incasso_terug_op leeg of ouder. Zie api/_lib/onboarding-incasso.js.';

-- ── Controle (alleen lezen) — verwacht 5 ────────────────────────────────────
-- select count(*) from information_schema.columns
--  where table_schema = 'public' and table_name = 'onboardings'
--    and column_name like 'incasso_%';
