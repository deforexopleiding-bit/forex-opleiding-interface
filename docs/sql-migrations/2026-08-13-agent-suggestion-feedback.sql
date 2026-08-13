-- 2026-08-13-agent-suggestion-feedback.sql
--
-- FASE 2 AI Agents-consolidatie — feedback duim-op/duim-neer.
--
-- ADDITIEF & REVERSIBEL:
--   • Nieuwe tabel `agent_suggestion_feedback` (CREATE TABLE IF NOT EXISTS).
--   • Raakt GEEN bestaande tabel of kolom.
--   • Geen data-migratie, geen backfill.
--   • Verwijderen = DROP TABLE public.agent_suggestion_feedback CASCADE;
--
-- Deze tabel bevat losstaande feedback-events per agent (Joost / Simone /
-- Mila / Lisa) voor tellingen in de Prestaties-tab. Er wordt NIET geschreven
-- naar joost_suggestions, lisa_feedback of enig ander bestaande log.
--
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_suggestion_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module         text NULL,                                   -- 'finance' / 'events' / 'onboarding' / NULL (lisa)
  suggestion_id  text NULL,                                   -- optioneel: koppeling aan joost_suggestions.id of lisa_messages.id
  agent_key      text NOT NULL,                               -- 'joost' / 'simone' / 'mila' / 'lisa'
  rating         text NOT NULL CHECK (rating IN ('up','down')),
  note           text NULL,
  user_id        uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_suggestion_feedback IS
  'Duim-op/duim-neer feedback per agent (Fase 2 AI Agents-consolidatie 2026-08-13). Additief; verwijderen = DROP TABLE public.agent_suggestion_feedback CASCADE.';

-- Indexes voor tellen + recente feedback opzoeken.
CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent_key
  ON public.agent_suggestion_feedback (agent_key);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_created_at
  ON public.agent_suggestion_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_module_created
  ON public.agent_suggestion_feedback (module, created_at DESC)
  WHERE module IS NOT NULL;

-- RLS: admin/super_admin/manager mogen lezen en schrijven.
ALTER TABLE public.agent_suggestion_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_feedback_admin_read"  ON public.agent_suggestion_feedback;
DROP POLICY IF EXISTS "agent_feedback_admin_write" ON public.agent_suggestion_feedback;

CREATE POLICY "agent_feedback_admin_read"
  ON public.agent_suggestion_feedback
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active = true
        AND p.role IN ('super_admin','admin','manager')
    )
  );

CREATE POLICY "agent_feedback_admin_write"
  ON public.agent_suggestion_feedback
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active = true
        AND p.role IN ('super_admin','admin','manager')
    )
  );

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (indien nodig):
--
-- BEGIN;
--   DROP POLICY IF EXISTS "agent_feedback_admin_read"  ON public.agent_suggestion_feedback;
--   DROP POLICY IF EXISTS "agent_feedback_admin_write" ON public.agent_suggestion_feedback;
--   DROP TABLE IF EXISTS public.agent_suggestion_feedback;
-- COMMIT;
