// api/meta-ads-insights.js
//
// GET → aggregatie van meta_insights_daily + join op meta_ad_entities voor het
// Meta Ads dashboard (fase 2). Read-only.
//
// Query-params:
//   range           'today' | '7d' | '30d' | 'month' | 'custom'   (default '7d')
//   from            YYYY-MM-DD  (alleen bij range=custom)
//   to              YYYY-MM-DD  (alleen bij range=custom)
//   level           'campaign' | 'adset' | 'ad'                   (default 'campaign')
//   parent_meta_id  optioneel — filter op adset/ad onder deze parent (drill-down)
//
// Response:
//   {
//     range: {from, to, key},
//     level,
//     totals: {spend, impressions, clicks, ctr, cpc, cpm, reach, leads, cost_per_lead},
//     entities: [{meta_id, name, effective_status, objective, parent_meta_id,
//                 campaign_meta_id, spend, impressions, clicks, ctr, cpc,
//                 leads, cost_per_lead, ...}, ...] (gesorteerd op spend desc),
//     trend: [{date, spend, leads, clicks, impressions}, ...],  // per dag over de range
//     data_available: boolean,   // false als geen enkele rij is gevonden (empty state hint)
//   }
//
// RBAC: ads.module.access (nieuw in deze PR; komt via role_permissions).
// Defensief pre-migratie: als de fase-1-tabellen (nog) niet bestaan → nette
// empty response (data_available: false), geen 500.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = new Set(['campaign', 'adset', 'ad']);

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

// Vandaag NL-lokaal als YMD.
function todayNL() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function firstOfMonth(ymd) {
  const [y, m] = ymd.split('-');
  return `${y}-${m}-01`;
}

/**
 * Resolve een range-shortcut naar concrete {from, to, key} YMD-datums.
 * Alle intervals zijn INCLUSIVE aan beide kanten.
 */
export function resolveRange(query) {
  const key = String(query.range || '7d').toLowerCase();
  const today = todayNL();
  if (key === 'custom') {
    const from = String(query.from || '');
    const to   = String(query.to   || '');
    if (!YMD_RE.test(from) || !YMD_RE.test(to)) {
      throw Object.assign(new Error('Bij range=custom zijn from + to (YYYY-MM-DD) verplicht'), { httpStatus: 400 });
    }
    if (from > to) {
      throw Object.assign(new Error('from mag niet ná to liggen'), { httpStatus: 400 });
    }
    return { from, to, key };
  }
  if (key === 'today')  return { from: today, to: today, key };
  if (key === 'month')  return { from: firstOfMonth(today), to: today, key };
  if (key === '30d')    return { from: shiftYmd(today, -29), to: today, key };
  // Default 7d
  return { from: shiftYmd(today, -6), to: today, key: '7d' };
}

/**
 * Aggregeer rows-array over totalen. Pure function — testbaar.
 * clicks, impressions, spend, leads, reach worden opgeteld; ctr/cpc/cpm
 * worden RECOMPUTED van de sommen (correcter dan een average-of-averages).
 */
export function aggregateTotals(rows) {
  const t = {
    spend: 0, impressions: 0, clicks: 0, reach: 0, leads: 0,
    ctr: null, cpc: null, cpm: null, cost_per_lead: null,
  };
  if (!Array.isArray(rows) || !rows.length) return t;
  for (const r of rows) {
    t.spend       += Number(r.spend || 0);
    t.impressions += Number(r.impressions || 0);
    t.clicks      += Number(r.clicks || 0);
    // reach is geen sum-op-dagen (unieke users kunnen overlappen), maar voor
    // dashboard-v1 tellen we op met een disclaimer in de UI (fase 3 kan
    // exacte reach uit apart Meta-call halen als nodig).
    t.reach       += Number(r.reach || 0);
    t.leads       += Number(r.leads || 0);
  }
  if (t.impressions > 0) t.ctr = Number(((t.clicks / t.impressions) * 100).toFixed(4));
  if (t.clicks      > 0) t.cpc = Number((t.spend / t.clicks).toFixed(4));
  if (t.impressions > 0) t.cpm = Number(((t.spend / t.impressions) * 1000).toFixed(4));
  if (t.leads       > 0) t.cost_per_lead = Number((t.spend / t.leads).toFixed(4));
  return t;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'ads.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (ads.module.access)' });
  }

  // Range + level + parent.
  let range;
  try { range = resolveRange(req.query || {}); }
  catch (e) { return res.status(e.httpStatus || 400).json({ error: e.message }); }
  const level = LEVELS.has(String(req.query.level || '')) ? String(req.query.level) : 'campaign';
  const parentMetaId = req.query.parent_meta_id ? String(req.query.parent_meta_id).trim() : null;

  try {
    // 1) Insights over de range op het gevraagde niveau. Als parent_meta_id
    //    gezet is, filter via een pre-fetch op meta_ad_entities (klein) +
    //    IN-lijst op insights (grote tabel). Dat is efficiënter dan een
    //    join in supabase-js (die vereist een FK).
    let entityIdsFilter = null;
    if (parentMetaId) {
      const { data: kids, error: kErr } = await supabaseAdmin
        .from('meta_ad_entities')
        .select('meta_id')
        .eq('level', level)
        .eq('parent_meta_id', parentMetaId);
      if (kErr) {
        if (isMissingRelationError(kErr)) {
          return res.status(200).json({ range, level, totals: aggregateTotals([]), entities: [], trend: [], data_available: false });
        }
        throw new Error('entities lookup: ' + kErr.message);
      }
      entityIdsFilter = (kids || []).map((r) => r.meta_id);
      if (!entityIdsFilter.length) {
        return res.status(200).json({ range, level, totals: aggregateTotals([]), entities: [], trend: [], data_available: false, parent_meta_id: parentMetaId });
      }
    }

    let insightsQ = supabaseAdmin
      .from('meta_insights_daily')
      .select('entity_meta_id, level, date, spend, impressions, clicks, ctr, cpc, cpm, reach, frequency, leads, cost_per_lead')
      .eq('level', level)
      .gte('date', range.from)
      .lte('date', range.to)
      .limit(10000);
    if (entityIdsFilter) insightsQ = insightsQ.in('entity_meta_id', entityIdsFilter);
    const { data: rows, error: rErr } = await insightsQ;

    if (rErr) {
      if (isMissingRelationError(rErr)) {
        // Pre-migratie: geef nette empty response terug (data_available:false).
        return res.status(200).json({ range, level, totals: aggregateTotals([]), entities: [], trend: [], data_available: false });
      }
      throw new Error('insights fetch: ' + rErr.message);
    }
    const insights = rows || [];

    // 2) Entity-lookup (naam + status) voor de entities die in de insights zitten.
    let entityMap = new Map();
    if (insights.length) {
      const uniqIds = [...new Set(insights.map((r) => r.entity_meta_id))];
      const { data: ents, error: eErr } = await supabaseAdmin
        .from('meta_ad_entities')
        .select('meta_id, name, effective_status, objective, parent_meta_id, campaign_meta_id')
        .in('meta_id', uniqIds);
      if (eErr && !isMissingRelationError(eErr)) {
        console.warn('[meta-ads-insights] entities lookup:', eErr.message);
      } else if (ents) {
        for (const e of ents) entityMap.set(e.meta_id, e);
      }
    }

    // 3) Rollup per entity: som de dagen samen + recompute ratio's.
    const perEntity = new Map();
    for (const r of insights) {
      if (!perEntity.has(r.entity_meta_id)) perEntity.set(r.entity_meta_id, []);
      perEntity.get(r.entity_meta_id).push(r);
    }
    const entities = [];
    for (const [id, group] of perEntity.entries()) {
      const t = aggregateTotals(group);
      const meta = entityMap.get(id) || {};
      entities.push({
        meta_id:          id,
        name:             meta.name || null,
        effective_status: meta.effective_status || null,
        objective:        meta.objective || null,
        parent_meta_id:   meta.parent_meta_id || null,
        campaign_meta_id: meta.campaign_meta_id || null,
        ...t,
      });
    }
    entities.sort((a, b) => (b.spend || 0) - (a.spend || 0));

    // 4) Trend: som per dag over alle entities (voor de grafiek).
    const perDay = new Map();
    for (const r of insights) {
      if (!perDay.has(r.date)) perDay.set(r.date, { date: r.date, spend: 0, leads: 0, clicks: 0, impressions: 0 });
      const d = perDay.get(r.date);
      d.spend       += Number(r.spend || 0);
      d.leads       += Number(r.leads || 0);
      d.clicks      += Number(r.clicks || 0);
      d.impressions += Number(r.impressions || 0);
    }
    const trend = Array.from(perDay.values()).sort((a, b) => a.date.localeCompare(b.date));

    // 5) Totalen over alle rows.
    const totals = aggregateTotals(insights);

    return res.status(200).json({
      range,
      level,
      parent_meta_id: parentMetaId,
      totals,
      entities,
      trend,
      data_available: insights.length > 0,
    });
  } catch (e) {
    console.error('[meta-ads-insights]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
