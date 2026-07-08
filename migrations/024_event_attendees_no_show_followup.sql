-- 024_event_attendees_no_show_followup.sql
--
-- No-show opvolging voor Follow-up cockpit.
--
-- Twee nieuwe kolommen op event_attendees:
--   no_show_followup_status  text        (NULL / 'open' = nog te doen; anders afgehandeld)
--   no_show_followup_at      timestamptz (wanneer de opvolg-uitkomst is gezet)
--
-- Toegestane waarden (app-level, GEEN CHECK — flexibel voor uitbreiding):
--   NULL             = attendee is no-show, nog niet opgevolgd
--   'open'           = expliciet nog open (alias voor NULL)
--   'ander_event'    = bereikt + verplaatst naar ander event (afgehandeld, VERBORGEN in lijst)
--   'geen_interesse' = bereikt + geen interesse (afgehandeld, VERBORGEN in lijst)
--   'niet_bereikt'   = niet bereikt (BLIJFT ZICHTBAAR in lijst met markering)
--   'terugbellen'    = bereikt + terugbelafspraak (BLIJFT ZICHTBAAR in lijst met markering)
--
-- Wordt gezet door /api/follow-up-no-show-outcome bij handmatige registratie
-- vanuit de No-show-tab in follow-up.html. De no-show-lijst filtert
-- ('ander_event' + 'geen_interesse') uit; 'niet_bereikt' en 'terugbellen'
-- blijven zichtbaar met een badge zodat sales opnieuw kan opvolgen.

alter table event_attendees add column if not exists no_show_followup_status text;
alter table event_attendees add column if not exists no_show_followup_at     timestamptz;

-- Partial index voor snelle filtering: alleen open/nog-te-doen no-shows.
create index if not exists event_attendees_noshow_followup_open_idx
  on event_attendees (event_id, no_show_followup_status)
  where status = 'no_show'
    and (no_show_followup_status is null
      or no_show_followup_status in ('open', 'niet_bereikt', 'terugbellen'));

notify pgrst, 'reload schema';
