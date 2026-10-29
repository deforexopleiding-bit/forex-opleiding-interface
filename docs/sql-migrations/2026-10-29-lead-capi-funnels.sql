-- ---------------------------------------------------------------------------
-- 2026-10-29 - Meta "Lead"-CAPI voor funnel-opt-ins (opstartsessie + webinar)
--
-- Hoort bij: api/_lib/crm-lead-meta.js, api/public-opstartsessie-book.js,
-- api/public-webinar-aanmelding.js (+ dfo-website-kant die fbp/fbc doorstuurt).
--
-- Handmatig draaien in Supabase (SQL editor). Idempotent. READ-ONLY voor de
-- bestaande data; voegt alleen twee kolommen + een logtabel toe.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1) fbp/fbc op de lead (betere Meta-matchkwaliteit). Nullable; alleen gevuld
--    als nog leeg (crm-lead-meta.js bewaarFbCookies).
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS fbc text;

COMMENT ON COLUMN public.leads.fbp IS 'Meta _fbp-cookie (rauw) voor CAPI-matching; alleen gevuld als nog leeg.';
COMMENT ON COLUMN public.leads.fbc IS 'Meta _fbc-cookie / afgeleid uit fbclid (rauw) voor CAPI-matching; alleen gevuld als nog leeg.';

-- 2) Generieke, NIET-lab-specifieke log voor Lead-events uit de funnel-endpoints.
--    Idempotent op (event_name,event_id): een 'sent'-rij wordt niet opnieuw
--    verstuurd. Spiegelt lab_meta_events, maar los zodat The Lab ongemoeid blijft.
CREATE TABLE IF NOT EXISTS public.meta_lead_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bron          text,          -- funnel-slug / endpoint (opstartsessie, webinar, ...)
  referentie_id text,          -- lead_id
  event_name    text NOT NULL, -- 'Lead'
  event_id      text NOT NULL, -- lead_<lead_id> (dedup-sleutel, gedeeld met de site)
  match_keys    jsonb,         -- welke matchsleutels aanwezig waren (booleans, geen PII)
  status        text NOT NULL, -- 'sent' | 'failed' | 'skipped'
  skip_reason   text,
  meta_response jsonb,
  aangemaakt    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_name, event_id)
);

-- Alleen de service-role (app) schrijft/leest; RLS aan zonder policy sluit de rest uit.
ALTER TABLE public.meta_lead_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.meta_lead_events IS
  'Log van Meta Lead-events uit de CRM-funnel-endpoints (opstartsessie/webinar). Idempotent op (event_name,event_id).';

COMMIT;
