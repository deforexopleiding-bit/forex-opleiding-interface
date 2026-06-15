-- =============================================================================
-- F5.0 — Mentor-identiteit: koppel team_members.user_id aan auth.users zodat
-- mentor-bonussen en uitgaven aan een echte ingelogde gebruiker hangen.
-- Plus: event_attendees.customer_id voor de signed-quote → bonus-koppeling.
-- =============================================================================
BEGIN;

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_user_id
  ON public.team_members (user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_event_attendees_customer
  ON public.event_attendees (customer_id);

COMMIT;
