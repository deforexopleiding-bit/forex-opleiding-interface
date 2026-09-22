-- 2026-09-22 · call_log.outcome_hint: 'afgebroken_voor_opnemen' toestaan
--
-- ── WAAROM ──────────────────────────────────────────────────────────────────
-- 'no_answer' is een uitspraak over de LEAD: hij nam niet op. Hing DAVE op
-- voordat er werd opgenomen, dan is dat een uitspraak over ons — en zulke
-- rijen telden mee in de pogingenteller, in het dagdoel van twee en in de
-- archiveerregel. De softphone weet uit de SIP-staat welk van de twee het was
-- en stuurt dat sinds vandaag mee.
--
-- GEEN DREMPEL OP DUUR. De verleiding is 'korter dan drie seconden is een
-- misgreep'. Bij drie van de negen korte calls in de historie volgt binnen
-- minuten een ECHT gesprek (Anais op 6 september: 3 seconden, daarna 26
-- seconden gesproken). Een grens op seconden zou juist het herbelgedrag
-- afpakken dat werkt. Het onderscheid komt uit de SIP-staat, niet uit een
-- getal achteraf.
--
-- ── NIET BLOKKEREND ─────────────────────────────────────────────────────────
-- api/softphone-call-log.js vangt 23514 op deze ene waarde af en logt de call
-- dan als 'local_cancel' met de echte waarde in meta.werkelijke_outcome. De
-- BELPOGING in de opvolgmodule krijgt hoe dan ook de echte waarde, dus de
-- telling klopt met én zonder deze migratie. Wat je zonder migratie mist is
-- alleen het onderscheid in call_log zelf.
--
-- ── EERST KIJKEN ────────────────────────────────────────────────────────────
-- Misschien staat er helemaal geen CHECK op deze kolom. Dan is deze migratie
-- overbodig en hoef je niets te doen. Stap 1 zegt welk van de twee het is.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 · STAAT ER EEN CHECK, EN WAT LAAT HIJ TOE? (verandert niets)
-- ══════════════════════════════════════════════════════════════════════════
-- Geen rijen terug  → er is geen CHECK op outcome_hint. KLAAR, sla stap 2 over.
-- Wel een rij       → lees de definitie; staat 'afgebroken_voor_opnemen' er al
--                     in, dan ben je ook klaar.

select c.conname,
       pg_get_constraintdef(c.oid) as definitie
from   pg_constraint c
join   pg_class t on t.oid = c.conrelid
join   pg_namespace n on n.oid = t.relnamespace
where  n.nspname = 'public'
  and  t.relname = 'call_log'
  and  c.contype = 'c'
  and  pg_get_constraintdef(c.oid) ilike '%outcome_hint%';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 · DE WAARDE TOEVOEGEN
-- ══════════════════════════════════════════════════════════════════════════
-- Alleen draaien als stap 1 een CHECK liet zien die de waarde nog niet kent.
-- Eén DO-block: de Supabase-editor knipt input op statement-grenzen, dus alles
-- wat state uit een eerdere stap nodig heeft moet in één block staan.
--
-- De constraintnaam is auto-gegenereerd en dus niet vooraf bekend; daarom
-- wordt hij opgezocht in plaats van geraden. De nieuwe CHECK houdt ALLE
-- bestaande waarden, zodat geen enkele bestaande rij ongeldig wordt.

do $$
declare
  naam text;
begin
  select c.conname into naam
  from   pg_constraint c
  join   pg_class t on t.oid = c.conrelid
  join   pg_namespace n on n.oid = t.relnamespace
  where  n.nspname = 'public'
    and  t.relname = 'call_log'
    and  c.contype = 'c'
    and  pg_get_constraintdef(c.oid) ilike '%outcome_hint%'
  limit  1;

  if naam is null then
    raise notice 'Geen CHECK op call_log.outcome_hint — niets te doen.';
    return;
  end if;

  execute format('alter table public.call_log drop constraint %I', naam);
  alter table public.call_log
    add constraint call_log_outcome_hint_check
    check (outcome_hint in (
      'answered', 'no_answer', 'busy', 'failed', 'local_cancel',
      'afgebroken_voor_opnemen'
    ));
  raise notice 'CHECK % vervangen; afgebroken_voor_opnemen is nu toegestaan.', naam;
end $$;

comment on column public.call_log.outcome_hint is
  'Wat er feitelijk gebeurde. afgebroken_voor_opnemen = wij hingen op voordat er werd opgenomen; dat is iets anders dan no_answer (de lead nam niet op) en telt niet als belpoging.';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 · CONTROLE
-- ══════════════════════════════════════════════════════════════════════════
-- Hoort de nieuwe waarde in de definitie te tonen.

select pg_get_constraintdef(c.oid) as definitie
from   pg_constraint c
join   pg_class t on t.oid = c.conrelid
where  t.relname = 'call_log' and c.contype = 'c'
  and  pg_get_constraintdef(c.oid) ilike '%outcome_hint%';


-- ══════════════════════════════════════════════════════════════════════════
-- DE RIJEN VAN VÓÓR DE MIGRATIE TERUGVINDEN (optioneel)
-- ══════════════════════════════════════════════════════════════════════════
-- Calls die als local_cancel zijn gelogd omdat de CHECK de echte waarde nog
-- weigerde. Ze hoeven niet bijgewerkt te worden — de belpoging klopte al —
-- maar zo zijn ze wel te vinden.
--
-- select id, started_at, to_number, meta->>'werkelijke_outcome' as echt
-- from   public.call_log
-- where  meta->>'werkelijke_outcome' = 'afgebroken_voor_opnemen'
-- order  by started_at desc;
