-- PROJECT: crm (forex-command-center)
--
-- 2026-10-27-opvolging-automation-interesse.sql — automation-interesse uit de
-- onboarding-portal wordt een belkaart voor Dave
--
-- WAAROM
-- ------
-- Kiest een klant in de onboarding (www.deforexopleiding.nl/onboarding) "Ja, bel
-- mij" bij de automation-vraag, dan maakt api/_lib/automation-interesse.js meteen
-- één Opvolging-kaart (opvolging_taken) met reden 'automation_interesse'. Dave
-- belt en plant een gesprek in; die boeking krijgt booking_source 'automation'
-- (en daardoor de bestaande GHL-tag "bron-automation").
--
-- WAT ER GEBEURT (alles ADDITIEF):
--   1. 'automation_interesse' komt bij de CHECK opvolging_taken_reden_chk. De
--      huidige lijst wordt UIT DE DATABANK GELEZEN en volledig behouden — er
--      komt er alleen één bij. Idempotent: staat hij er al, dan gebeurt er niets.
--   2. Eén kaart per onboarding, door de databank bewaakt: een partiële unieke
--      index op (bron_ref->>'onboarding_id') voor reden 'automation_interesse'.
--   3. booking_sources krijgt de slug 'automation' (label "Automation
--      (onboarding)", zonder vragenlijst). Bestaat hij al, dan blijft hij.
--
-- De code draait ook zonder deze migratie (fail-soft): de save van de klant
-- slaagt, alleen ontstaat er dan nog geen kaart (de insert botst op de CHECK en
-- wordt gelogd).
--
-- Rollback (alleen als het echt moet en er geen automation-kaarten zijn):
--   drop index if exists public.opvolging_taken_automation_uniek;
--   -- en de CHECK terugzetten naar de lijst uit de controle VÓÓR hieronder.
--   delete from public.booking_sources where slug = 'automation';

-- ── Controle VÓÓR ─────────────────────────────────────────────────────────
-- Verwacht: de huidige lijst ZONDER automation_interesse.
select pg_get_constraintdef(oid) as reden_check from pg_constraint
 where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_reden_chk';
-- Verwacht: 0 rijen.
select slug from public.booking_sources where slug = 'automation';

-- ── 1. De CHECK uitbreiden (één DO-blok, leest de huidige waarden) ────────
do $$
declare
  def text;
  waarden text[];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_reden_chk';
  if def is null then
    raise exception 'opvolging_taken_reden_chk niet gevonden — niets gewijzigd';
  end if;
  if position('''automation_interesse''' in def) > 0 then
    raise notice 'automation_interesse staat al in de CHECK — niets te doen';
    return;
  end if;
  -- Alle 'waarde'::text uit de definitie, in volgorde.
  select array_agg(m[1] order by ord) into waarden
    from regexp_matches(def, '''([a-z0-9_]+)''', 'g') with ordinality as t(m, ord);
  if waarden is null or array_length(waarden, 1) < 1 then
    raise exception 'kon de huidige redenen niet lezen uit: % — niets gewijzigd', def;
  end if;
  waarden := waarden || 'automation_interesse'::text;
  execute 'alter table public.opvolging_taken drop constraint opvolging_taken_reden_chk, '
       || 'add constraint opvolging_taken_reden_chk check (reden = any ('
       || quote_literal(waarden::text) || '::text[]))';
  raise notice 'reden-CHECK nu: %', waarden;
end $$;

-- ── 2. Eén kaart per onboarding ───────────────────────────────────────────
create unique index if not exists opvolging_taken_automation_uniek
  on public.opvolging_taken ((bron_ref->>'onboarding_id'))
  where reden = 'automation_interesse';

-- ── 3. De boekingsbron ────────────────────────────────────────────────────
insert into public.booking_sources (slug, label, actief, vragenlijst)
values ('automation', 'Automation (onboarding)', true, false)
on conflict (slug) do nothing;

-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: dezelfde lijst als VÓÓR, met 'automation_interesse' achteraan.
select pg_get_constraintdef(oid) as reden_check from pg_constraint
 where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_reden_chk';
-- Verwacht: 1 rij.
select indexname from pg_indexes
 where tablename = 'opvolging_taken' and indexname = 'opvolging_taken_automation_uniek';
-- Verwacht: 1 rij, actief = true, vragenlijst = false.
select slug, label, actief, vragenlijst from public.booking_sources where slug = 'automation';
-- Verwacht: zelfde aantal als vóór (er wordt geen enkele taak aangeraakt).
select count(*) as taken_totaal from public.opvolging_taken;
