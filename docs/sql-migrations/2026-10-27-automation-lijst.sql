-- PROJECT: crm (forex-command-center)
--
-- 2026-10-27-automation-lijst.sql — de automation-kaarten krijgen een EIGEN
-- lijst ('automation') en een eigen recht (automation.view)
--
-- WAAROM
-- ------
-- De automation-interesse uit de onboarding hoort niet tussen Daves gewone
-- Opvolging-daglijst (Maxim, 27 okt 2026). Ze krijgt een eigen sectie
-- "Automation" in het CRM (modules/klanten-v2/views/automation-v2.js). Zelfde
-- patroon als lijst 'leads' (Leads bellen): de kaarten blijven gewone rijen in
-- opvolging_taken, zodat softphone, WhatsApp-brug, pogingen, agenda-boeking,
-- wacht-check en doorrol gewoon blijven werken; elk daglijst-scherm filtert al
-- op lijst = 'dag' (api/_lib/opvolging-lijst.js) en ziet ze dus niet meer.
--
-- WAT ER GEBEURT (alles ADDITIEF):
--   1. 'automation' komt bij de CHECK opvolging_taken_lijst_chk. De huidige
--      waarden worden UIT DE DATABANK GELEZEN en volledig behouden (gemeten:
--      'dag', 'leads'); er komt er alleen één bij. Idempotent.
--   2. Bestaande kaarten met reden 'automation_interesse' verhuizen van lijst
--      'dag' naar 'automation' (gemeten: 1 rij, gearchiveerd, test). Verder
--      verandert er niets aan die rijen.
--   3. Recht automation.view voor admin, manager en sales (super_admin altijd,
--      eigen OR-tak in user_has_permission). Bestaat de rij al, dan blijft hij.
--
-- De code draait ook zonder deze migratie (fail-soft): een nieuwe kaart botst
-- dan op de CHECK en wordt alsnog in lijst 'dag' gemaakt (zoals vandaag), en de
-- sectie Automation leest beide lijsten. Alleen het recht ontbreekt dan voor
-- admin/manager/sales (super_admin ziet de sectie wel).
--
-- Rollback (alleen als het echt moet):
--   update public.opvolging_taken set lijst = 'dag' where lijst = 'automation';
--   -- en de CHECK terugzetten naar de lijst uit de controle VÓÓR hieronder.
--   delete from public.role_permissions where feature_key = 'automation.view';

-- ── Controle VÓÓR ─────────────────────────────────────────────────────────
-- Verwacht: CHECK ((lijst = ANY (ARRAY['dag'::text, 'leads'::text])))
select pg_get_constraintdef(oid) as lijst_check from pg_constraint
 where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_lijst_chk';
-- Verwacht: 1 rij in lijst 'dag'.
select lijst, status, count(*) from public.opvolging_taken
 where reden = 'automation_interesse' group by 1, 2;

-- ── 1. De CHECK uitbreiden (één DO-blok, leest de huidige waarden) ────────
do $$
declare
  def text;
  waarden text[];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_lijst_chk';
  if def is null then
    raise exception 'opvolging_taken_lijst_chk niet gevonden — niets gewijzigd';
  end if;
  if position('''automation''' in def) > 0 then
    raise notice 'automation staat al in de CHECK — niets te doen';
    return;
  end if;
  select array_agg(m[1] order by ord) into waarden
    from regexp_matches(def, '''([a-z0-9_]+)''', 'g') with ordinality as t(m, ord);
  if waarden is null or array_length(waarden, 1) < 1 then
    raise exception 'kon de huidige lijsten niet lezen uit: % — niets gewijzigd', def;
  end if;
  waarden := waarden || 'automation'::text;
  execute 'alter table public.opvolging_taken drop constraint opvolging_taken_lijst_chk, '
       || 'add constraint opvolging_taken_lijst_chk check (lijst = any ('
       || quote_literal(waarden::text) || '::text[]))';
  raise notice 'lijst-CHECK nu: %', waarden;
end $$;

-- ── 2. Bestaande automation-kaarten verhuizen ─────────────────────────────
update public.opvolging_taken
   set lijst = 'automation'
 where reden = 'automation_interesse' and lijst = 'dag';

-- ── 3. Recht automation.view ──────────────────────────────────────────────
insert into public.role_permissions (role, feature_key, allowed)
select 'admin', 'automation.view', true
where not exists (select 1 from public.role_permissions where role = 'admin' and feature_key = 'automation.view');

insert into public.role_permissions (role, feature_key, allowed)
select 'manager', 'automation.view', true
where not exists (select 1 from public.role_permissions where role = 'manager' and feature_key = 'automation.view');

insert into public.role_permissions (role, feature_key, allowed)
select 'sales', 'automation.view', true
where not exists (select 1 from public.role_permissions where role = 'sales' and feature_key = 'automation.view');

-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: dezelfde lijst als VÓÓR, met 'automation' achteraan.
select pg_get_constraintdef(oid) as lijst_check from pg_constraint
 where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_lijst_chk';
-- Verwacht: alle automation-kaarten in lijst 'automation', geen in 'dag'.
select lijst, status, count(*) from public.opvolging_taken
 where reden = 'automation_interesse' group by 1, 2;
-- Verwacht: admin, manager, sales.
select role, allowed from public.role_permissions where feature_key = 'automation.view' order by role;
