-- PROJECT: crm
--
-- 2026-10-15-the-lab-leadmachine.sql — The Lab als leadmachine (fase 1)
--
-- Wat dit doet
-- ------------
-- 1. lab_aanmeldingen — één rij per aanmelding via de Lab-landingspagina
--    (ook een tweede aanmelding van dezelfde persoon: elke "touch" telt, dat is
--    de testmachine voor de advertenties). Bron, hook, UTM's en fbclid/fbc/fbp
--    staan hier — NIET op de lead, want daar zou een tweede aanmelding de eerste
--    overschrijven.
-- 2. lab_meta_events — log van de Conversions API-events (Lead, LabGestart,
--    LabAfgewerkt, Schedule). Unique(event_name, event_id) = idempotentie. De
--    bestaande meta_capi_events kan dit niet dragen: daar is deal_id NOT NULL.
-- 3. lab_opvolging — welke opvolgstap van traject "the-lab" al verstuurd is,
--    per aanmelding. Unique(aanmelding_id, stap, kanaal) = nooit dubbel.
-- 4. booking_sources 'the-lab' — de agendabron, zonder vragenlijst (de
--    kwalificatie zit al in The Lab). Bestaat hij al, dan blijft hij staan.
--
-- Additief en herhaalbaar. Niets wordt verwijderd of overschreven.
-- RLS volgens docs/rls-regels-nieuwe-tabellen.md: staff-only. De publieke
-- endpoints schrijven met de service-role, dus er is GEEN anon-policy nodig.
--
-- De code werkt zolang dit nog niet gedraaid is: de aanmelding valt dan terug
-- op alleen de lead + het LMS-account en logt een waarschuwing.

-- ── Controle VÓÓR ─────────────────────────────────────────────────────────
-- Verwacht: drie keer false, en 0 rijen voor the-lab.
select to_regclass('public.lab_aanmeldingen') is not null as aanmeldingen_bestaat,
       to_regclass('public.lab_meta_events')  is not null as meta_bestaat,
       to_regclass('public.lab_opvolging')    is not null as opvolging_bestaat;
select slug, label, actief, vragenlijst from public.booking_sources where slug = 'the-lab';


-- ── 1. lab_aanmeldingen ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lab_aanmeldingen (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  aangemaakt       timestamptz NOT NULL DEFAULT now(),
  lead_id          uuid,
  email            text        NOT NULL,
  voornaam         text,
  achternaam       text,
  telefoon_e164    text,
  toestemming      boolean     NOT NULL DEFAULT false,
  hook             text,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  utm_content      text,
  utm_term         text,
  landingspagina   text,
  fbclid           text,
  fbc              text,
  fbp              text,
  ip_hash          text,
  user_agent       text,
  -- Wat er gebeurde: nieuw_account | nieuwe_link | al_toegang | lms_fout
  resultaat        text,
  resultaat_detail text,
  lms_auth_id      uuid,
  lms_lead_id      uuid,
  mail_status      text,
  wa_status        text,
  is_test          boolean     NOT NULL DEFAULT false
);

COMMENT ON TABLE public.lab_aanmeldingen IS
  'Aanmeldingen via The Lab-landingspagina (één rij per touch). Zie api/lab-aanmelding.js.';

CREATE INDEX IF NOT EXISTS idx_lab_aanmeldingen_email      ON public.lab_aanmeldingen (lower(email));
CREATE INDEX IF NOT EXISTS idx_lab_aanmeldingen_lead       ON public.lab_aanmeldingen (lead_id);
CREATE INDEX IF NOT EXISTS idx_lab_aanmeldingen_aangemaakt ON public.lab_aanmeldingen (aangemaakt DESC);
CREATE INDEX IF NOT EXISTS idx_lab_aanmeldingen_hook       ON public.lab_aanmeldingen (hook);
CREATE INDEX IF NOT EXISTS idx_lab_aanmeldingen_auth       ON public.lab_aanmeldingen (lms_auth_id);

ALTER TABLE public.lab_aanmeldingen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lab_aanmeldingen_staff ON public.lab_aanmeldingen;
CREATE POLICY lab_aanmeldingen_staff ON public.lab_aanmeldingen
  FOR ALL TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());


-- ── 2. lab_meta_events ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lab_meta_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  aangemaakt     timestamptz NOT NULL DEFAULT now(),
  aanmelding_id  uuid,
  event_name     text        NOT NULL,
  event_id       text        NOT NULL,
  status         text        NOT NULL CHECK (status IN ('sent','failed','skipped')),
  match_keys     jsonb,
  meta_response  jsonb,
  skip_reason    text,
  UNIQUE (event_name, event_id)
);

COMMENT ON TABLE public.lab_meta_events IS
  'Conversions API-log voor The Lab. Geen PII: match_keys bevat alleen booleans.';

ALTER TABLE public.lab_meta_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lab_meta_events_staff ON public.lab_meta_events;
CREATE POLICY lab_meta_events_staff ON public.lab_meta_events
  FOR ALL TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());


-- ── 3. lab_opvolging ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lab_opvolging (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  aangemaakt     timestamptz NOT NULL DEFAULT now(),
  aanmelding_id  uuid        NOT NULL,
  lead_id        uuid,
  stap           text        NOT NULL,
  kanaal         text        NOT NULL CHECK (kanaal IN ('mail','whatsapp')),
  status         text        NOT NULL,   -- verstuurd | fout | droog | overgeslagen
  detail         text,
  UNIQUE (aanmelding_id, stap, kanaal)
);

COMMENT ON TABLE public.lab_opvolging IS
  'Opvolgberichten van traject the-lab (api/cron-lab-opvolging.js). Unique = nooit dubbel.';

ALTER TABLE public.lab_opvolging ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lab_opvolging_staff ON public.lab_opvolging;
CREATE POLICY lab_opvolging_staff ON public.lab_opvolging
  FOR ALL TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());


-- ── 4. De agendabron the-lab ──────────────────────────────────────────────
INSERT INTO public.booking_sources (slug, label, actief, vragenlijst)
VALUES ('the-lab', 'The Lab', true, false)
ON CONFLICT (slug) DO NOTHING;

NOTIFY pgrst, 'reload schema';


-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: drie keer true, drie staff-policies, één bron the-lab zonder vragenlijst.
select to_regclass('public.lab_aanmeldingen') is not null as aanmeldingen_bestaat,
       to_regclass('public.lab_meta_events')  is not null as meta_bestaat,
       to_regclass('public.lab_opvolging')    is not null as opvolging_bestaat;
select tablename, policyname from pg_policies
 where schemaname = 'public' and tablename in ('lab_aanmeldingen','lab_meta_events','lab_opvolging');
select slug, label, actief, vragenlijst from public.booking_sources where slug = 'the-lab';
