// api/cron-meta-ads-sync.js
//
// Cron: haal Meta Marketing API-insights op (campaign/adset/ad niveau) en
// upsert naar meta_ad_entities + meta_insights_daily. Rollend venster van
// laatste N dagen (default 14) omdat Meta cijfers retroactief bijwerkt
// binnen het attributie-venster.
//
// Sync-strategie:
//   - Sequential per niveau (campaign → adset → ad). Rate-limit-hygiene:
//     kleine sleep tussen paginas.
//   - Best-effort per niveau: een fout in ad-niveau slaat campaign niet.
//   - Upsert idempotent: entities op meta_id UNIQUE, insights op
//     (entity_meta_id, date) UNIQUE.
//   - No-op als ENV niet gezet: log + 200 (matcht patroon van andere
//     env-gated crons).
//   - Defensief pre-migratie: isMissingRelation → skip+warn, GEEN 500.
//
// Cron-registratie: vercel.json */30 * * * *.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import {
  metaAdsFetch,
  metaAdsFetchAll,
  parseInsightsRow,
  parseEntityRow,
  computeTimeRange,
  getMetaAdsConfig,
  getMetaAdsConfigStatus,
} from './_lib/meta-ads.js';

// Insights-fields die we per niveau vragen. Sync met de kolommen in
// meta_insights_daily.
const INSIGHTS_FIELDS = [
  'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm',
  'reach', 'frequency', 'actions', 'cost_per_action_type',
  'date_start', 'date_stop',
  // ID-velden (per level een van deze relevant):
  'campaign_id', 'adset_id', 'ad_id',
].join(',');

// Entity-fields per niveau. name/status/objective — bare essentials.
const ENTITY_FIELDS_BY_LEVEL = {
  campaign: 'id,name,effective_status,objective',
  adset:    'id,name,effective_status,campaign_id',
  ad:       'id,name,effective_status,adset_id,campaign_id',
};

function isMissingRelationError(err) {
  if (!err) return false;
  if (err.code === '42P01' || err.code === '42703') return true;
  if (err.code === 'PGRST204' || err.code === 'PGRST205') return true;
  const msg = String(err.message || '') + ' ' + String(err.details || '') + ' ' + String(err.hint || '');
  return /relation .* does not exist/i.test(msg)
      || /column .* does not exist/i.test(msg)
      || /could not find the/i.test(msg)
      || /schema cache/i.test(msg);
}

/**
 * Haal alle entities op één niveau + upsert naar meta_ad_entities.
 * Retourneert { count, error } (per niveau, best-effort).
 */
async function syncEntitiesForLevel(accountId, level) {
  const endpoint = level === 'campaign' ? `/${accountId}/campaigns`
                 : level === 'adset'    ? `/${accountId}/adsets`
                 : `/${accountId}/ads`;
  const fields = ENTITY_FIELDS_BY_LEVEL[level];
  const rows = await metaAdsFetchAll(endpoint, { fields });
  const parsed = rows.map((r) => parseEntityRow(r, level)).filter(Boolean);
  if (!parsed.length) return { count: 0 };
  const withTs = parsed.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await supabaseAdmin
    .from('meta_ad_entities')
    .upsert(withTs, { onConflict: 'meta_id' });
  if (error) {
    if (isMissingRelationError(error)) {
      return { count: 0, skipped: 'migration_required' };
    }
    throw error;
  }
  return { count: parsed.length };
}

/**
 * Haal alle insights op één niveau over het rollende venster + upsert naar
 * meta_insights_daily.
 */
async function syncInsightsForLevel(accountId, level, timeRange, leadActionTypes) {
  const endpoint = `/${accountId}/insights`;
  const rows = await metaAdsFetchAll(endpoint, {
    level,
    fields:         INSIGHTS_FIELDS,
    time_range:     { since: timeRange.since, until: timeRange.until },
    time_increment: 1,
    // action_attribution_windows default is genoeg voor eerste versie.
  });
  const parsed = rows.map((r) => parseInsightsRow(r, { level, leadActionTypes })).filter(Boolean);
  if (!parsed.length) return { count: 0 };
  const withTs = parsed.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await supabaseAdmin
    .from('meta_insights_daily')
    .upsert(withTs, { onConflict: 'entity_meta_id,date' });
  if (error) {
    if (isMissingRelationError(error)) {
      return { count: 0, skipped: 'migration_required' };
    }
    throw error;
  }
  return { count: parsed.length };
}

/**
 * Update sync_state met laatste succesvolle run per key. Fail-soft: als de
 * tabel niet bestaat, log en ga door.
 */
async function touchSyncState(key, summary) {
  try {
    await supabaseAdmin
      .from('sync_state')
      .upsert({
        key,
        last_run_at: new Date().toISOString(),
        state:       summary,
      }, { onConflict: 'key' });
  } catch (e) {
    if (!isMissingRelationError(e)) {
      console.warn('[cron-meta-ads-sync] sync_state touch:', e?.message || e);
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  // Env-gate: no-op als Meta Ads niet geconfigureerd is. Log + 200 zodat
  // Vercel-cron niet als 'failing' rood kleurt.
  const status = getMetaAdsConfigStatus();
  if (!status.configured) {
    console.log('[cron-meta-ads-sync] SKIP: niet geconfigureerd, missing=', status.missing);
    return res.status(200).json({ ok: true, skipped: 'not_configured', missing: status.missing });
  }

  const cfg = getMetaAdsConfig();
  const accountId = cfg.accountId;
  const timeRange = computeTimeRange(cfg.lookbackDays);
  const summary = {
    started_at: new Date().toISOString(),
    time_range: timeRange,
    lookback_days: cfg.lookbackDays,
    entities:   {},
    insights:   {},
    errors:     [],
  };

  // Sequentieel per niveau — vermindert bursts + maakt best-effort per niveau
  // triviaal (fout in ad-niveau slaat campaign niet).
  for (const level of ['campaign', 'adset', 'ad']) {
    try {
      const r = await syncEntitiesForLevel(accountId, level);
      summary.entities[level] = r;
    } catch (e) {
      console.warn(`[cron-meta-ads-sync] entities ${level}:`, e?.message || e);
      summary.entities[level] = { count: 0, error: e?.message || String(e) };
      summary.errors.push({ phase: 'entities', level, error: e?.message || String(e) });
    }
    try {
      const r = await syncInsightsForLevel(accountId, level, timeRange, cfg.leadActionTypes);
      summary.insights[level] = r;
    } catch (e) {
      console.warn(`[cron-meta-ads-sync] insights ${level}:`, e?.message || e);
      summary.insights[level] = { count: 0, error: e?.message || String(e) };
      summary.errors.push({ phase: 'insights', level, error: e?.message || String(e) });
    }
  }

  summary.finished_at = new Date().toISOString();
  await touchSyncState('meta_ads_sync', summary);

  return res.status(200).json({ ok: true, summary });
}
