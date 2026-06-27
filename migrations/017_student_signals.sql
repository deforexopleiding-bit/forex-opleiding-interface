-- ──────────────────────────────────────────────────────────────────────────────
-- Migratie 017: student_signals — mentor meldt, admin handelt af
-- ──────────────────────────────────────────────────────────────────────────────
-- Idempotent (CREATE TABLE IF NOT EXISTS, indexes idem). RLS staat AAN maar
-- zonder policies → alleen service-role keys mogen lezen/schrijven. Endpoints
-- gaten in-code op mentor.module.access (create / mentor-list) en
-- students.all.view (admin-list / handle).
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.student_signals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bubble_student_id  text NOT NULL,
  student_name       text,
  student_email      text,                       -- lowercased + getrimd
  type               text NOT NULL CHECK (type IN (
                       'eerste_call', 'reageert_niet', 'niet_bereikbaar',
                       'geen_reactie_bellen', 'anders')),
  toelichting        text,
  mentor_user_id     uuid NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN (
                       'open', 'opnieuw_opvolgen', 'afgehandeld')),
  uitkomst_type      text CHECK (uitkomst_type IN (
                       'opgelost', 'geen_gehoor_opnieuw', 'student_gestopt', 'anders')),
  uitkomst           text,
  handled_by_user_id uuid,
  handled_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_signals_status
  ON public.student_signals (status);
CREATE INDEX IF NOT EXISTS idx_student_signals_mentor
  ON public.student_signals (mentor_user_id);
CREATE INDEX IF NOT EXISTS idx_student_signals_student
  ON public.student_signals (bubble_student_id);

-- RLS AAN zonder policies → alleen service-role mag lezen/schrijven; user-tokens
-- worden door RLS geblokkeerd. De endpoints gebruiken supabaseAdmin (service-
-- role) en doen zelf de RBAC + ownership checks.
ALTER TABLE public.student_signals ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Rollback (handmatig, defensief):
-- DROP TABLE IF EXISTS public.student_signals;
