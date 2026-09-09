-- 2026-09-09 · is_test op follow_up_appointments: proefrijen uit het dagbeeld
--
-- ── WAAROM ──────────────────────────────────────────────────────────────────
-- Op 8 september staan drie proefafspraken tussen de echte calls. Ze zijn met
-- de hand aangemaakt om het scherm te testen en horen niet in Daves dagbeeld:
--
--   10:30  jeffrey-test
--   14:00  jef testo
--   20:30  jef testo
--
-- Sinds het dagbeeld ALLE afspraken van een dag toont (en niet alleen de
-- openstaande) staan ze er zichtbaar tussen. `opvolging_taken` heeft hier al
-- een `is_test` voor; `follow_up_appointments` nog niet.
--
-- ── WAAROM EEN KOLOM EN GEEN NAAMFILTER IN DE CODE ─────────────────────────
-- Filteren op 'test' in lead_name zou de eerste echte klant die Tessa of
-- Testerink heet uit de dag laten verdwijnen, en dat merkt niemand tot de call
-- gemist is. Een naampatroon is een gok die zich voordoet als een regel. Deze
-- kolom is expliciet gezet, na te kijken met een SELECT, en per rij terug te
-- draaien.
--
-- ── WAAROM ALLEEN HET DAGBEELD FILTERT ──────────────────────────────────────
-- api/_lib/opvolging-agenda-merge.js laat rijen met is_test = true weg. Het
-- dagrapport blijft ongemoeid: dat pad is op 9 september teruggedraaid nadat
-- het stukging, en gaat pas weer open als het apart bewezen is.
--
-- ── NIET BLOKKEREND ─────────────────────────────────────────────────────────
-- De code leest de kolom met een terugval op 42703. Zolang de kolom er niet is
-- werkt het dagbeeld gewoon, staan de proefrijen er nog tussen, en meldt het
-- scherm dát ze er tussen staan in plaats van te doen alsof het klopt.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 · KIJKEN WAT ER STAAT (verandert niets — draai dit eerst)
-- ══════════════════════════════════════════════════════════════════════════
-- Dit hoort exact drie rijen te geven. Meer of minder: STOP en overleg, want
-- dan markeert stap 3 iets anders dan bedoeld.

select id, lead_name, lead_email, scheduled_at, status
from   follow_up_appointments
where  scheduled_at >= '2026-09-08 00:00:00+02'
  and  scheduled_at <  '2026-09-09 00:00:00+02'
order  by scheduled_at;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 · DE KOLOM
-- ══════════════════════════════════════════════════════════════════════════
-- NOT NULL met default false: een bestaande rij is geen proefrij, en een
-- nieuwe rij ook niet tenzij iemand dat expliciet zegt. Geen NULL als derde
-- toestand — 'misschien een testrij' is geen bruikbaar antwoord voor een
-- filter dat bepaalt of Dave iemand belt.

alter table follow_up_appointments
  add column if not exists is_test boolean not null default false;

comment on column follow_up_appointments.is_test is
  'Proefafspraak: wordt weggelaten uit het dagbeeld van de opvolgmodule (api/_lib/opvolging-agenda-merge.js). Handmatig gezet, nooit door de sync.';

-- Het dagbeeld vraagt per dag; deze index maakt het weglaten gratis.
create index if not exists idx_follow_up_appointments_is_test
  on follow_up_appointments (scheduled_at)
  where is_test = true;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 · DE DRIE BEKENDE PROEFRIJEN MARKEREN
-- ══════════════════════════════════════════════════════════════════════════
-- Op tijdstip ÉN naam, allebei, en alleen binnen 8 september. Op de naam alleen
-- zou een echte klant kunnen raken; op het tijdstip alleen een echte call op
-- datzelfde uur. De combinatie van de twee is wat deze drie rijen aanwijst.
--
-- Draai dit in één keer en kijk naar het aantal: 3 verwacht. Wijkt het af, dan
-- klopt de aanname niet en is stap 4 er om het terug te draaien.

update follow_up_appointments
set    is_test = true
where  scheduled_at >= '2026-09-08 00:00:00+02'
  and  scheduled_at <  '2026-09-09 00:00:00+02'
  and  (
        (lead_name = 'jeffrey-test' and scheduled_at = '2026-09-08 10:30:00+02')
     or (lead_name = 'jef testo'    and scheduled_at = '2026-09-08 14:00:00+02')
     or (lead_name = 'jef testo'    and scheduled_at = '2026-09-08 20:30:00+02')
  );


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 4 · CONTROLE
-- ══════════════════════════════════════════════════════════════════════════
-- Hoort exact de drie hierboven te tonen, en niets anders — platform-breed.

select id, lead_name, scheduled_at, is_test
from   follow_up_appointments
where  is_test = true
order  by scheduled_at;


-- ══════════════════════════════════════════════════════════════════════════
-- TERUGDRAAIEN (alleen als stap 4 iets onverwachts laat zien)
-- ══════════════════════════════════════════════════════════════════════════
-- update follow_up_appointments set is_test = false
--   where scheduled_at >= '2026-09-08 00:00:00+02'
--     and scheduled_at <  '2026-09-09 00:00:00+02';
--
-- De kolom zelf laten staan is ongevaarlijk: met alles op false filtert het
-- dagbeeld niets weg en gedraagt het zich als voorheen.
