-- 2026-09-08 · eerst_gepland_op: de oorspronkelijke dag van een afspraak bewaren
--
-- ── WAAROM ──────────────────────────────────────────────────────────────────
-- Een dag moet achteraf te reconstrueren zijn. Verdwijnt een zoomcall uit een
-- dag zodra iemand hem verzet, dan klopt het dagbeeld van gisteren morgen niet
-- meer, en dan is het rapport over die dag ook niet meer waar.
--
-- Voor het gewone verzetten kan dat al: api/follow-up-verplaats-call.js zet de
-- oude rij op 'verplaatst' en maakt een nieuwe met parent_appointment_id, dus
-- de oude dag staat er nog.
--
-- Maar er is een tweede soort. De GHL-poll (api/follow-up-ghl-appointment-poll.js)
-- schrijft elke vijf minuten een VOLLEDIGE rij weg met wat GHL zegt, inclusief
-- scheduled_at. Verplaatst iemand de afspraak in GHL, dan verhuist onze rij
-- zelf naar de nieuwe dag — geen opvolger, geen melding, geen spoor. Sander De
-- Groot ging zo van 7 naar 15 september. De oorspronkelijke dag is dan
-- overschreven en met geen enkele query terug te halen.
--
-- Deze kolom bewaart die dag. Eén keer gezet, daarna onveranderlijk.
--
-- ── WAAROM EEN TRIGGER EN NIET 'DE CODE SCHRIJFT HEM GEWOON NIET' ──────────
-- Omdat de poll een volledige rij wegschrijft. Elke schrijver die ooit een
-- kolomlijst vergeet bij te werken, of een `select *` doorlust naar een
-- update, zou de waarde meenemen. Dan is de kolom precies op het moment dat je
-- hem nodig hebt stilletjes meeverhuisd, en dat merk je pas als het dagbeeld
-- alweer weg is.
--
-- Met de trigger hieronder is dat onmogelijk, ongeacht wat de code doet:
--   · bij INSERT wordt hij gevuld uit scheduled_at als hij leeg is;
--   · bij UPDATE wordt de oude waarde altijd teruggezet.
-- De applicatiecode hoeft de kolom dus alleen te LEZEN.
--
-- ── NIET BLOKKEREND ─────────────────────────────────────────────────────────
-- De code leest de kolom met een terugval op 42703 (kolom bestaat niet) en valt
-- dan terug op scheduled_at. Draai je deze migratie vóór of ná de deploy: in
-- allebei de volgordes blijft het scherm werken. Zolang de kolom er niet is
-- meldt de dagweergave dat verzette afspraken van vóór vandaag kunnen ontbreken.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 · De kolom
-- ══════════════════════════════════════════════════════════════════════════
-- Nullable: bestaande rijen krijgen hem in stap 2, en een rij zonder waarde
-- moet leesbaar blijven in plaats van de insert te weigeren.

alter table follow_up_appointments
  add column if not exists eerst_gepland_op timestamptz;

comment on column follow_up_appointments.eerst_gepland_op is
  'De dag/tijd waarop deze afspraak OORSPRONKELIJK stond. Eenmalig gezet bij insert, daarna onveranderlijk via trigger trg_eerst_gepland_op_immutable. Zie docs/opvolging-module.md.';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 · Backfill
-- ══════════════════════════════════════════════════════════════════════════
-- LET OP WAT DIT WEL EN NIET DOET. Voor rijen die nooit verzet zijn is dit
-- exact goed. Voor rijen die in DEZELFDE rij al verzet zijn — Sander De Groot —
-- is de oorspronkelijke dag al weg, en zet dit de huidige dag neer. Dat is het
-- beste wat er nog is, en het is eerlijk: het zegt 'voor zover wij weten stond
-- hij hier'. Wat vóór vandaag verzet is komt niet meer terug.
--
-- Vanaf nu wordt het wél goed bewaard, en dat is waar deze migratie voor is.

update follow_up_appointments
   set eerst_gepland_op = scheduled_at
 where eerst_gepland_op is null
   and scheduled_at is not null;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 · Onveranderlijk maken
-- ══════════════════════════════════════════════════════════════════════════

create or replace function eerst_gepland_op_vasthouden()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT') then
    -- Leeg bij aanmaken: vullen uit scheduled_at. Zo hoeft geen enkele
    -- schrijver in de code hieraan te denken.
    if new.eerst_gepland_op is null then
      new.eerst_gepland_op := new.scheduled_at;
    end if;
  else
    -- Bij elke update de oude waarde terugzetten. Ook als de schrijver hem
    -- expliciet meestuurt; juist dan.
    new.eerst_gepland_op := coalesce(old.eerst_gepland_op, new.scheduled_at);
  end if;
  return new;
end $$;

drop trigger if exists trg_eerst_gepland_op_immutable on follow_up_appointments;
create trigger trg_eerst_gepland_op_immutable
  before insert or update on follow_up_appointments
  for each row execute function eerst_gepland_op_vasthouden();


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 4 · Index
-- ══════════════════════════════════════════════════════════════════════════
-- De dagweergave zoekt op scheduled_at OF eerst_gepland_op binnen een venster.

create index if not exists idx_follow_up_appointments_eerst_gepland_op
  on follow_up_appointments (eerst_gepland_op);


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 5 · Controleren. Verandert niets.
-- ══════════════════════════════════════════════════════════════════════════
-- Verwacht: geen enkele rij met een lege eerst_gepland_op, en de rijen die al
-- in dezelfde rij verzet zijn vallen op doordat de twee dagen verschillen.

select count(*) filter (where eerst_gepland_op is null)                        as zonder_waarde,
       count(*) filter (where date(eerst_gepland_op) <> date(scheduled_at))    as verzet_in_dezelfde_rij,
       count(*)                                                                as totaal
from follow_up_appointments;

-- En een test dat de trigger echt vasthoudt (verandert niets blijvends):
--   begin;
--     update follow_up_appointments
--        set eerst_gepland_op = now(), scheduled_at = now()
--      where id = (select id from follow_up_appointments limit 1);
--     select id, eerst_gepland_op, scheduled_at
--       from follow_up_appointments
--      where id = (select id from follow_up_appointments limit 1);
--   rollback;
-- eerst_gepland_op hoort ONVERANDERD te zijn, scheduled_at wel verzet.
