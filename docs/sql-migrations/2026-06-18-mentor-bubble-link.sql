-- Migration: team_members.bubble_user_id — koppeling van een mentor (team_members)
-- aan een bubble.io User-id. Spiegelt het bestaande user_id-pattern (auth.users
-- koppeling): tekstkolom + unique partial index zodat dezelfde bubble-User niet
-- aan twee verschillende team_members kan hangen, maar NULL is wel meerdere keren
-- toegestaan (mentor zonder bubble-koppeling).
--
-- Strategie: idempotent (IF NOT EXISTS) zodat re-run veilig is.

BEGIN;

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS bubble_user_id text;

COMMENT ON COLUMN public.team_members.bubble_user_id IS
  'Bubble.io User-id voor de mentor-koppeling (PR2a). Wordt door admin gezet via '
  '/api/mentor-bubble-link; gebruikt voor read-proxy van bubble-data in latere PR2b. '
  'NULL = geen koppeling. Unique zodat 1 bubble-user aan max 1 team_member hangt.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_bubble_user_id
  ON public.team_members (bubble_user_id)
  WHERE bubble_user_id IS NOT NULL;

COMMIT;
