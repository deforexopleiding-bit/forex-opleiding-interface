-- 023_event_attendees_call_status.sql
--
-- Twee nieuwe kolommen op event_attendees om de laatste belronde-uitkomst
-- (uit follow_up_leads.last_outcome) terug te schrijven naar de attendee.
-- Wordt gezet door api/follow-up-lead-outcome.js bij elke SPOKEN_OUTCOME
-- voor een event-lead met attendee_id.
--
-- Toegestane waarden (via app-mapping, geen CHECK — flexibel voor
-- toekomstige outcome-uitbreiding):
--   NULL              = nog niet gebeld
--   'bevestigd'
--   'komt_niet'
--   'geen_gehoor'
--   'voicemail'
--   'terugbellen'     (mapping vanuit outcome 'terugbel')
--   'foutief_nummer'
--
-- De bestaande called_at-kolom blijft staan voor backward-compat maar
-- de UI (modules/events-detail.html) toont voortaan call_status als
-- primaire indicator.

alter table event_attendees add column if not exists call_status text;
alter table event_attendees add column if not exists call_status_at timestamptz;

notify pgrst, 'reload schema';
