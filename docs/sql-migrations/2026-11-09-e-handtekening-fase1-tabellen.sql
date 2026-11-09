-- ============================================================================
-- E-handtekening — fase 1 (MVP): tabellen, onveranderlijke audit, rechten
-- Datum: 2026-11-09
-- Branch: feat/e-handtekening-fase1
--
-- ⚠ BLOKKEREND voor de module E-handtekening: api/esign.js en api/esign-teken.js
--   lezen en schrijven deze tabellen bij naam. Zonder dit bestand geeft de module
--   een melding "migratie nodig" (503); de rest van het CRM merkt er niets van.
--   Draai óók 2026-11-09-e-handtekening-fase1-bucket.sql.
--
-- Model (envelope-concept):
--   esign_envelopes   1 rij per envelope (status, volgorde, CRM-koppeling, eindbestand)
--   esign_documenten  PDF('s) binnen een envelope (fase 1: precies één)
--   esign_ontvangers  ondertekenaars. soort 'intern' = CRM-profiel (profile_id
--                     verplicht); soort 'extern' = naam + e-mail zonder profiel —
--                     de tabel staat dat NU al toe, de API weigert het in fase 1.
--   esign_velden      velden op de pagina's; positie als FRACTIE (0..1) van de
--                     getoonde pagina, linksboven = (0,0) — onafhankelijk van zoom.
--   esign_events      audit, ALLEEN TOEVOEGEN: een trigger weigert elke UPDATE,
--                     DELETE en TRUNCATE, ook voor de service role.
--
-- Toegang: RLS aan + REVOKE, GEEN policies → alleen de service role (de API, na
-- requirePermission). Zelfde patroon als `scans`.
--
-- Rechten (keuze Jeffrey 9 nov): esign.view + esign.send ALLEEN voor super_admin.
-- super_admin heeft alles impliciet via user_has_permission, dus er komen hier
-- GEEN role_permissions-rijen bij. Iemand anders toevoegen kan per persoon:
--   INSERT INTO public.user_permissions (user_id, feature_key, allowed)
--   VALUES ('<profiles.id>', 'esign.view', true), ('<profiles.id>', 'esign.send', true)
--   ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed = true;
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
-- Geen DO-blokken en geen temp-tabellen (Supabase SQL-editor knipt per statement).
-- ============================================================================

-- ── esign_envelopes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.esign_envelopes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titel                text NOT NULL CHECK (char_length(titel) BETWEEN 1 AND 200),
  bericht              text NULL CHECK (bericht IS NULL OR char_length(bericht) <= 2000),
  status               text NOT NULL DEFAULT 'concept'
                       CHECK (status IN ('concept','verzonden','deels_getekend','voltooid','ingetrokken')),
  volgorde             text NOT NULL DEFAULT 'sequentieel'
                       CHECK (volgorde IN ('sequentieel','parallel')),
  aangemaakt_door      uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Generieke CRM-koppeling (fase 1 in de UI: klant). entiteit_id zonder FK,
  -- zodat later ook onboardings/teamleden/deals kunnen zonder migratie.
  entiteit_type        text NULL CHECK (entiteit_type IS NULL OR entiteit_type IN ('klant','teamlid','onboarding','deal','overig')),
  entiteit_id          uuid NULL,
  verzonden_op         timestamptz NULL,
  voltooid_op          timestamptz NULL,
  ingetrokken_op       timestamptz NULL,
  ingetrokken_door     uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  ingetrokken_reden    text NULL CHECK (ingetrokken_reden IS NULL OR char_length(ingetrokken_reden) <= 500),
  -- Afronden: claim zodat twee gelijktijdige laatste handtekeningen nooit twee
  -- eindversies maken. Leeg = niet bezig; mislukt afronden zet 'm terug op NULL.
  afronden_gestart_op  timestamptz NULL,
  afronden_fout        text NULL,
  eind_pad             text NULL,
  eind_sha256          text NULL CHECK (eind_sha256 IS NULL OR eind_sha256 ~ '^[0-9a-f]{64}$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS esign_envelopes_status_idx    ON public.esign_envelopes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS esign_envelopes_entiteit_idx  ON public.esign_envelopes (entiteit_type, entiteit_id);

-- ── esign_documenten ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.esign_documenten (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id   uuid NOT NULL REFERENCES public.esign_envelopes(id) ON DELETE RESTRICT,
  volgnummer    int  NOT NULL DEFAULT 1 CHECK (volgnummer >= 1),
  naam          text NOT NULL CHECK (char_length(naam) BETWEEN 1 AND 200),
  pad           text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  grootte_bytes bigint NOT NULL CHECK (grootte_bytes > 0),
  -- [{ breedte, hoogte, rotatie, box:{x,y,breedte,hoogte} }] per pagina, in PDF-punten.
  paginas       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id, volgnummer)
);

-- ── esign_ontvangers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.esign_ontvangers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id           uuid NOT NULL REFERENCES public.esign_envelopes(id) ON DELETE RESTRICT,
  volgnummer            int  NOT NULL CHECK (volgnummer >= 1),
  rol                   text NOT NULL DEFAULT 'ondertekenaar' CHECK (rol IN ('ondertekenaar')),
  soort                 text NOT NULL DEFAULT 'intern' CHECK (soort IN ('intern','extern')),
  profile_id            uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Naam + e-mail altijd als momentopname (ook bij intern): het certificaat moet
  -- tonen wie er tekende, ook als het profiel later wijzigt.
  naam                  text NOT NULL CHECK (char_length(naam) BETWEEN 1 AND 200),
  email                 text NOT NULL CHECK (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  status                text NOT NULL DEFAULT 'wacht'
                        CHECK (status IN ('wacht','uitgenodigd','geopend','getekend')),
  -- Alleen de SHA-256 van het token; het token zelf staat nergens.
  token_hash            text NULL UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  token_verloopt_op     timestamptz NULL,
  uitgenodigd_op        timestamptz NULL,
  geopend_op            timestamptz NULL,
  getekend_op           timestamptz NULL,
  handtekening_methode  text NULL CHECK (handtekening_methode IS NULL OR handtekening_methode IN ('getekend','getypt')),
  paraaf_methode        text NULL CHECK (paraaf_methode IS NULL OR paraaf_methode IN ('getekend','getypt')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id, volgnummer),
  CONSTRAINT esign_ontvangers_intern_profiel CHECK (soort <> 'intern' OR profile_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS esign_ontvangers_envelope_idx ON public.esign_ontvangers (envelope_id);
CREATE INDEX IF NOT EXISTS esign_ontvangers_profiel_idx  ON public.esign_ontvangers (profile_id);

-- ── esign_velden ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.esign_velden (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id   uuid NOT NULL REFERENCES public.esign_envelopes(id) ON DELETE RESTRICT,
  document_id   uuid NOT NULL REFERENCES public.esign_documenten(id) ON DELETE RESTRICT,
  ontvanger_id  uuid NOT NULL REFERENCES public.esign_ontvangers(id) ON DELETE RESTRICT,
  type          text NOT NULL CHECK (type IN ('handtekening','paraaf','datum','naam','tekst','checkbox')),
  pagina        int  NOT NULL CHECK (pagina >= 1),
  x             numeric(8,6) NOT NULL CHECK (x >= 0 AND x <= 1),
  y             numeric(8,6) NOT NULL CHECK (y >= 0 AND y <= 1),
  breedte       numeric(8,6) NOT NULL CHECK (breedte > 0 AND breedte <= 1),
  hoogte        numeric(8,6) NOT NULL CHECK (hoogte  > 0 AND hoogte  <= 1),
  verplicht     boolean NOT NULL DEFAULT true,
  -- Ingevuld bij tekenen: tekst / 'ja' / datum, of het storage-pad van het beeld.
  waarde        text NULL CHECK (waarde IS NULL OR char_length(waarde) <= 1000),
  ingevuld_op   timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_velden_binnen_pagina CHECK (x + breedte <= 1.000001 AND y + hoogte <= 1.000001)
);
CREATE INDEX IF NOT EXISTS esign_velden_envelope_idx  ON public.esign_velden (envelope_id);
CREATE INDEX IF NOT EXISTS esign_velden_ontvanger_idx ON public.esign_velden (ontvanger_id);

-- ── esign_events (audit, alleen toevoegen) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.esign_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  envelope_id   uuid NOT NULL REFERENCES public.esign_envelopes(id) ON DELETE RESTRICT,
  ontvanger_id  uuid NULL REFERENCES public.esign_ontvangers(id) ON DELETE RESTRICT,
  type          text NOT NULL CHECK (type IN (
                  'aangemaakt','verzonden','uitgenodigd','opnieuw_verzonden','geopend',
                  'getekend','voltooid','ingetrokken','mail_mislukt','afronden_mislukt')),
  tijdstip      timestamptz NOT NULL DEFAULT now(),
  ip            text NULL,
  user_agent    text NULL,
  -- 'crm_login' (medewerker in het CRM) / 'email_token_link' (ondertekenaar via
  -- de persoonlijke link uit de mail) / 'systeem'.
  methode       text NOT NULL CHECK (methode IN ('crm_login','email_token_link','systeem')),
  actor_id      uuid NULL,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS esign_events_envelope_idx ON public.esign_events (envelope_id, tijdstip);

CREATE OR REPLACE FUNCTION public.esign_events_onveranderlijk()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'esign_events is alleen-toevoegen: % is niet toegestaan', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

DROP TRIGGER IF EXISTS esign_events_geen_wijziging ON public.esign_events;
CREATE TRIGGER esign_events_geen_wijziging
  BEFORE UPDATE OR DELETE ON public.esign_events
  FOR EACH ROW EXECUTE FUNCTION public.esign_events_onveranderlijk();

DROP TRIGGER IF EXISTS esign_events_geen_truncate ON public.esign_events;
CREATE TRIGGER esign_events_geen_truncate
  BEFORE TRUNCATE ON public.esign_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.esign_events_onveranderlijk();

-- updated_at op envelopes
CREATE OR REPLACE FUNCTION public.esign_envelopes_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS esign_envelopes_set_updated_at ON public.esign_envelopes;
CREATE TRIGGER esign_envelopes_set_updated_at
  BEFORE UPDATE ON public.esign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.esign_envelopes_updated_at();

-- ── RLS + REVOKE: alleen de service role ────────────────────────────────────
ALTER TABLE public.esign_envelopes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_documenten ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_ontvangers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_velden     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_events     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.esign_envelopes  FROM anon, authenticated;
REVOKE ALL ON public.esign_documenten FROM anon, authenticated;
REVOKE ALL ON public.esign_ontvangers FROM anon, authenticated;
REVOKE ALL ON public.esign_velden     FROM anon, authenticated;
REVOKE ALL ON public.esign_events     FROM anon, authenticated;

-- ── CONTROLE ────────────────────────────────────────────────────────────────
-- 1. Vijf tabellen, RLS aan:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname LIKE 'esign\_%' AND relkind = 'r' ORDER BY relname;
-- 2. Audit is onveranderlijk (verwacht: fout "alleen-toevoegen"):
--    UPDATE public.esign_events SET type = type WHERE false;   -- 0 rijen, geen fout
--    -- echte test pas als er een event is:
--    -- UPDATE public.esign_events SET details = '{}' WHERE id = (SELECT min(id) FROM public.esign_events);
-- 3. super_admin heeft de rechten (verwacht: true, true):
--    SELECT public.user_has_permission(p.id, 'esign.view'), public.user_has_permission(p.id, 'esign.send')
--      FROM public.profiles p WHERE p.role = 'super_admin' LIMIT 1;

-- ── ROLLBACK (alleen zolang er niets verstuurd is) ──────────────────────────
-- DROP TABLE public.esign_events; DROP TABLE public.esign_velden; DROP TABLE public.esign_ontvangers;
-- DROP TABLE public.esign_documenten; DROP TABLE public.esign_envelopes;
-- DROP FUNCTION public.esign_events_onveranderlijk(); DROP FUNCTION public.esign_envelopes_updated_at();
