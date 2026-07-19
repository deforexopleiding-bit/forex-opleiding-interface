-- 2026-07-19 — Backfill lead_attribution.utm_campaign uit raw.<attr>.campaign
--
-- FASE-0 CAPTURE-FIX: api/_lib/lead-attribution.js ATTR_FIELDS.utm_campaign
-- kende alleen de aliassen ['utmCampaign','utm_campaign']. GHL blijkt bij
-- Meta-attributed leads de campagne-id onder key `campaign` te leveren
-- (niet `utmCampaign`) — waardoor utm_campaign NULL bleef en de
-- campagne-fallback in fase-5 ROAS-attributie niet triggerde.
--
-- Deze migratie:
--   1) Vult utm_campaign uit raw.attributionSource.campaign
--      (fallback: raw.lastAttributionSource.campaign) voor rijen waar
--      utm_campaign IS NULL en één van beide raw-paden gevuld is.
--   2) First-touch-preservation blijft intact — we schrijven ALLEEN
--      waar utm_campaign nog NULL is (nieuwe inserts na deze PR gebruiken
--      de bijgewerkte ATTR_FIELDS-alias direct).
--   3) Rapporteert het aantal gevulde rijen als sanity-check.
--
-- Idempotent — herhaald draaien is veilig (WHERE utm_campaign IS NULL).

BEGIN;

WITH updated AS (
  UPDATE public.lead_attribution
  SET    utm_campaign = COALESCE(
           raw->'attributionSource'->>'campaign',
           raw->'lastAttributionSource'->>'campaign'
         )
  WHERE  utm_campaign IS NULL
    AND (raw->'attributionSource'->>'campaign' IS NOT NULL
         OR raw->'lastAttributionSource'->>'campaign' IS NOT NULL)
  RETURNING id
)
SELECT count(*) AS rijen_gevuld FROM updated;

COMMIT;

-- Sanity: totaal rijen met een utm_campaign na de backfill.
SELECT count(*) AS totaal_met_utm_campaign
FROM   public.lead_attribution
WHERE  utm_campaign IS NOT NULL;
