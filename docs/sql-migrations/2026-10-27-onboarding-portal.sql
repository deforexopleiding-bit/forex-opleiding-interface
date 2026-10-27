-- PROJECT: crm (forex-command-center)
--
-- 2026-10-27-onboarding-portal.sql — nieuwe klant-onboarding op
-- www.deforexopleiding.nl/onboarding (startcode + automation-interesse)
--
-- WAAROM
-- ------
-- De klant opent zijn onboarding op de website met een STARTCODE uit de
-- welkomstmail (8 tekens, getoond als XXXX-XXXX). De portal-API
-- (api/onboarding-portal.js) zoekt de onboarding op die code. Daarnaast houdt
-- de onboarding bij of de klant interesse heeft in de automation, zodat Dave
-- kan bellen.
--
-- WAT ER GEBEURT (alles ADDITIEF — niets gedropt, niets overschreven):
--   1. onboardings.startcode text (nullable) + partiële UNIEKE index.
--   2. onboardings.automation_interesse text, automation_interesse_op
--      timestamptz, automation_belmoment text[] (allemaal nullable).
--   3. Backfill: elke onboarding met status aangemeld/bezig zónder startcode
--      krijgt er één. Idempotent: een tweede run vindt niets meer.
--   4. app_settings 'onboarding_portal_live' = false (alleen als hij nog niet
--      bestaat). Zolang die uit staat wijzen alle links nog naar de oude wizard.
--
-- De code draait ook zonder deze migratie (fail-soft): zonder kolom krijgt een
-- nieuwe onboarding gewoon geen startcode en zegt de portal "code onbekend".
--
-- Alfabet: ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (32 tekens, geen 0/O/1/I) —
-- identiek aan api/_lib/onboarding-startcode.js. Opslag ZONDER streepje.
--
-- Rollback (alleen als het echt moet):
--   drop index if exists public.onboardings_startcode_uniek;
--   alter table public.onboardings drop column if exists startcode,
--     drop column if exists automation_interesse,
--     drop column if exists automation_interesse_op,
--     drop column if exists automation_belmoment;
--   delete from public.app_settings where key = 'onboarding_portal_live';

-- ── Controle VÓÓR ─────────────────────────────────────────────────────────
-- Verwacht: 0 rijen (kolommen bestaan nog niet).
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'onboardings'
   and column_name in ('startcode', 'automation_interesse', 'automation_interesse_op', 'automation_belmoment');

-- ── 1 + 2. Kolommen ───────────────────────────────────────────────────────
alter table public.onboardings
  add column if not exists startcode text,
  add column if not exists automation_interesse text,
  add column if not exists automation_interesse_op timestamptz,
  add column if not exists automation_belmoment text[];

create unique index if not exists onboardings_startcode_uniek
  on public.onboardings (startcode)
  where startcode is not null;

-- ── 3. Backfill (één DO-blok, idempotent) ─────────────────────────────────
-- Willekeur uit gen_random_uuid() (core, geen pgcrypto nodig): bytes 0..5 en
-- 10..11 van de uuid zijn volledig willekeurig (byte 6 en 8 dragen de
-- versie-/variant-bits en worden overgeslagen). 256 % 32 = 0, dus `byte % 32`
-- is zuiver uniform over het alfabet.
do $$
declare
  alfabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  posities constant int[] := array[0, 1, 2, 3, 4, 5, 10, 11];
  r record;
  b bytea;
  code text;
  poging int;
  i int;
  gezet int := 0;
begin
  for r in
    select id from public.onboardings
     where startcode is null and status in ('aangemeld', 'bezig')
  loop
    poging := 0;
    loop
      poging := poging + 1;
      b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      code := '';
      foreach i in array posities loop
        code := code || substr(alfabet, (get_byte(b, i) % 32) + 1, 1);
      end loop;
      begin
        update public.onboardings set startcode = code
         where id = r.id and startcode is null;
        gezet := gezet + 1;
        exit;
      exception when unique_violation then
        if poging >= 5 then
          raise warning 'startcode voor % na 5 pogingen niet gezet', r.id;
          exit;
        end if;
      end;
    end loop;
  end loop;
  raise notice 'startcode gezet op % onboarding(s)', gezet;
end $$;

-- ── 4. Vlag (default UIT) ─────────────────────────────────────────────────
insert into public.app_settings (key, value)
values ('onboarding_portal_live', 'false'::jsonb)
on conflict (key) do nothing;

-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: 4 kolommen.
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'onboardings'
   and column_name in ('startcode', 'automation_interesse', 'automation_interesse_op', 'automation_belmoment');
-- Verwacht: 0 (elke aangemeld/bezig heeft een code).
select count(*) as zonder_code from public.onboardings
 where startcode is null and status in ('aangemeld', 'bezig');
-- Verwacht: 0 (geen dubbele codes, geen codes buiten het alfabet).
select count(*) as fout from public.onboardings
 where startcode is not null and startcode !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$';
-- Verwacht: false.
select value from public.app_settings where key = 'onboarding_portal_live';
