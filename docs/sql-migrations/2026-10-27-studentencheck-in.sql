-- PROJECT: crm (forex-command-center)
--
-- 2026-10-27-studentencheck-in.sql — "Jouw DFO-check-in" voor bestaande studenten
--
-- De check-in zelf (campagnes, toewijzingen, antwoorden, signalen) staat in het
-- LMS-project dfo-lms (dfo-lms-prototype supabase/hlms_checkin.sql). In het CRM
-- komt alleen:
--
--   1. Eén automation-kaart per check-in-toewijzing, door de databank bewaakt:
--      een partiële unieke index op (bron_ref->>'checkin_toewijzing_id') voor
--      reden 'automation_interesse'. Botst niet met de onboarding-index
--      (opvolging_taken_automation_uniek): een check-in-kaart heeft geen
--      onboarding_id (NULL botst nooit in een unieke index).
--   2. De rechten voor de sectie "Studentencheck-in":
--        checkin.view — admin, manager (super_admin mag altijd alles) én de
--                       hoofdmentor-profielen: wie het recht
--                       signals.hoofdmentor.receive heeft (user_permissions;
--                       een rol 'hoofdmentor' bestaat in het CRM niet).
--        checkin.run  — admin (en super_admin). Run, Pauzeren, Hervatten,
--                       Testtoewijzingen en de opties.
--
-- Alles ADDITIEF en herhaalbaar. Er wordt geen enkele bestaande rij gewijzigd.
-- Er gaat NIETS naar studenten.
--
-- Zonder deze migratie: de check-in werkt, maar (1) twee gelijktijdige saves
-- kunnen in een zeldzaam geval twee kaarten maken, en (2) de sectie is alleen
-- voor super_admin zichtbaar.
--
-- Rollback:
--   drop index if exists public.opvolging_taken_automation_checkin_uniek;
--   delete from public.role_permissions where feature_key in ('checkin.view', 'checkin.run');
--   delete from public.user_permissions where feature_key = 'checkin.view';

-- ── Controle VÓÓR ─────────────────────────────────────────────────────────
-- Verwacht: 0, 0, 0, 3 (de profielen met signals.hoofdmentor.receive).
select
  (select count(*) from pg_indexes where tablename = 'opvolging_taken'
      and indexname = 'opvolging_taken_automation_checkin_uniek')                 as index_bestaat,
  (select count(*) from public.role_permissions where feature_key like 'checkin.%') as rol_rechten,
  (select count(*) from public.user_permissions where feature_key = 'checkin.view') as persoon_rechten,
  (select count(*) from public.user_permissions
     where feature_key = 'signals.hoofdmentor.receive' and allowed)                 as hoofdmentoren;

-- ── 1. Eén kaart per check-in-toewijzing ──────────────────────────────────
create unique index if not exists opvolging_taken_automation_checkin_uniek
  on public.opvolging_taken ((bron_ref->>'checkin_toewijzing_id'))
  where reden = 'automation_interesse' and (bron_ref ? 'checkin_toewijzing_id');

-- ── 2. Rechten ────────────────────────────────────────────────────────────
insert into public.role_permissions (role, feature_key, allowed)
select v.role, v.feature_key, true
  from (values ('admin', 'checkin.view'), ('manager', 'checkin.view'), ('admin', 'checkin.run'))
       as v(role, feature_key)
 where not exists (select 1 from public.role_permissions rp
                    where rp.role = v.role and rp.feature_key = v.feature_key);

insert into public.user_permissions (user_id, feature_key, allowed)
select up.user_id, 'checkin.view', true
  from public.user_permissions up
 where up.feature_key = 'signals.hoofdmentor.receive' and up.allowed
on conflict (user_id, feature_key) do nothing;

-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: 1, 3, 3 (of het aantal hoofdmentoren uit de controle vóór).
select
  (select count(*) from pg_indexes where tablename = 'opvolging_taken'
      and indexname = 'opvolging_taken_automation_checkin_uniek')                 as index_bestaat,
  (select count(*) from public.role_permissions where feature_key like 'checkin.%') as rol_rechten,
  (select count(*) from public.user_permissions where feature_key = 'checkin.view') as persoon_rechten;
-- Verwacht: zelfde aantal als vóór (er wordt geen taak aangeraakt).
select count(*) as taken_totaal from public.opvolging_taken;
