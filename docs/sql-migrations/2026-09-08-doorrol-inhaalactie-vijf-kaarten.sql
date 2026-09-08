-- 2026-09-08 · Eenmalige inhaalactie: de vijf kaarten die 8 september oversloegen
--
-- ── WAAROM DIT APART MOET ───────────────────────────────────────────────────
-- De zelfhelende doorrol (PR #1507) is de regel 'open taak met een due VOOR
-- vandaag krijgt due vandaag'. Die voorkomt het probleem vanaf nu, maar hij
-- repareert deze vijf NIET: hun due staat op 2026-09-09, en dat ligt op de 8e
-- in de TOEKOMST, niet in het verleden.
--
--     '2026-09-09' < '2026-09-08'  →  false
--
-- Ze duiken dus morgen vanzelf op, en 8 september blijft de dag die ze hebben
-- overgeslagen. Die schade wordt alleen hiermee ongedaan gemaakt.
--
-- ── DE VINGERAFDRUK ─────────────────────────────────────────────────────────
-- Er staan op 9 september ook kaarten die daar TERECHT horen (door een mens
-- vooruitgezet, of een bevestigde aanmelding). Alles op die dag naar voren
-- halen zou die kapotmaken. Het onderscheid is de combinatie:
--
--     status = 'open'
--     due    = 2026-09-09
--     updated_at ligt in het venster van de kapotte doorrol van 07-09T23:59Z
--
-- Dat laatste is het beslissende deel: 23:59 UTC is 01:59 in Amsterdam, en daar
-- zit geen mens achter een scherm. Een kaart die een mens vooruit zette draagt
-- een heel ander tijdstip.
--
-- ── HIJ WEIGERT ALS HET AANTAL NIET KLOPT ───────────────────────────────────
-- Maxim telde vijf. Raakt de query er meer of minder, dan is de aanname over de
-- vingerafdruk verkeerd en mag er niets gebeuren. Het DO-blok hieronder breekt
-- dan af met een foutmelding en verandert NIETS — een halve reparatie is erger
-- dan geen.
--
-- ── VOLGORDE ────────────────────────────────────────────────────────────────
-- 1. Draai STAP 1 en lees de vijf namen. Kloppen ze met je eigen lijst?
-- 2. Draai dan pas STAP 2.
--
-- Beide stappen zijn losse statements: de Supabase SQL-editor knipt input op
-- statement-grenzen en draait elk statement in een eigen transactie (zie
-- CLAUDE.md). Daarom staat de pre/post-vergelijking in ÉÉN enkel DO-blok en
-- niet verspreid over meerdere.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 · KIJKEN. Verandert niets.
-- ══════════════════════════════════════════════════════════════════════════
-- Verwacht: 5 rijen — Achraf Deflaoui, Kris Sienaert, Said Hachemi,
-- Gevorg Khetchoumian, Werner De Kesel.

select
  id,
  naam,
  due,
  later,
  updated_at,
  count(*) over () as totaal_geraakt
from opvolging_taken
where status = 'open'
  and due = date '2026-09-09'
  and updated_at >= timestamptz '2026-09-07 23:55:00+00'
  and updated_at <  timestamptz '2026-09-08 00:10:00+00'
order by naam;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 · REPAREREN. Breekt af als het er geen 5 zijn.
-- ══════════════════════════════════════════════════════════════════════════
-- Pas draaien als stap 1 precies die vijf namen liet zien.

do $$
declare
  v_verwacht constant int := 5;
  v_aantal   int;
  v_namen    text;
begin
  select count(*), string_agg(naam, ', ' order by naam)
    into v_aantal, v_namen
  from opvolging_taken
  where status = 'open'
    and due = date '2026-09-09'
    and updated_at >= timestamptz '2026-09-07 23:55:00+00'
    and updated_at <  timestamptz '2026-09-08 00:10:00+00';

  if v_aantal <> v_verwacht then
    raise exception
      'AFGEBROKEN: % rijen passen op de vingerafdruk, verwacht %. Er is niets gewijzigd. Gevonden: %',
      v_aantal, v_verwacht, coalesce(v_namen, '(geen)');
  end if;

  update opvolging_taken
     set due        = date '2026-09-08',
         later      = false,
         updated_at = now()
  where status = 'open'
    and due = date '2026-09-09'
    and updated_at >= timestamptz '2026-09-07 23:55:00+00'
    and updated_at <  timestamptz '2026-09-08 00:10:00+00';

  get diagnostics v_aantal = row_count;
  raise notice 'OK: % kaarten naar 2026-09-08 gehaald: %', v_aantal, v_namen;
end $$;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 · CONTROLEREN. Verandert niets.
-- ══════════════════════════════════════════════════════════════════════════
-- Verwacht: dezelfde vijf namen, nu met due 2026-09-08.
-- En: geen enkele open kaart meer met de vingerafdruk van de kapotte doorrol.

select naam, due, later, updated_at
from opvolging_taken
where status = 'open'
  and due = date '2026-09-08'
order by naam;


-- ── NA DEZE ACTIE ──────────────────────────────────────────────────────────
-- Er is hierna geen tweede inhaalactie meer nodig. De doorrol van vannacht
-- draait met de zelfhelende regel, en de zevende gezondheidscontrole meldt de
-- volgende ochtend als hij alsnog op de verkeerde dag zou richten.
