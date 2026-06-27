-- ──────────────────────────────────────────────────────────────────────────────
-- Migratie 019: taken_comments — reactie-thread per taak
-- ──────────────────────────────────────────────────────────────────────────────
-- Idempotent. RLS aan zonder policies; endpoints gebruiken supabaseAdmin +
-- doen zelf participant-of-admin check.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.taken_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES public.taken_items(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_taken_comments_task
  ON public.taken_comments (task_id);

ALTER TABLE public.taken_comments ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS public.taken_comments;
