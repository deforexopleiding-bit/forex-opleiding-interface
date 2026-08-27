-- Event-followups: reden en herkomst vastleggen
-- Datum: 27 augustus 2026
--
-- WAAROM
-- Tot nu toe kreeg alleen een AANWEZIGE deelnemer een follow-up: outcome
-- 'opvolgen' of 'twijfelt_nog'. No-shows en afgemelden vielen buiten de
-- motor — je kon bij het afronden niets over ze kwijt, terwijl je op dat
-- moment juist wél weet waarom iemand er niet was.
--
-- Stap 1 laat no-shows en afgemelden dezelfde weg lopen: dezelfde
-- event_followups-rij, dezelfde follow_up_leads-rij, dezelfde belcadans.
-- Daarvoor moeten er twee dingen bij die er nu niet zijn: de REDEN als
-- aanklikbare waarde (niet als vrije tekst) en de HERKOMST van de rij, zodat
-- je no-shows apart kunt tellen van afgemelden en van wie nog moest beslissen.
--
-- De bestaande kolom `reason` blijft wat ze was: de vrije notitie die de
-- gebruiker typt. Die betekenis verandert niet, ook niet voor bestaande rijen.
--
-- BEWUST GEEN CHECK-CONSTRAINT.
-- Zelfde afweging als in migrations/024_event_attendees_no_show_followup.sql:
-- de toegestane waarden zijn app-niveau, zodat er een reden bij kan zonder
-- migratie. De waarden staan hieronder in een COMMENT en in
-- api/_lib/events-complete-core.js.
--
-- NIET DESTRUCTIEF. Twee nullable kolommen erbij en één index. Geen bestaande
-- kolom aangeraakt, geen data herschreven, geen constraint gewijzigd.
-- Idempotent: veilig een tweede keer te draaien.
--
-- ── DRAAIEN ────────────────────────────────────────────────────────────────
-- Nog NIET gedraaid. Uitvoeren in de Supabase SQL-editor.
--
-- CONTROLE VOORAF — hoort 2 rijen te geven (reason, note), en niet meer:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'event_followups'
--      and column_name in ('reason','note','reason_code','bron_uitkomst');
--
-- CONTROLE ACHTERAF — hoort 4 rijen te geven:
--   (zelfde query)
--
-- TERUGDRAAIEN (alleen als er nog niets in staat):
--   alter table public.event_followups drop column if exists bron_uitkomst;
--   alter table public.event_followups drop column if exists reason_code;
--   drop index if exists event_followups_bron_uitkomst_open_idx;
-- ───────────────────────────────────────────────────────────────────────────

begin;

alter table public.event_followups
  add column if not exists reason_code text;

alter table public.event_followups
  add column if not exists bron_uitkomst text;

comment on column public.event_followups.reason_code is
  'Aangeklikte reden bij een afwezige deelnemer. App-niveau, geen CHECK:
     kon_niet          — kon niet komen (ziekte, werk, iets tussendoor)
     niet_gereageerd   — nooit iets van gehoord
     afgemeld_bericht  — heeft zich afgemeld per bericht
     onbekend          — reden niet bekend
   NULL voor rijen die uit een aanwezige deelnemer komen; daar is de reden
   de vrije notitie in `reason`.';

comment on column public.event_followups.bron_uitkomst is
  'Waar deze follow-up vandaan komt, zodat de soorten apart te tellen zijn.
   App-niveau, geen CHECK:
     opvolgen | twijfelt_nog   — was aanwezig (bestaand gedrag)
     no_show                   — niet komen opdagen
     afgemeld                  — vooraf afgemeld
   NULL op rijen van vóór deze migratie; die zijn allemaal opvolgen of
   twijfelt_nog. Wil je die alsnog invullen, dan kan dat later los — deze
   migratie raakt bestaande rijen bewust niet aan.';

-- Tellen per soort over de nog openstaande follow-ups.
create index if not exists event_followups_bron_uitkomst_open_idx
  on public.event_followups (bron_uitkomst)
  where status = 'open';

commit;

notify pgrst, 'reload schema';
