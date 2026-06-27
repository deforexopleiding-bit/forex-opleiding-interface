-- ──────────────────────────────────────────────────────────────────────────────
-- Migratie 018: student_signals — no_show-uitbreiding
-- ──────────────────────────────────────────────────────────────────────────────
-- Voegt 'no_show' aan de type-enum, drie kolommen (session_id, source,
-- reason_given_at) en een unique index op session_id voor dedup van auto-
-- gedetecteerde no-shows uit de noshow-detect cron.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD COLUMN IF NOT EXISTS +
-- CREATE UNIQUE INDEX IF NOT EXISTS. Veilig om vaker te draaien.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Type-enum uitbreiden met 'no_show'.
ALTER TABLE public.student_signals
  DROP CONSTRAINT IF EXISTS student_signals_type_check;

ALTER TABLE public.student_signals
  ADD CONSTRAINT student_signals_type_check CHECK (type IN (
    'eerste_call', 'reageert_niet', 'niet_bereikbaar',
    'geen_reactie_bellen', 'anders', 'no_show'));

-- 2) Nieuwe kolommen.
ALTER TABLE public.student_signals
  ADD COLUMN IF NOT EXISTS session_id      text,
  ADD COLUMN IF NOT EXISTS source          text NOT NULL DEFAULT 'mentor',
  ADD COLUMN IF NOT EXISTS reason_given_at timestamptz;

-- 3) Dedup-index voor auto-gedetecteerde no-shows. Partial index op
--    WHERE session_id IS NOT NULL zodat bestaande mentor-meldingen
--    zonder session_id niet onder de uniqueness vallen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_signals_session
  ON public.student_signals (session_id) WHERE session_id IS NOT NULL;

COMMIT;

-- Rollback (handmatig, defensief):
-- DROP INDEX IF EXISTS public.uq_student_signals_session;
-- ALTER TABLE public.student_signals
--   DROP COLUMN IF EXISTS session_id,
--   DROP COLUMN IF EXISTS source,
--   DROP COLUMN IF EXISTS reason_given_at;
-- ALTER TABLE public.student_signals DROP CONSTRAINT IF EXISTS student_signals_type_check;
-- ALTER TABLE public.student_signals ADD CONSTRAINT student_signals_type_check CHECK (type IN (
--   'eerste_call','reageert_niet','niet_bereikbaar','geen_reactie_bellen','anders'));
