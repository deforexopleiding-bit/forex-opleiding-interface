-- 2026-07-18 — Meta-attributie vastleggen op GHL-leads (fundering voor echte ROAS)
--
-- Fundering-tabel voor sale-to-attribution reconciliatie. Elk GHL-contact
-- dat via een webhook/poll/backfill voorbijkomt krijgt een rij (of update)
-- met de attribution-velden uit contact.attributionSource + .lastAttributionSource.
--
-- STRATEGIE:
--   - PRIMAIRE KOLOMMEN = FIRST-TOUCH (bewaren, NIET overschrijven bij update).
--     Bij een sale later willen we weten via welke campagne de lead
--     ORIGINEEL binnenkwam — dat is doorgaans de ROAS-relevante waarde.
--   - `last_seen_at` bijwerken bij elke sighting.
--   - `raw` jsonb bevat BEIDE attributionSource-objecten (first + last) zodat
--     fase 3 (dashboard) desgewenst last-touch of multi-touch kan uitpakken
--     zonder schema-migratie.
--
-- STAAT LOS VAN DE META-API-KOPPELING: we verzamelen alvast data zodat
-- zodra Meta's API aangesloten is, de ROAS-query historisch dekking heeft.
--
-- ⚠ MIGRATIE NIET BLOKKEREND: de vang-helper is defensief (isMissingTable
-- check → console.warn + skip). Callers (appointment-poll, lisa-webhook)
-- blijven werken zonder de tabel. Best-effort — een fout in de attributie-
-- vangst mag NOOIT de poll/webhook breken.

CREATE TABLE IF NOT EXISTS public.lead_attribution (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_contact_id     text NOT NULL UNIQUE,
  email              text,
  phone              text,

  -- First-touch primaire kolommen (bewaard vanaf de eerste sighting).
  utm_source         text,
  utm_medium         text,
  utm_campaign       text,
  utm_content        text,   -- veelal de advertentie-naam/id
  utm_term           text,
  fbclid             text,
  session_source     text,   -- GHL's "sessionSource" veld
  medium             text,   -- GHL's "medium" veld
  referrer           text,
  landing_url        text,   -- GHL's "url" veld

  -- Timestamps.
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),

  -- Ruwe attributionSource + lastAttributionSource + optionele meta.
  -- Fase 3 (dashboard) kan hieruit last-touch of Meta-specifieke velden
  -- (adId/campaignId/adGroupId) uitpakken zonder schema-migratie.
  raw                jsonb
);

COMMENT ON TABLE  public.lead_attribution IS
  'Meta/UTM/GHL-attributie per GHL-contact. Primaire kolommen = first-touch (niet '
  'overschrijven bij update); last_seen_at bijwerken. Raw bevat volledige '
  'attributionSource + lastAttributionSource objecten voor fase 3 last-touch/multi-touch. '
  'Zie migratie 2026-07-18-lead-attribution.sql + api/_lib/lead-attribution.js.';

COMMENT ON COLUMN public.lead_attribution.utm_content IS
  'GHL "utmContent" — meestal de ADVERTENTIE-naam/id (belangrijk voor ROAS-per-ad).';

-- Indexen voor join en lookup:
CREATE INDEX IF NOT EXISTS idx_lead_attribution_email
  ON public.lead_attribution (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_attribution_phone
  ON public.lead_attribution (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_attribution_utm_campaign
  ON public.lead_attribution (utm_campaign) WHERE utm_campaign IS NOT NULL;

-- Trigger: updated_at spiegelen op last_seen_at (voor consistentie met de rest
-- van de codebase). We doen 't via een simpele trigger die last_seen_at zet
-- bij elke UPDATE — de upsert-helper zet 'em óók expliciet, dus dit is een
-- vangnet voor toekomstige callers.
CREATE OR REPLACE FUNCTION public.trg_lead_attribution_touch()
RETURNS trigger AS $$
BEGIN
  NEW.last_seen_at = now();
  -- First-touch guard: NIET toestaan dat first_seen_at overschreven wordt.
  IF OLD.first_seen_at IS NOT NULL THEN
    NEW.first_seen_at = OLD.first_seen_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lead_attribution_touch ON public.lead_attribution;
CREATE TRIGGER lead_attribution_touch
  BEFORE UPDATE ON public.lead_attribution
  FOR EACH ROW EXECUTE FUNCTION public.trg_lead_attribution_touch();

-- PostgREST schema-cache reloaden (les uit #814 Eddy Delmoitie call_status —
-- zonder deze notify kan de nieuwe tabel 3u lang onzichtbaar zijn voor de
-- REST-API en falen inserts met PGRST205).
NOTIFY pgrst, 'reload schema';

-- Sanity-check: tabel bestaat + heeft de kernkolommen + unique index op ghl_contact_id.
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'lead_attribution'
  AND column_name IN ('ghl_contact_id', 'utm_source', 'utm_campaign', 'utm_content', 'first_seen_at', 'last_seen_at', 'raw')
ORDER BY column_name;
