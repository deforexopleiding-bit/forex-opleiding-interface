-- 2026-07-18 — Meta Ads sync-engine (fase 1: insights → DB)
--
-- Fundering voor het lokaal beschikbaar maken van Meta Marketing API-insights
-- (campagne / ad set / advertentie niveau) zodat dashboard (fase 2) en alerts
-- (fase 3) op snelle, lokale data draaien. Read-only sync — geen write naar
-- Meta. Env-var-gated: no-op als META_ADS_ACCESS_TOKEN ontbreekt.
--
-- STRATEGIE:
--   - meta_ad_entities: één rij per entity (campaign/adset/ad), gejoined op
--     meta_id. Level onderscheidt de laag; parent_meta_id verwijst naar
--     directe ouder (adset->campaign, ad->adset), campaign_meta_id versnelt
--     rollup-queries naar campaign-niveau.
--   - meta_insights_daily: één rij per (entity, dag). Rollend venster van 14
--     dagen wordt bij elke run heropgevraagd (Meta werkt cijfers retroactief
--     bij door attributie-window). UNIQUE (entity_meta_id, date) + upsert =
--     idempotent.
--   - actions jsonb bewaart de raw Meta-actions-array zodat fase 2 kan
--     hertellen als de leads-mapping ooit fout blijkt.
--
-- LEADS-MAPPING: Meta heeft geen unieke action_type voor "lead" — verschilt
-- per ad-setup (lead / onsite_conversion.lead_grouped /
-- offsite_conversion.fb_pixel_lead / leadgen.other). De sync-engine gebruikt
-- env-var META_ADS_LEAD_ACTION_TYPES (comma-separated) met zinnige default,
-- en somt over die set. Bij twijfel: raw jsonb → SQL-query kan hertellen.
--
-- ⚠ MIGRATIE NIET BLOKKEREND: cron-meta-ads-sync is defensief (isMissing-
-- Relation → skip+warn). Zonder migratie draait de cron gewoon door zonder
-- writes -- geen crash.

-- ── ENTITIES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meta_ad_entities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_id            text NOT NULL UNIQUE,
  level              text NOT NULL CHECK (level IN ('campaign', 'adset', 'ad')),
  name               text,
  effective_status   text,
  objective          text,       -- alleen op campaign-niveau meestal gevuld
  parent_meta_id     text,       -- adset->campaign, ad->adset
  campaign_meta_id   text,       -- versnelt rollup queries naar campaign
  raw                jsonb,      -- volledig Meta-entity-object voor fallback
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.meta_ad_entities IS
  'Meta ad-entities (campaign/adset/ad). Één rij per entity, unique op meta_id. '
  'Zie migratie 2026-07-18-meta-ads-sync.sql + api/_lib/meta-ads.js.';

CREATE INDEX IF NOT EXISTS idx_meta_ad_entities_level ON public.meta_ad_entities (level);
CREATE INDEX IF NOT EXISTS idx_meta_ad_entities_parent
  ON public.meta_ad_entities (parent_meta_id) WHERE parent_meta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_ad_entities_campaign
  ON public.meta_ad_entities (campaign_meta_id) WHERE campaign_meta_id IS NOT NULL;

-- ── INSIGHTS DAILY ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meta_insights_daily (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_meta_id     text NOT NULL,
  level              text NOT NULL CHECK (level IN ('campaign', 'adset', 'ad')),
  date               date NOT NULL,
  spend              numeric(14,4),
  impressions        bigint,
  clicks             bigint,
  ctr                numeric(10,6),   -- Meta returnt als string; we casten naar numeric
  cpc                numeric(14,6),
  cpm                numeric(14,6),
  reach              bigint,
  frequency          numeric(10,4),
  leads              integer,          -- afgeleid uit actions[] via LEAD_ACTION_TYPES set
  cost_per_lead      numeric(14,4),    -- afgeleid: spend / NULLIF(leads,0)
  actions            jsonb,            -- raw Meta-actions-array voor fallback + fase 3
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_meta_id, date)
);

COMMENT ON TABLE  public.meta_insights_daily IS
  'Daily Meta insights per entity (unique per entity+date). Rollend venster '
  'van 14 dagen wordt heropgehaald bij elke sync-run. Actions raw bewaard '
  'voor hertelling. Zie api/cron-meta-ads-sync.js.';
COMMENT ON COLUMN public.meta_insights_daily.leads IS
  'Afgeleid uit actions[] met env META_ADS_LEAD_ACTION_TYPES (default: lead, '
  'onsite_conversion.lead_grouped, offsite_conversion.fb_pixel_lead, '
  'leadgen.other). Fase 2 dashboard kan hertellen via actions jsonb.';

CREATE INDEX IF NOT EXISTS idx_meta_insights_daily_level_date
  ON public.meta_insights_daily (level, date DESC);
CREATE INDEX IF NOT EXISTS idx_meta_insights_daily_entity
  ON public.meta_insights_daily (entity_meta_id);
CREATE INDEX IF NOT EXISTS idx_meta_insights_daily_date
  ON public.meta_insights_daily (date DESC);

-- PostgREST schema-cache reload (les uit #814/#820).
NOTIFY pgrst, 'reload schema';

-- Sanity-check: tabellen bestaan + kernkolommen kloppen.
SELECT
  table_name,
  count(*) FILTER (WHERE column_name IN ('meta_id','level','effective_status','parent_meta_id','campaign_meta_id')) AS entity_cols,
  count(*) FILTER (WHERE column_name IN ('entity_meta_id','date','spend','impressions','clicks','leads','actions')) AS insight_cols
FROM information_schema.columns
WHERE table_name IN ('meta_ad_entities', 'meta_insights_daily')
GROUP BY table_name
ORDER BY table_name;
