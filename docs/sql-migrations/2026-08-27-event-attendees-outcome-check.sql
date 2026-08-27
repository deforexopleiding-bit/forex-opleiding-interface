-- ============================================================================
--  event_attendees.outcome — twee uitkomsten toestaan die de code al stuurt
-- ============================================================================
--  Draai deze SQL in de Supabase SQL-editor. Er wordt niets verwijderd, geen
--  rij aangeraakt, geen bestaande uitkomst ongeldig gemaakt. Alleen de
--  CHECK-constraint krijgt twee waarden erbij.
--
--  WAAROM
--  ------
--  De constraint staat vandaag alleen 'opvolgen', 'geen_interesse' en
--  'nog_onbekend' toe. Het afrondscherm biedt daarnaast 'Klant geworden' en
--  'Twijfelt nog' aan, en api/_lib/events-complete-core.js laat die twee door.
--  Ze komen dus tot aan de database en worden daar geweigerd.
--
--  Gemeten op 27-08-2026: 'klant_geworden' en 'twijfelt_nog' komen NUL keer
--  voor in de tabel. Dat is geen toeval — ze kunnen er niet in. Wie in het
--  afrondscherm een van die twee kiest, krijgt een databankfout.
--
--  TWIJFELT_NOG BLIJFT TOEGESTAAN, ook al verdwijnt de knop ervoor uit het
--  scherm ("Opvolgen" en "Twijfelt nog" worden één knop: Wil nog beslissen).
--  Dat is bewust. Tussen het draaien van deze migratie en het uitrollen van
--  de nieuwe code zit tijd, en die volgorde ligt niet vast. Zou de waarde hier
--  ontbreken, dan breekt het afronden in dat gat. Toestaan wat niemand meer
--  stuurt kost niets; verbieden wat nog gestuurd kan worden kost een avond.
--
--  NULL BLIJFT TOEGESTAAN. 141 bestaande rijen hebben geen uitkomst. In de
--  huidige regel mag dat alleen impliciet: een CHECK die NULL oplevert wordt
--  door Postgres niet als overtreding gezien. Hieronder staat het EXPLICIET
--  (`outcome is null or ...`). Dat verandert het gedrag niet, maar het maakt
--  zichtbaar dat het zo bedoeld is in plaats van dat het toevallig uitkomt.
--
--  ⚠️ CHECK-constraints worden VERVANGEN, niet uitgebreid — Postgres kent geen
--  "voeg een waarde toe". Controleer daarom eerst stap 0 en vergelijk of de
--  huidige constraint echt alleen die drie waarden toestaat. Staat er iets
--  anders in, STOP dan en pas de lijst hieronder aan in plaats van hem blind
--  te overschrijven.
-- ============================================================================


-- ── Stap 0 — kijk eerst wat er NU staat (lezen, verandert niets) ────────────
-- Verwacht: CHECK ((outcome = ANY (ARRAY['opvolgen', 'geen_interesse', 'nog_onbekend'])))
-- BEWAAR DEZE UITVOER. Het is je rollback.
select
  con.conname                    as constraint_naam,
  pg_get_constraintdef(con.oid)  as huidige_definitie
from pg_constraint con
join pg_class      cls on cls.oid = con.conrelid
join pg_namespace  nsp on nsp.oid = cls.relnamespace
where nsp.nspname = 'public'
  and cls.relname = 'event_attendees'
  and con.contype = 'c'
  and pg_get_constraintdef(con.oid) ilike '%outcome%';

-- Welke uitkomsten staan er ECHT in de tabel? Elke waarde die hier verschijnt
-- moet hieronder in de lijst blijven staan, anders faalt de constraint op
-- bestaande data. Verwacht (meting 27-08-2026):
--   opvolgen 4 · geen_interesse 3 · nog_onbekend 1 · (leeg) 141
select coalesce(outcome, '(leeg)') as uitkomst, count(*) as aantal
from public.event_attendees
group by 1
order by 2 desc;


-- ── Stap 1 — de constraint vervangen ────────────────────────────────────────
-- Drie bestaande waarden ONGEWIJZIGD, met 'klant_geworden' en 'twijfelt_nog'
-- erbij, en NULL expliciet toegestaan.
alter table public.event_attendees
  drop constraint if exists event_attendees_outcome_check;

alter table public.event_attendees
  add constraint event_attendees_outcome_check
  check (
    outcome is null
    or outcome in ('opvolgen', 'geen_interesse', 'nog_onbekend', 'klant_geworden', 'twijfelt_nog')
  );


-- ── Stap 2 — controle ───────────────────────────────────────────────────────
-- Verwacht nu: CHECK ((outcome IS NULL) OR (outcome = ANY (ARRAY[..., 'twijfelt_nog'])))
select pg_get_constraintdef(con.oid) as nieuwe_definitie
from pg_constraint con
join pg_class      cls on cls.oid = con.conrelid
join pg_namespace  nsp on nsp.oid = cls.relnamespace
where nsp.nspname = 'public'
  and cls.relname = 'event_attendees'
  and con.conname = 'event_attendees_outcome_check';

-- En een echte proef: dit hoort te LUKKEN en daarna niets veranderd te hebben.
-- (rollback aan het eind draait de test-update terug)
begin;
  update public.event_attendees
     set outcome = 'klant_geworden'
   where id = (select id from public.event_attendees order by created_at limit 1);
rollback;


-- ============================================================================
--  ROLLBACK
-- ============================================================================
--  Zet eerst elke rij met een van de twee nieuwe waarden terug (anders faalt
--  de oude constraint):
--
--    update public.event_attendees
--       set outcome = null
--     where outcome in ('klant_geworden', 'twijfelt_nog');
--
--    alter table public.event_attendees
--      drop constraint if exists event_attendees_outcome_check;
--    alter table public.event_attendees
--      add constraint event_attendees_outcome_check
--      check (outcome in ('opvolgen', 'geen_interesse', 'nog_onbekend'));
--
--  Let op: gebruik hier de definitie die je in stap 0 hebt bewaard, niet deze
--  regel, als die twee van elkaar verschillen.
-- ============================================================================
