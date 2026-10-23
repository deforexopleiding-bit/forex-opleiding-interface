-- ============================================================================
-- Contentmachine — fase 1: tabellen, versies, recht en storage-bucket
-- Datum: 2026-10-23
-- Branch: claude/contentmachine
--
-- ⚠ BLOKKEREND voor de module Contentmachine (Groei → Contentmachine): de
--   endpoints api/contentmachine/*.js lezen en schrijven deze tabellen en de
--   bucket. Zonder migratie toont de module "migratie nodig"; de rest van het
--   CRM merkt niets.
--
-- ── WAT ─────────────────────────────────────────────────────────────────────
-- 1. content_drops            — één rij per wekelijkse drop (invoer + output)
-- 2. content_drop_versies     — elke opgeslagen wijziging van een drop (historiek)
-- 3. content_assets           — beelden: bibliotheek (drop_id NULL) of per drop
-- 4. nieuwsbrief_verzendingen — één rij per nieuwsbrief (GHL-template/campagne)
--                               per drop. GEEN eigen abonnees-tabel: GoHighLevel
--                               blijft de bron van de lijst en de uitschrijvingen.
-- 5. recht content.machine    — admin + manager + marketing (super_admin altijd)
-- 6. bucket `content`         — PUBLIEK lezen (website, mail, social), 10 MB,
--                               alleen beelden. Schrijven ALLEEN via de API
--                               (service role, na login + recht): GEEN
--                               insert/update/delete-policy voor gebruikers.
--
-- ── TOEGANG ─────────────────────────────────────────────────────────────────
-- RLS AAN + REVOKE ALL van anon/authenticated, geen policies: alleen de
-- service role. Het CRM gaat via de API (requirePermission 'content.machine');
-- de website (dfo-website) leest gepubliceerde drops server-side met de
-- service-key en filtert zelf op status = 'gepubliceerd'. Zo komt er geen
-- publieke policy bij (en lekken invoer/notities nooit via de anon-key).
--
-- ── IDEMPOTENT / ADDITIEF ───────────────────────────────────────────────────
-- IF NOT EXISTS / NOT EXISTS / ON CONFLICT overal; losse statements (de
-- Supabase SQL-editor knipt op statement-grenzen). Niets bestaands gewijzigd.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.content_drops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE
                     CHECK (slug ~ '^[0-9]{2}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,12})?$'),
  datum            date NOT NULL,
  soort            text NOT NULL DEFAULT 'update' CHECK (soort IN ('training', 'update')),
  status           text NOT NULL DEFAULT 'concept'
                     CHECK (status IN ('concept', 'gegenereerd', 'goedgekeurd', 'gepubliceerd', 'gearchiveerd')),
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  output           jsonb NULL,
  format_key       text NULL,
  versie           integer NOT NULL DEFAULT 1,
  aangemaakt_door  uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  gewijzigd_op     timestamptz NOT NULL DEFAULT now(),
  gegenereerd_op   timestamptz NULL,
  goedgekeurd_op   timestamptz NULL,
  gepubliceerd_op  timestamptz NULL
);

CREATE INDEX IF NOT EXISTS content_drops_datum_idx  ON public.content_drops (datum DESC, aangemaakt_op DESC);
CREATE INDEX IF NOT EXISTS content_drops_status_idx ON public.content_drops (status);

ALTER TABLE public.content_drops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_drops FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.content_drop_versies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id          uuid NOT NULL REFERENCES public.content_drops(id) ON DELETE CASCADE,
  versie           integer NOT NULL,
  reden            text NULL,
  input            jsonb NULL,
  output           jsonb NULL,
  aangemaakt_door  uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drop_id, versie)
);

ALTER TABLE public.content_drop_versies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_drop_versies FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.content_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id              uuid NULL REFERENCES public.content_drops(id) ON DELETE SET NULL,
  soort                text NOT NULL DEFAULT 'overig'
                         CHECK (soort IN ('payout', 'trade', 'chart', 'masterclass', 'team', 'community', 'overig')),
  storage_path         text NOT NULL UNIQUE,
  publieke_url         text NOT NULL,
  mime                 text NULL,
  grootte              integer NULL,
  breedte              integer NULL,
  hoogte               integer NULL,
  bijschrift           text NULL,
  ai_beschrijving      text NULL,
  ai_details           jsonb NULL,
  persoon_naam         text NULL,
  toestemming_publiek  boolean NOT NULL DEFAULT false,
  tags                 text[] NOT NULL DEFAULT '{}',
  laatst_gebruikt_op   timestamptz NULL,
  aangemaakt_door      uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op        timestamptz NOT NULL DEFAULT now(),
  verwijderd_op        timestamptz NULL
);

CREATE INDEX IF NOT EXISTS content_assets_drop_idx  ON public.content_assets (drop_id) WHERE drop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_assets_soort_idx ON public.content_assets (soort, laatst_gebruikt_op NULLS FIRST);

ALTER TABLE public.content_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_assets FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.nieuwsbrief_verzendingen (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id            uuid NULL REFERENCES public.content_drops(id) ON DELETE SET NULL,
  provider           text NOT NULL DEFAULT 'ghl' CHECK (provider IN ('ghl')),
  campagne_id        text NULL,
  template_id        text NULL,
  onderwerp          text NULL,
  status             text NOT NULL DEFAULT 'concept'
                       CHECK (status IN ('concept', 'test_verstuurd', 'ingepland', 'verstuurd')),
  test_verstuurd_op  timestamptz NULL,
  ingepland_op       timestamptz NULL,
  verstuurd_op       timestamptz NULL,
  stats              jsonb NOT NULL DEFAULT '{}'::jsonb,
  aangemaakt_door    uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op      timestamptz NOT NULL DEFAULT now(),
  gewijzigd_op       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nieuwsbrief_verzendingen_drop_idx ON public.nieuwsbrief_verzendingen (drop_id);
CREATE UNIQUE INDEX IF NOT EXISTS nieuwsbrief_verzendingen_campagne_uidx
  ON public.nieuwsbrief_verzendingen (provider, campagne_id) WHERE campagne_id IS NOT NULL;

ALTER TABLE public.nieuwsbrief_verzendingen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nieuwsbrief_verzendingen FROM anon, authenticated;

-- ── Recht content.machine ───────────────────────────────────────────────────
-- Bewust NIET leads.view: dat hebben ook mentoren en de appointmentsetter.
-- super_admin heeft geen rij nodig (eigen OR-tak in user_has_permission).
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'content.machine', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='content.machine');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'content.machine', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='content.machine');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'content.machine', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='content.machine');

-- ── Bucket `content` (publiek lezen) ────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('content', 'content', true, 10485760, ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- ── CONTROLE (alleen lezen) ─────────────────────────────────────────────────
-- SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('content_drops','content_drop_versies','content_assets','nieuwsbrief_verzendingen');
-- SELECT has_table_privilege('anon','public.content_drops','SELECT'),
--        has_table_privilege('authenticated','public.content_drops','SELECT');   -- false, false
-- SELECT role, allowed FROM public.role_permissions WHERE feature_key = 'content.machine';  -- 3 rijen
-- SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'content';
-- SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND qual::text LIKE '%''content''%';  -- 0 rijen

-- ── ROLLBACK (verwijdert ALLE drops, beelden en verzendingen) ───────────────
-- DELETE FROM public.role_permissions WHERE feature_key = 'content.machine';
-- DROP TABLE IF EXISTS public.nieuwsbrief_verzendingen;
-- DROP TABLE IF EXISTS public.content_assets;
-- DROP TABLE IF EXISTS public.content_drop_versies;
-- DROP TABLE IF EXISTS public.content_drops;
-- (bucket alleen als hij leeg is: DELETE FROM storage.buckets WHERE id = 'content';)
