-- ============================================================================
-- FASE 0 (TER REVIEW — NIET auto-draaien) — Mini-cursus-rollensysteem: fundament
-- Datum: 2026-08-01
--
-- Onderdeel van het gefaseerde, backward-compatible ontwerp
-- (zie docs/ontwerp-minicursus-rollensysteem.md). Deze fase is PUUR ADDITIEF:
-- er worden 4 lege tabellen aangemaakt + 2 producten geseed. NIETS leest deze
-- tabellen nog — de live 7-daagse-leeromgeving en de motor blijven ongewijzigd
-- werken. Backfill van grants, content-koppeling, LMS-gating, funnel en de
-- motor-ombouw komen in latere fasen.
--
-- Producten: gebruiker↔product is many-to-many (meerdere producten per persoon);
-- toegang is TIJDELIJK met vervaldatum (grant.toegang_tot).
--   * 7-daagse : gratis trial, venster 7 dagen  (opvolger van de gratis-vlag)
--   * minicursus: gratis instapcursus (lead-magnet, geen betaalstap), venster 14 dagen,
--                 eigen quiz + eigen desk
--
-- is_trial: descriptief label "gratis lead-magnet (geen betaalstap)", GEEN gating-input.
-- Toegang wordt bepaald door een actieve grant (lms_toegang) + de content-junctions;
-- welke content bij welk product hoort doet de junction, niet is_trial. Beide producten
-- zijn gratis tasters -> beide is_trial = true. (Zie ontwerp-doc.)
--
-- NB: draai NA deze DDL "NOTIFY pgrst, 'reload schema';" (of de dashboard-knop
-- "Reload schema cache"), anders kent PostgREST de nieuwe tabellen nog niet.
-- ============================================================================

-- ── 1) lms_producten ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lms_producten (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,            -- '7-daagse','minicursus'
  naam         text NOT NULL,
  omschrijving text,
  is_trial     boolean NOT NULL DEFAULT false,  -- 7-daagse = true
  duur_dagen   integer,                          -- vensterlengte; NULL = onbeperkt
  quiz_slug    text,                             -- -> website_quizzes.slug (geen FK)
  desk_pad     text,                             -- eigen desk-route (bv. '/lms/minicursus')
  nav_label    text,                             -- sidebar-label (NULL = geen aparte link)
  volgorde     integer NOT NULL DEFAULT 0,       -- ook default-landing-prioriteit
  actief       boolean NOT NULL DEFAULT true,
  aangemaakt   timestamptz NOT NULL DEFAULT now()
);

-- ── 2) lms_toegang — de many-to-many grant (tijdelijk, met vervaldatum) ──────
CREATE TABLE IF NOT EXISTS public.lms_toegang (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gebruiker_id uuid NOT NULL REFERENCES public.lms_gebruikers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES public.lms_producten(id)  ON DELETE RESTRICT,
  toegang_van  timestamptz NOT NULL DEFAULT now(),
  toegang_tot  timestamptz,                       -- minicursus = van + 14d; NULL = onbeperkt
  bron         text,                              -- 'website','handmatig','backfill'
  aangemaakt   timestamptz NOT NULL DEFAULT now(),
  bijgewerkt   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lms_toegang_uniek UNIQUE (gebruiker_id, product_id)  -- 1 grant/paar -> UPSERT verlengt
);
CREATE INDEX IF NOT EXISTS lms_toegang_gebruiker_idx ON public.lms_toegang (gebruiker_id);
CREATE INDEX IF NOT EXISTS lms_toegang_product_tot_idx ON public.lms_toegang (product_id, toegang_tot);

-- ── 3) content ↔ product (junctions op video/document-niveau) ────────────────
CREATE TABLE IF NOT EXISTS public.lms_product_videos (
  product_id uuid NOT NULL REFERENCES public.lms_producten(id) ON DELETE CASCADE,
  video_id   uuid NOT NULL REFERENCES public.lms_videos(id)    ON DELETE CASCADE,
  PRIMARY KEY (product_id, video_id)
);
CREATE TABLE IF NOT EXISTS public.lms_product_documenten (
  product_id  uuid NOT NULL REFERENCES public.lms_producten(id)  ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.lms_documenten(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, document_id)
);

-- ── 4) RLS: aan, geen anon-policy (server leest via de service role) ─────────
ALTER TABLE public.lms_producten          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_toegang            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_product_videos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_product_documenten ENABLE ROW LEVEL SECURITY;
-- Bewust GEEN anon-policy: de service role bypasst RLS (consistent met
-- lms_gebruikers/lms_videos). Wil je later een publieke productlijst tonen:
--   CREATE POLICY producten_anon_read ON public.lms_producten
--     FOR SELECT TO anon USING (actief);

-- ── 5) Seed: de eerste twee producten ───────────────────────────────────────
INSERT INTO public.lms_producten (slug, naam, omschrijving, is_trial, duur_dagen, quiz_slug, desk_pad, nav_label, volgorde)
VALUES
  ('7-daagse',  '7 dagen meekijken', 'Gratis 7-daagse trial (opvolger van de gratis-vlag).',
     true,  7,  '7-daagse',  '/lms/studydesk',  NULL,          10),
  ('minicursus','Mini cursus',       'Gratis kennismakings-/instapcursus (lead-magnet, geen betaalstap) met 14 dagen toegang.',
     true,  14, 'minicursus','/lms/minicursus', 'Mini cursus', 20)
ON CONFLICT (slug) DO NOTHING;

-- ── 6) Verificatie ───────────────────────────────────────────────────────────
--   SELECT slug, naam, is_trial, duur_dagen, quiz_slug, desk_pad, nav_label
--   FROM public.lms_producten ORDER BY volgorde;
--   -- (lms_toegang / de junctions horen nog leeg te zijn: dit is fundament-only)
--   SELECT count(*) AS grants FROM public.lms_toegang;

-- ── ROLLBACK (indien nodig) ──────────────────────────────────────────────────
-- Puur additief; volledig terug te draaien (er hangt in fase 0 nog niets aan):
--   DROP TABLE IF EXISTS public.lms_product_documenten;
--   DROP TABLE IF EXISTS public.lms_product_videos;
--   DROP TABLE IF EXISTS public.lms_toegang;
--   DROP TABLE IF EXISTS public.lms_producten;
