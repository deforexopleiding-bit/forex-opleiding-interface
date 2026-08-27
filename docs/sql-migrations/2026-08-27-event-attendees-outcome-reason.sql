-- ============================================================================
--  event_attendees.outcome_reason — de reden achter een "nee" vastleggen
-- ============================================================================
--  Draai deze SQL in de Supabase SQL-editor. Puur additief: één nullable
--  kolom en één index. Geen bestaande kolom aangeraakt, geen data herschreven,
--  geen constraint gewijzigd. Idempotent — veilig een tweede keer te draaien.
--
--  WAAROM
--  ------
--  "Geen interesse" was tot nu toe een doodlopende uitkomst: je klikte hem
--  aan en er bleef niets over om op te sturen. Vanaf stap 2 is een reden
--  verplicht, gekozen uit de elf bezwaren die de Follow-up-module al kent
--  (te duur, geen tijd, moet overleggen, …). Daarmee wordt een nee een
--  gekwalificeerde nee: je kunt zien of mensen afhaken op prijs, op timing,
--  of omdat ze eerst met iemand moeten overleggen — en dat zijn drie heel
--  verschillende problemen.
--
--  Deze kolom is de plek waar die reden landt. Bewust NIET in
--  event_followups: die tabel gaat over follow-ups die nog opgevolgd moeten
--  worden, en een nee is juist het einde daarvan.
--
--  BEWUST GEEN CHECK-CONSTRAINT. De elf bezwaren staan op app-niveau, op één
--  plek in de code (KV_V2.helpers.BEZWAREN voor het scherm,
--  api/_lib/bezwaren.js voor de server, met een test die bewaakt dat die twee
--  gelijk blijven). Zo kan er een bezwaar bij zonder migratie. Zelfde
--  afweging als in migrations/024_event_attendees_no_show_followup.sql.
--
--  DE CODE WERKT OOK ZONDER DEZE MIGRATIE. Bestaat de kolom nog niet, dan
--  valt de schrijfactie terug op de payload zonder outcome_reason en wordt
--  de uitkomst gewoon opgeslagen. Je verliest dan alleen de reden, niet de
--  registratie.
--
--  ── DRAAIEN ────────────────────────────────────────────────────────────────
--  Nog NIET gedraaid.
--
--  CONTROLE VOORAF — hoort 0 rijen te geven:
--    select column_name from information_schema.columns
--     where table_schema = 'public' and table_name = 'event_attendees'
--       and column_name = 'outcome_reason';
--
--  CONTROLE ACHTERAF — hoort 1 rij te geven, type text, nullable YES:
--    select column_name, data_type, is_nullable
--      from information_schema.columns
--     where table_schema = 'public' and table_name = 'event_attendees'
--       and column_name = 'outcome_reason';
--
--  MEETVRAAG die hierna beantwoordbaar wordt — waarom haken mensen af:
--    select outcome_reason, count(*) as aantal
--      from public.event_attendees
--     where outcome = 'geen_interesse' and outcome_reason is not null
--     group by 1 order by 2 desc;
--
--  TERUGDRAAIEN (alleen als er nog niets in staat):
--    drop index if exists event_attendees_outcome_reason_idx;
--    alter table public.event_attendees drop column if exists outcome_reason;
-- ============================================================================

begin;

alter table public.event_attendees
  add column if not exists outcome_reason text;

comment on column public.event_attendees.outcome_reason is
  'Het gekozen bezwaar bij outcome = ''geen_interesse''. Eén van de elf vaste
   bezwaren uit de Follow-up-module (Te duur, Geen tijd, Moet overleggen, Al
   bij andere partij, Wil eerst resultaten zien, Twijfelt over online, Geen
   vertrouwen, Wil eerst zelf proberen, Slecht moment, Geen budget nu,
   Anders). App-niveau, geen CHECK — zie api/_lib/bezwaren.js.
   NULL bij elke andere uitkomst en op alle rijen van vóór deze migratie.';

-- Voor de vraag "waarom haken mensen af". Partial: alleen ingevulde redenen.
create index if not exists event_attendees_outcome_reason_idx
  on public.event_attendees (outcome_reason)
  where outcome_reason is not null;

commit;

notify pgrst, 'reload schema';
