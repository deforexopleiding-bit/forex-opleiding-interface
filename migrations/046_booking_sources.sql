-- ============================================================================
-- Migratie 046: Opstartsessie bron-tracking (DEEL 1 van Opstartsessie-project)
-- Datum: 2026-08-27
-- Doel:  attributie van geboekte Opstartsessies per link-slug ('nieuwsbrief',
--        'romy', 'dave', 'opvolging', 'verlengen', …). Één GHL-agenda; de
--        bron leeft in ons eigen systeem, geen 20 aparte GHL-agenda's meer.
--
-- Wijzigingen:
--   1. Nieuwe tabel public.booking_sources (bewerkbaar via Leadsonderhoud →
--      Bronnen-tab; CRUD via api/booking-sources-*).
--   2. Kolom public.follow_up_appointments.booking_source text NULL — rauwe
--      slug uit de link, ook als 'ie niet (meer) in booking_sources staat
--      (typo/oude link blijft telbaar).
--   3. Seed van 5 startbronnen (Jeffrey's initiële set).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, ON
-- CONFLICT DO NOTHING op seed. Herhaalde run = no-op.
--
-- 0 incasso-writes. Incasso-zone (finance.html, *dunning*, *arrangement*,
-- pending-action*, _lib/dunning-*) onaangeroerd.
-- ============================================================================

BEGIN;

-- ── 1. Bronnenlijst ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_sources (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label      text NOT NULL,
  actief     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.booking_sources IS 'Attributie-bronnen voor Opstartsessie-links. Slug reist mee in de URL /opstartsessie/<slug> en komt terug op follow_up_appointments.booking_source.';
COMMENT ON COLUMN public.booking_sources.slug IS 'URL-slug — lowercase, alfanumeriek + hyphen, max 64 chars. UNIQUE. Wordt matched op case-sensitive gelijkheid door de publieke pagina.';

-- ── 2. Bron op de afspraak ─────────────────────────────────────────────────
ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS booking_source text;

COMMENT ON COLUMN public.follow_up_appointments.booking_source IS 'Rauwe slug uit /opstartsessie/<slug>. NULL = geen slug (directe boeking of oude flow). Kan ook een slug bevatten die niet (meer) in booking_sources staat (typo/gedeactiveerd) — voor telling nog wel bereikbaar.';

-- Index voor GROUP BY booking_source in stats-queries.
CREATE INDEX IF NOT EXISTS idx_follow_up_appointments_booking_source
  ON public.follow_up_appointments (booking_source)
  WHERE booking_source IS NOT NULL;

-- ── 3. Seed (5 startbronnen) ───────────────────────────────────────────────
INSERT INTO public.booking_sources (slug, label, actief) VALUES
  ('nieuwsbrief', 'Nieuwsbrief', true),
  ('romy',        'Romy',        true),
  ('dave',        'Dave',        true),
  ('opvolging',   'Opvolging',   true),
  ('verlengen',   'Verlengen',   true)
ON CONFLICT (slug) DO NOTHING;

-- ── 4. updated_at trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._booking_sources_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_booking_sources_touch ON public.booking_sources;
CREATE TRIGGER trg_booking_sources_touch
  BEFORE UPDATE ON public.booking_sources
  FOR EACH ROW EXECUTE FUNCTION public._booking_sources_touch_updated_at();

-- ── 5. RLS: read-all voor authenticated, write via service-role ───────────
ALTER TABLE public.booking_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_sources_read ON public.booking_sources;
CREATE POLICY booking_sources_read ON public.booking_sources
  FOR SELECT TO authenticated
  USING (true);

-- Writes via supabaseAdmin (service-role) — geen policy nodig voor
-- authenticated-writes; RBAC + secret gate zit in de API-endpoints.

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Tabel + seed staat:
--    SELECT slug, label, actief FROM public.booking_sources ORDER BY slug;
--    Verwacht: 5 rijen (dave, nieuwsbrief, opvolging, romy, verlengen).
--
-- 2. Kolom staat:
--    SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='follow_up_appointments'
--       AND column_name='booking_source';
--    Verwacht: booking_source | text.
--
-- 3. Index staat:
--    SELECT indexname FROM pg_indexes
--     WHERE tablename='follow_up_appointments'
--       AND indexname='idx_follow_up_appointments_booking_source';
--    Verwacht: 1 rij.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.booking_sources;
--   DROP FUNCTION IF EXISTS public._booking_sources_touch_updated_at();
--   ALTER TABLE public.follow_up_appointments DROP COLUMN IF EXISTS booking_source;
--   DROP INDEX IF EXISTS public.idx_follow_up_appointments_booking_source;
-- COMMIT;
-- ============================================================================
