-- 2026-09-23 · event_attendees.notitie — de broodjesnotitie bij een deelnemer
--
-- ── WAAROM ──────────────────────────────────────────────────────────────────
-- Bij het bevestigen van een masterclass-aanmelding ("Bevestigd — hij komt")
-- wil Dave kunnen noteren wat iemand eet: "2x kaas", "1x hesp 1x kaas". Die
-- notitie hoort bij de DEELNEMER van dat event en niet bij de opvolgtaak, want
-- hij moet in de eventmodule op de aanwezigenlijst verschijnen — dat is de
-- lijst waarmee de broodjes besteld worden.
--
-- ── LET OP: DIT IS NIET DEZELFDE KOLOM ALS `notes` ─────────────────────────
-- `event_attendees.notes` bestaat al en is iets anders: de vrije notitie in het
-- deelnemer-detailpaneel van de eventmodule ("Opgebeld door Chesney om 13u41 —
-- is er zeker bij"). Die wordt daar door mensen gevuld en gelezen.
--
-- Hergebruiken zou betekenen dat het bevestigingsvenster die tekst overschrijft
-- of eraan plakt, en dan is de brooodjeslijst niet meer te lezen en Chesney's
-- aantekening weg. Twee verschillende soorten informatie over dezelfde persoon
-- horen in twee kolommen.
--
--   notes    — vrije aantekening over de deelnemer (detailpaneel).
--   notitie  — wat deze persoon eet (aanwezigenlijst, kolom NOTITIE).
--
-- ── NIET BLOKKEREND ─────────────────────────────────────────────────────────
-- De code leest en schrijft de kolom met een terugval op 42703 (kolom bestaat
-- niet), gematcht op de KOLOMNAAM en niet op de foutcode alleen. Zolang de
-- kolom er niet is:
--   · bevestigen doet precies wat het nu doet — belstatus, plek, mail;
--   · het broodjesveld wordt niet weggeschreven en het scherm zegt dat;
--   · de kolom NOTITIE in de aanwezigenlijst blijft leeg met dezelfde melding.
-- Er gaat dus niets stuk, en niemand denkt dat een bestelling is opgeslagen
-- terwijl dat niet zo is.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 · KIJKEN WAT ER STAAT (verandert niets — draai dit eerst)
-- ══════════════════════════════════════════════════════════════════════════
-- Hoort `notes` te tonen en GEEN `notitie`. Staat `notitie` er al, dan is deze
-- migratie al gedraaid en hoef je niets te doen.

select column_name, data_type, is_nullable
from   information_schema.columns
where  table_schema = 'public'
  and  table_name   = 'event_attendees'
  and  column_name in ('notes', 'notitie')
order  by column_name;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 · DE KOLOM
-- ══════════════════════════════════════════════════════════════════════════
-- Nullable zonder default: leeg betekent 'niets opgegeven', en dat is iets
-- anders dan een lege string. Het bevestigingsvenster laat het veld leeg als
-- er niets getypt is, en wissen zet 'm terug op NULL.

alter table public.event_attendees
  add column if not exists notitie text;

comment on column public.event_attendees.notitie is
  'Broodjesnotitie: wat deze deelnemer eet, ingevuld bij "Bevestigd" in de opvolgmodule en te bewerken in de kolom NOTITIE van de aanwezigenlijst. NIET hetzelfde als notes — dat is de vrije aantekening in het deelnemer-detailpaneel.';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 · CONTROLE
-- ══════════════════════════════════════════════════════════════════════════
-- Hoort nu twee rijen te tonen: notes en notitie, allebei text en nullable.

select column_name, data_type, is_nullable
from   information_schema.columns
where  table_schema = 'public'
  and  table_name   = 'event_attendees'
  and  column_name in ('notes', 'notitie')
order  by column_name;


-- ══════════════════════════════════════════════════════════════════════════
-- DE BROODJESLIJST VOOR ÉÉN EVENT (de controlequery)
-- ══════════════════════════════════════════════════════════════════════════
-- Vul het event-id in. Toont iedereen die komt, met zijn notitie; wie niets
-- heeft opgegeven staat er ook in, met een lege notitie — die moet je immers
-- nog vragen. Proefrijen (is_test) doen niet mee, net als in de aanwezigenlijst.
--
-- select a.first_name, a.last_name, a.call_status, a.notitie
-- from   public.event_attendees a
-- where  a.event_id = '<event-uuid>'
--   and  a.is_test = false
--   and  a.status <> 'geannuleerd'
-- order  by (a.notitie is null), a.last_name, a.first_name;


-- ══════════════════════════════════════════════════════════════════════════
-- TERUGDRAAIEN
-- ══════════════════════════════════════════════════════════════════════════
-- Let op: dit gooit alle ingevulde broodjesnotities weg.
--
-- alter table public.event_attendees drop column if exists notitie;
