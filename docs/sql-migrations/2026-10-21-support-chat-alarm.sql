-- 2026-10-21 — Support-chat mag nooit gemist worden (mail + rinkelende melding)
--
-- ALLEEN ADDITIEF. Geen bestaande rij of kolom wordt gewijzigd.
--
--   1. support_gesprekken.team_gemaild_op — wanneer het team voor het laatst
--      een mail kreeg over dit gesprek (nieuw gesprek, of de klant schrijft
--      opnieuw na >30 min stilte van onze kant). Nullable; bestaande rijen
--      blijven NULL. De code claimt hiermee de mail (voorwaardelijke update),
--      zodat twee gelijktijdige verzoeken niet dubbel mailen.
--      BLOKKEREND: api/_lib/support-alarm.js schrijft de kolom bij naam.
--
--   2. support_gesprekken in de publicatie supabase_realtime, zodat "Ik neem
--      het" het rinkelen bij iedereen meteen stopt. RLS blijft gelden: alleen
--      CRM-staff (is_crm_staff()) krijgt de wijzigingen, net als nu bij lezen.
--
-- Uitgevoerd op 2026-10-21 via de Supabase-MCP, met controle voor en na.

-- ── Controle VOOR ─────────────────────────────────────────────────────────
select
  (select count(*) from public.support_gesprekken) as rijen,
  (select md5(string_agg(id::text || status || coalesce(toegewezen_aan::text, '')
     || coalesce(laatste_bericht_op::text, '') || updated_at::text, ',' order by id))
   from public.support_gesprekken) as vingerafdruk,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'support_gesprekken'
            and column_name = 'team_gemaild_op') as kolom_bestaat,
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'public'
            and tablename = 'support_gesprekken') as in_realtime;
-- Gemeten: rijen 26, vingerafdruk 282cb3c131f35c2a148d8b13a4570e5d,
--          kolom_bestaat false, in_realtime false.

-- ── Wijziging ─────────────────────────────────────────────────────────────
alter table public.support_gesprekken
  add column if not exists team_gemaild_op timestamptz;

comment on column public.support_gesprekken.team_gemaild_op is
  'Laatste teammail over dit gesprek (nieuw / klant schrijft opnieuw na stilte). Zie api/_lib/support-alarm.js.';

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'support_gesprekken') then
    alter publication supabase_realtime add table public.support_gesprekken;
  end if;
end $$;

-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: zelfde rijen + vingerafdruk, kolom_bestaat true, in_realtime true,
-- en 0 rijen met team_gemaild_op gevuld.
select
  (select count(*) from public.support_gesprekken) as rijen,
  (select md5(string_agg(id::text || status || coalesce(toegewezen_aan::text, '')
     || coalesce(laatste_bericht_op::text, '') || updated_at::text, ',' order by id))
   from public.support_gesprekken) as vingerafdruk,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'support_gesprekken'
            and column_name = 'team_gemaild_op') as kolom_bestaat,
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'public'
            and tablename = 'support_gesprekken') as in_realtime,
  (select count(*) from public.support_gesprekken where team_gemaild_op is not null) as gevuld;
-- Gemeten na uitvoeren: rijen 26, vingerafdruk 282cb3c131f35c2a148d8b13a4570e5d
--   (ongewijzigd), kolom_bestaat true, in_realtime true, gevuld 0.
