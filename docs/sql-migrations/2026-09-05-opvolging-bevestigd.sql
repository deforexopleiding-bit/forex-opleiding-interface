-- ============================================================================
-- Opvolging — twee kolommen erbij op opvolging_taken voor 'bevestigd'
-- Datum: 2026-09-05
-- Branch: feat/opvolging-weekbalk-en-bevestigd
--
-- ⚠ BLOKKEREND. api/opvolging-aanmelding-actie.js noemt deze twee kolommen bij
-- naam in een UPDATE. Draait deze migratie niet vóór of direct na de merge, dan
-- faalt de hele update met `column "bevestigd_op" does not exist` en werkt de
-- knop 'Bevestigd' niet — de andere drie uitgangen blijven wél gewoon werken,
-- want die noemen de kolommen niet. Nullable betekent hier dus 'optioneel voor
-- bestaande rijen', niet 'optioneel voor de code'. Zie CLAUDE.md, de les over
-- kolom-migraties.
--
-- ── WAAROM DEZE TWEE KOLOMMEN ───────────────────────────────────────────────
-- De aanmeldkaart had drie uitgangen (gesprek gehad / geen interesse /
-- verplaatst) en miste de meest voorkomende: de lead zegt 'ja, ik kom'.
--
-- Die bevestiging is geen eindpunt maar een tussenstand. Bevestigt iemand in
-- ronde A — de aanmelding zelf, meer dan vier dagen voor het event — dan moet
-- de kaart vandaag weg maar vier dagen voor het event terugkomen voor de
-- reminder-call. In ronde B is er geen ronde meer en gaat de kaart definitief
-- dicht.
--
-- In ronde B moet op de kaart te zien zijn dát er in ronde A al bevestigd is,
-- met datum en notitie. Dan belt Dave niet meer met de vraag of iemand komt,
-- maar als herinnering: je komt aankomende donderdag, klopt dat nog? Zonder die
-- twee velden staat er in ronde B een kaart die niet van een verse aanmelding
-- te onderscheiden is.
--
-- ── WAAROM NIET IN `notitie` ────────────────────────────────────────────────
-- De regel komt óók in notitie te staan, als leesbaar spoor. Maar de badge op
-- de kaart en de tekst in het venster moeten weten of er bevestigd is zonder
-- vrije tekst te moeten uitparseren. Een datumkolom is daarvoor het juiste
-- gereedschap; grep op een notitieveld is dat niet.
--
-- ── GEEN CONSTRAINT AANGERAAKT ──────────────────────────────────────────────
-- De status blijft 'open' (slapend tot ronde B) of wordt 'gearchiveerd'. Beide
-- staan al in opvolging_taken_status_chk. `reden` blijft 'aanmelding'. Er is
-- dus niets aan een CHECK te wijzigen.
--
-- Idempotent: `if not exists` op beide kolommen.
-- ============================================================================

alter table public.opvolging_taken
  add column if not exists bevestigd_op timestamptz;

alter table public.opvolging_taken
  add column if not exists bevestigd_notitie text;

comment on column public.opvolging_taken.bevestigd_op is
  'Moment waarop de lead bevestigde te komen. Gevuld = in ronde A bevestigd; de kaart slaapt dan tot vier dagen voor het event en komt terug voor de reminder-call.';

comment on column public.opvolging_taken.bevestigd_notitie is
  'Wat de lead bij die bevestiging zei. Niet verplicht — anders wordt de meest voorkomende uitkomst de traagste knop.';

-- ── Controle achteraf ───────────────────────────────────────────────────────
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'opvolging_taken'
--      and column_name in ('bevestigd_op','bevestigd_notitie');
--   -- verwacht: 2 rijen, timestamptz + text, allebei YES
