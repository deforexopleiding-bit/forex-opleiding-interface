-- F5.1+ Afronden-model herzien:
--  * event_expenses.mentor_team_member_ids — per-uitgave wie meedeelt
--    (jsonb-array van team_members.id; NULL/leeg = alle aanwezigen)
--  * events.completion_summary — korte samenvatting van het event bij afronden
-- Owner draait deze migratie handmatig op prod.
ALTER TABLE public.event_expenses
  ADD COLUMN IF NOT EXISTS mentor_team_member_ids jsonb;
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS completion_summary text;
