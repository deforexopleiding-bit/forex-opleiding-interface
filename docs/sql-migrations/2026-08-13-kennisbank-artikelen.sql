-- 2026-08-13-kennisbank-artikelen.sql
--
-- FASE 3 AI Agents-consolidatie — centrale kennisbank + onbeantwoorde vragen.
--
-- ADDITIEF & REVERSIBEL:
--   • 2 nieuwe tabellen (CREATE TABLE IF NOT EXISTS).
--   • Raakt GEEN bestaande tabel of kolom.
--   • Geen data-migratie, geen backfill.
--   • Verwijderen = zie ROLLBACK onderaan dit bestand.
--
-- Nieuwe tabellen:
--   1) kennisbank_artikelen — centrale kennisbank die eventueel gepromoveerd
--      wordt naar joost_config.knowledge_base of lisa_config.kb_faq.
--   2) kennisbank_unmatched — vragen waarop een agent geen goed antwoord had
--      (voor "vragen zonder antwoord"-paneel + inline "Toevoegen"-flow).
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) kennisbank_artikelen
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.kennisbank_artikelen (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onderwerp    text NOT NULL,
  categorie    text NULL,                          -- 'Aanbod' / 'Prijzen' / 'Praktisch' / 'Over ons' / 'FAQ' / 'Overig'
  content      text NULL,
  agents       text[] NOT NULL DEFAULT '{}',       -- ['joost','simone','mila','lisa']
  usage_count  int NOT NULL DEFAULT 0,
  created_by   uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.kennisbank_artikelen IS
  'Centrale kennisbank-artikelen (Fase 3 AI Agents 2026-08-13). Kan gepromoveerd worden naar joost_config.knowledge_base of lisa_config.kb_faq via /api/kennisbank-promote-to-agent.';

CREATE INDEX IF NOT EXISTS idx_kb_art_categorie   ON public.kennisbank_artikelen (categorie);
CREATE INDEX IF NOT EXISTS idx_kb_art_updated_at  ON public.kennisbank_artikelen (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_art_agents_gin  ON public.kennisbank_artikelen USING gin (agents);

-- Auto-touch updated_at
CREATE OR REPLACE FUNCTION public.kb_artikelen_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kb_artikelen_touch ON public.kennisbank_artikelen;
CREATE TRIGGER trg_kb_artikelen_touch
  BEFORE UPDATE ON public.kennisbank_artikelen
  FOR EACH ROW EXECUTE FUNCTION public.kb_artikelen_touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 2) kennisbank_unmatched
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.kennisbank_unmatched (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key   text NOT NULL,                       -- 'joost' / 'simone' / 'mila' / 'lisa'
  question    text NOT NULL,
  count       int NOT NULL DEFAULT 1,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,                    -- gezet zodra promotie/dismiss
  resolved_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.kennisbank_unmatched IS
  'Vragen zonder passend antwoord (Fase 3 AI Agents 2026-08-13). Vult zich vanuit agent-logica; UI toont ze in het "onbeantwoorde vragen"-paneel met "Toevoegen aan kennisbank"-flow.';

CREATE INDEX IF NOT EXISTS idx_kb_unm_agent_key   ON public.kennisbank_unmatched (agent_key);
CREATE INDEX IF NOT EXISTS idx_kb_unm_last_seen   ON public.kennisbank_unmatched (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_kb_unm_open        ON public.kennisbank_unmatched (agent_key, count DESC) WHERE resolved_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- RLS: admin/super_admin/manager mogen alles lezen + schrijven.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.kennisbank_artikelen  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kennisbank_unmatched  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kb_art_admin_all"  ON public.kennisbank_artikelen;
DROP POLICY IF EXISTS "kb_unm_admin_all"  ON public.kennisbank_unmatched;

CREATE POLICY "kb_art_admin_all"
  ON public.kennisbank_artikelen
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
              AND p.is_active = true AND p.role IN ('super_admin','admin','manager'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
              AND p.is_active = true AND p.role IN ('super_admin','admin','manager'))
  );

CREATE POLICY "kb_unm_admin_all"
  ON public.kennisbank_unmatched
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
              AND p.is_active = true AND p.role IN ('super_admin','admin','manager'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
              AND p.is_active = true AND p.role IN ('super_admin','admin','manager'))
  );

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (indien nodig):
--
-- BEGIN;
--   DROP POLICY IF EXISTS "kb_art_admin_all"  ON public.kennisbank_artikelen;
--   DROP POLICY IF EXISTS "kb_unm_admin_all"  ON public.kennisbank_unmatched;
--   DROP TRIGGER  IF EXISTS trg_kb_artikelen_touch ON public.kennisbank_artikelen;
--   DROP FUNCTION IF EXISTS public.kb_artikelen_touch_updated_at();
--   DROP TABLE IF EXISTS public.kennisbank_unmatched;
--   DROP TABLE IF EXISTS public.kennisbank_artikelen;
-- COMMIT;
