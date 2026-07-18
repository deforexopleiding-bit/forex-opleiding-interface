// api/_lib/meta-ads.js
//
// Meta Marketing API insights-sync helper. Read-only (ads_read). Gebruikt
// door api/cron-meta-ads-sync.js. Zie migratie 2026-07-18-meta-ads-sync.sql
// voor de tabel-shape.
//
// Env-vars:
//   META_ADS_ACCESS_TOKEN           system-user token met ads_read scope
//   META_ADS_ACCOUNT_ID             ad-account-id (formaat: act_1234567890)
//   META_ADS_APP_SECRET             optioneel — voor appsecret_proof
//                                    (Meta raadt aan bij server-to-server)
//   META_ADS_LEAD_ACTION_TYPES      comma-separated action_types die als
//                                    "lead" tellen. Default: lead,
//                                    onsite_conversion.lead_grouped,
//                                    offsite_conversion.fb_pixel_lead,
//                                    leadgen.other
//   META_ADS_LOOKBACK_DAYS          rollend venster (default 14)
//
// API-versie: v20.0 (consistent met _lib/meta-whatsapp.js).

import { createHmac } from 'node:crypto';
import fetch from 'node-fetch';

const META_API_VERSION = 'v20.0';
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;

// Default leads-action-types. Kan overschreven via env-var. Deze set matcht
// wat de meeste Meta lead-generation setups gebruiken; bij twijfel: raw
// actions blijft opgeslagen dus hertellen is altijd mogelijk.
const DEFAULT_LEAD_ACTION_TYPES = [
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
  'leadgen.other',
];

const DEFAULT_LOOKBACK_DAYS = 14;

class MetaAdsNotConfiguredError extends Error {
  constructor(missing) {
    super(`Meta Ads niet geconfigureerd (ontbrekend: ${missing.join(', ')})`);
    this.name = 'MetaAdsNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Lees env-config. Retourneert null als kritieke keys ontbreken (caller
 * beslist: crash of skip). Voor de sync-engine: skip + log.
 */
export function getMetaAdsConfig() {
  const env = process.env;
  const accessToken = env.META_ADS_ACCESS_TOKEN || null;
  const accountId   = env.META_ADS_ACCOUNT_ID   || null;
  const appSecret   = env.META_ADS_APP_SECRET   || null;
  const leadActionsRaw = env.META_ADS_LEAD_ACTION_TYPES || '';
  const leadActionTypes = leadActionsRaw
    ? leadActionsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_LEAD_ACTION_TYPES.slice();
  const lookbackDaysRaw = Number(env.META_ADS_LOOKBACK_DAYS);
  const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
    ? Math.min(90, Math.floor(lookbackDaysRaw))
    : DEFAULT_LOOKBACK_DAYS;
  return { accessToken, accountId, appSecret, leadActionTypes, lookbackDays };
}

/**
 * Voor UI/health-check: welke env-vars zijn (nog) niet gezet? Sluit aan bij
 * meta-whatsapp.js:getConfigStatus pattern.
 */
export function getMetaAdsConfigStatus() {
  const required = ['META_ADS_ACCESS_TOKEN', 'META_ADS_ACCOUNT_ID'];
  const missing = required.filter((k) => !process.env[k]);
  return {
    configured: missing.length === 0,
    missing,
    // Info-only: welke optionele keys zijn gezet.
    hasAppSecret: !!process.env.META_ADS_APP_SECRET,
    apiVersion:   META_API_VERSION,
  };
}

/**
 * Bereken appsecret_proof: SHA256-HMAC over access_token met app_secret als key.
 * Meta raadt dit aan voor server-to-server calls (verhoogt security als de
 * token lekt). Bij ontbreken van app_secret: skip (Meta accepteert dan zonder).
 */
function computeAppsecretProof(accessToken, appSecret) {
  if (!appSecret) return null;
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * Wrapper rond fetch met Meta's Graph auth + optionele appsecret_proof.
 * Retourneert parsed JSON of gooit een gestructureerde Error met Meta's
 * error-velden erop (net als meta-whatsapp.js).
 *
 * @param {string} path  bijv. '/act_123/campaigns'
 * @param {object} [params]  query-params (worden URL-encoded)
 */
export async function metaAdsFetch(path, params = {}) {
  const cfg = getMetaAdsConfig();
  if (!cfg.accessToken) throw new MetaAdsNotConfiguredError(['META_ADS_ACCESS_TOKEN']);

  const url = new URL(path.startsWith('http') ? path : `${META_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  url.searchParams.set('access_token', cfg.accessToken);
  const proof = computeAppsecretProof(cfg.accessToken, cfg.appSecret);
  if (proof) url.searchParams.set('appsecret_proof', proof);

  const res = await fetch(url.toString(), { method: 'GET' });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = parsed && parsed.error ? parsed.error : null;
    const code    = err?.code ?? res.status;
    const subcode = err?.error_subcode ?? '';
    const msg     = err?.message ?? text.slice(0, 200);
    const fbtrace = err?.fbtrace_id ?? '';
    console.error('[meta-ads] GET failed', {
      path,
      http_status: res.status,
      meta_error:  err,
    });
    const e = new Error(`Meta Ads API ${code}: ${msg} (subcode=${subcode}, fbtrace=${fbtrace})`);
    e.metaCode    = code;
    e.metaSubcode = subcode;
    e.metaMessage = msg;
    e.metaFbtrace = fbtrace;
    e.httpStatus  = res.status;
    throw e;
  }
  return parsed || {};
}

/**
 * Volg alle paginas (paging.next) tot Meta geen 'next' meer geeft. Small delay
 * tussen paginas als rate-limit-hygiene. Retourneert een geconcatte data-array.
 *
 * @param {string} path
 * @param {object} params
 * @param {object} [opts]
 * @param {number} [opts.maxPages]     hard cap (default 20 = ~10.000 rijen bij 500/page)
 * @param {number} [opts.pageDelayMs]  ms tussen paginas (default 100)
 */
export async function metaAdsFetchAll(path, params = {}, opts = {}) {
  const maxPages    = Number.isFinite(opts.maxPages)    ? opts.maxPages    : 20;
  const pageDelayMs = Number.isFinite(opts.pageDelayMs) ? opts.pageDelayMs : 100;
  const out = [];
  let firstResp = await metaAdsFetch(path, { limit: 500, ...params });
  if (Array.isArray(firstResp.data)) out.push(...firstResp.data);
  let next = firstResp?.paging?.next || null;
  let page = 1;
  while (next && page < maxPages) {
    if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
    // next is een volledige URL — geef 'em door met leeg params-object.
    const resp = await metaAdsFetch(next, {});
    if (Array.isArray(resp.data)) out.push(...resp.data);
    next = resp?.paging?.next || null;
    page++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE PARSE-HELPERS (unit-testbaar)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pak een numerieke waarde uit Meta's response. Meta returnt bijna alles als
 * string ("1234.56"). Retourneert null bij ontbreken / niet-parseable.
 */
function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _int(v) {
  const n = _num(v);
  return n == null ? null : Math.trunc(n);
}

/**
 * Extract leads-count uit Meta's actions-array. actions = [{action_type,value}].
 * Somt over de configureerbare set lead-action-types.
 *
 * @param {Array<object>|null|undefined} actions
 * @param {Array<string>} leadActionTypes
 * @returns {number|null}  null als actions ontbreekt; 0 als geen match; anders sum.
 */
export function extractLeadsFromActions(actions, leadActionTypes) {
  if (!Array.isArray(actions)) return null;
  const set = new Set((leadActionTypes || DEFAULT_LEAD_ACTION_TYPES).map((s) => String(s)));
  let total = 0;
  let hadAny = false;
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    if (!set.has(String(a.action_type || ''))) continue;
    const v = _num(a.value);
    if (v != null) { total += v; hadAny = true; }
  }
  // actions is aanwezig maar geen enkele lead-match → 0 (niet null; we weten
  // dat er "iets" gemeten is maar geen leads).
  return hadAny ? total : 0;
}

/**
 * Parse één insights-row → tabelvelden voor meta_insights_daily. Pure function.
 *
 * @param {object} row  Meta's /insights row (spend, impressions, clicks, ctr,
 *                      cpc, cpm, reach, frequency, actions, date_start, etc.)
 * @param {object} opts
 * @param {string} opts.level         'campaign' | 'adset' | 'ad'
 * @param {Array<string>} [opts.leadActionTypes]
 * @returns {object}  { entity_meta_id, level, date, spend, impressions, ...,
 *                      leads, cost_per_lead, actions } of null als row-vorm fout
 */
export function parseInsightsRow(row, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  const level = String(opts.level || '').toLowerCase();
  if (!['campaign', 'adset', 'ad'].includes(level)) return null;

  // ID-veld heeft per level een andere naam in Meta's response.
  const idField = level === 'campaign' ? 'campaign_id'
                : level === 'adset'    ? 'adset_id'
                : 'ad_id';
  const entityMetaId = row[idField] || null;
  const date = row.date_start || null;
  if (!entityMetaId || !date) return null;

  const spend      = _num(row.spend);
  const leadTypes  = opts.leadActionTypes || DEFAULT_LEAD_ACTION_TYPES;
  const leads      = extractLeadsFromActions(row.actions, leadTypes);
  const costPerLead = (spend != null && leads != null && leads > 0)
    ? Number((spend / leads).toFixed(4))
    : null;

  return {
    entity_meta_id: String(entityMetaId),
    level,
    date:           String(date),
    spend,
    impressions:    _int(row.impressions),
    clicks:         _int(row.clicks),
    ctr:            _num(row.ctr),
    cpc:            _num(row.cpc),
    cpm:            _num(row.cpm),
    reach:          _int(row.reach),
    frequency:      _num(row.frequency),
    leads,
    cost_per_lead:  costPerLead,
    actions:        Array.isArray(row.actions) ? row.actions : null,
  };
}

/**
 * Parse een Meta entity-row (campaign/adset/ad) naar meta_ad_entities-velden.
 * @param {object} row
 * @param {string} level  'campaign'|'adset'|'ad'
 */
export function parseEntityRow(row, level) {
  if (!row || typeof row !== 'object') return null;
  const lvl = String(level || '').toLowerCase();
  if (!['campaign', 'adset', 'ad'].includes(lvl)) return null;
  const metaId = row.id || null;
  if (!metaId) return null;

  let parentMetaId   = null;
  let campaignMetaId = null;
  if (lvl === 'adset') {
    parentMetaId   = row.campaign_id || null;
    campaignMetaId = row.campaign_id || null;
  } else if (lvl === 'ad') {
    parentMetaId   = row.adset_id    || null;
    campaignMetaId = row.campaign_id || null;
  }

  return {
    meta_id:          String(metaId),
    level:            lvl,
    name:             row.name || null,
    effective_status: row.effective_status || row.status || null,
    objective:        row.objective || null,
    parent_meta_id:   parentMetaId,
    campaign_meta_id: campaignMetaId,
    raw:              row,
  };
}

/**
 * Compute since/until datums voor de rollende-venster-fetch. Returnt yyyy-mm-dd
 * strings in UTC — Meta's time_range accepteert die.
 */
export function computeTimeRange(lookbackDays, now = new Date()) {
  const ref = now instanceof Date ? now : new Date();
  const util = (d) => d.toISOString().slice(0, 10);
  const until = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  // lookbackDays telt vandaag mee: 1 = alleen vandaag, 14 = vandaag + 13 dagen terug.
  const offset = Math.max(0, (Number(lookbackDays) || 1) - 1);
  const since = new Date(until.getTime() - offset * 86400_000);
  return { since: util(since), until: util(until) };
}

export { MetaAdsNotConfiguredError, META_API_VERSION, META_BASE_URL, DEFAULT_LEAD_ACTION_TYPES };
