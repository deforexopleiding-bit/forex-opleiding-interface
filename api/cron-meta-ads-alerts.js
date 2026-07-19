// api/cron-meta-ads-alerts.js
//
// Cron (uurlijks op :10, na de */30 sync-run). Toetst de gesyncte insights
// aan instelbare regels en zet bij overschrijding een rij in
// public.notifications via createNotification. Read-only op Meta.
//
// Guards (in volgorde):
//   1) checkCronAuth        — Bearer CRON_SECRET.
//   2) env-gate             — getMetaAdsConfigStatus().configured? Zo niet → 200 skip.
//   3) rules-gate           — alle 3 disabled? → 200 skip.
//   4) rollen-gate          — 0 rollen voor ads.module.access → 200 skip.
//   5) tabellen-gate        — isMissingRelationError op meta_ad_entities /
//                             meta_insights_daily → 200 skip (pre-migratie safe).
//
// Dedup: notify.dedupWithinMs = 24u + entityId = meta_ad_entities.id (uuid).
// Zelfde campagne + zelfde alert-type binnen 24u → notify skipt automatisch.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { getMetaAdsConfigStatus } from './_lib/meta-ads.js';
import { createNotification } from './_lib/notify.js';
import { evaluateAlerts, ALERT_DEFAULTS, normalizeRules, shiftYmd } from './_lib/meta-ads-alerts.js';

const ALERTS_SETTINGS_KEY  = 'meta_ads_alert_rules';
const ADS_FEATURE_KEY      = 'ads.module.access';
const DEDUP_MS             = 24 * 60 * 60 * 1000;
const NOTIF_LINK_URL       = '/modules/meta-ads.html';
const NOTIF_ENTITY_TYPE    = 'meta_ads_campaign';

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

// Vandaag NL-lokaal als YMD (consistent met meta-ads-insights.js).
function todayNL() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function touchSyncState(key, summary) {
  try {
    await supabaseAdmin.from('sync_state').upsert({
      key,
      last_run_at: new Date().toISOString(),
      state:       summary,
    }, { onConflict: 'key' });
  } catch (e) {
    if (!isMissingRelationError(e)) {
      console.warn('[cron-meta-ads-alerts] sync_state touch:', e?.message || e);
    }
  }
}

async function loadRules() {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', ALERTS_SETTINGS_KEY)
      .maybeSingle();
    if (error) {
      if (isMissingRelationError(error)) return normalizeRules(null);
      console.warn('[cron-meta-ads-alerts] rules load:', error.message);
      return normalizeRules(null);
    }
    return normalizeRules(data?.value || null);
  } catch (e) {
    console.warn('[cron-meta-ads-alerts] rules exception:', e?.message || e);
    return normalizeRules(null);
  }
}

/**
 * Rollen die 'ads.module.access' hebben. super_admin bypasst permission-check
 * in de DB-functie user_has_permission (zie migratie 002), maar staat niet
 * per se in role_permissions. Voeg 'super_admin' hard toe zodat ze de
 * meldingen wél zien.
 */
async function loadAlertRoles() {
  try {
    const { data, error } = await supabaseAdmin
      .from('role_permissions')
      .select('role')
      .eq('feature_key', ADS_FEATURE_KEY);
    if (error) {
      if (isMissingRelationError(error)) return ['super_admin'];
      console.warn('[cron-meta-ads-alerts] roles load:', error.message);
      return ['super_admin'];
    }
    const roles = new Set((data || []).map((r) => r.role).filter(Boolean));
    roles.add('super_admin');
    return Array.from(roles);
  } catch (e) {
    console.warn('[cron-meta-ads-alerts] roles exception:', e?.message || e);
    return ['super_admin'];
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const summary = {
    started_at: new Date().toISOString(),
    alerts_evaluated: 0,
    alerts_created:   0,
    alerts_deduped:   0,
    by_type:          { meta_ads_cpl_high: 0, meta_ads_no_leads: 0, meta_ads_cost_spike: 0 },
    errors:           [],
  };

  // Env-gate.
  const cfgStatus = getMetaAdsConfigStatus();
  if (!cfgStatus.configured) {
    summary.skipped = 'not_configured';
    summary.missing = cfgStatus.missing;
    return res.status(200).json({ ok: true, summary });
  }

  // Rules-gate.
  const rules = await loadRules();
  if (!rules.cpl_enabled && !rules.no_leads_enabled && !rules.cost_spike_enabled) {
    summary.skipped = 'all_rules_disabled';
    return res.status(200).json({ ok: true, summary });
  }

  // Rollen-gate.
  const roles = await loadAlertRoles();
  if (!roles.length) {
    summary.skipped = 'no_target_roles';
    return res.status(200).json({ ok: true, summary });
  }
  summary.target_roles = roles;

  // Actieve campaign-entities.
  let campaigns;
  try {
    const { data, error } = await supabaseAdmin
      .from('meta_ad_entities')
      .select('id, meta_id, name, effective_status')
      .eq('level', 'campaign')
      .eq('effective_status', 'ACTIVE');
    if (error) {
      if (isMissingRelationError(error)) {
        summary.skipped = 'entities_table_missing';
        return res.status(200).json({ ok: true, summary });
      }
      throw error;
    }
    campaigns = data || [];
  } catch (e) {
    console.error('[cron-meta-ads-alerts] entities load:', e?.message || e);
    summary.errors.push({ phase: 'entities', error: e?.message || String(e) });
    return res.status(500).json({ ok: false, summary });
  }

  if (!campaigns.length) {
    summary.skipped = 'no_active_campaigns';
    return res.status(200).json({ ok: true, summary });
  }
  summary.campaigns_active = campaigns.length;

  // Insights over de laatste 3 dagen (max nodig: gisteren + eergisteren voor
  // spike; no_leads_hours zit typisch onder 72u — 3d dekt beide).
  const today  = todayNL();
  const days   = Math.max(3, Math.ceil((rules.no_leads_hours || 24) / 24) + 1);
  const from   = shiftYmd(today, -(days - 1));
  const metaIds = campaigns.map((c) => c.meta_id);
  let insights;
  try {
    const { data, error } = await supabaseAdmin
      .from('meta_insights_daily')
      .select('entity_meta_id, date, spend, leads')
      .eq('level', 'campaign')
      .gte('date', from)
      .lte('date', today)
      .in('entity_meta_id', metaIds);
    if (error) {
      if (isMissingRelationError(error)) {
        summary.skipped = 'insights_table_missing';
        return res.status(200).json({ ok: true, summary });
      }
      throw error;
    }
    insights = data || [];
  } catch (e) {
    console.error('[cron-meta-ads-alerts] insights load:', e?.message || e);
    summary.errors.push({ phase: 'insights', error: e?.message || String(e) });
    return res.status(500).json({ ok: false, summary });
  }

  const insightsByCampaign = new Map();
  for (const r of insights) {
    if (!insightsByCampaign.has(r.entity_meta_id)) insightsByCampaign.set(r.entity_meta_id, []);
    insightsByCampaign.get(r.entity_meta_id).push({ date: r.date, spend: Number(r.spend || 0), leads: Number(r.leads || 0) });
  }

  const alerts = evaluateAlerts({ campaigns, insightsByCampaign, rules, today });
  summary.alerts_evaluated = alerts.length;

  // Best-effort per alert. Fout bij één slaat de rest niet.
  for (const a of alerts) {
    try {
      const result = await createNotification({
        toRole:         roles,
        type:           a.type,
        title:          a.title,
        body:           a.body,
        linkUrl:        NOTIF_LINK_URL,
        entityType:     NOTIF_ENTITY_TYPE,
        entityId:       a.entity_uuid,
        priority:       a.priority || 'normal',
        dedupWithinMs:  DEDUP_MS,
      });
      if (result.ok && result.count > 0) {
        summary.alerts_created += result.count;
        summary.by_type[a.type] = (summary.by_type[a.type] || 0) + 1;
      } else if (result.ok && result.count === 0) {
        summary.alerts_deduped += 1;
      } else {
        summary.errors.push({ phase: 'notify', meta_id: a.meta_id, type: a.type, error: result.error || 'unknown' });
      }
    } catch (e) {
      summary.errors.push({ phase: 'notify', meta_id: a.meta_id, type: a.type, error: e?.message || String(e) });
    }
  }

  summary.finished_at = new Date().toISOString();
  await touchSyncState('meta_ads_alerts', summary);

  return res.status(200).json({ ok: true, summary });
}

// Re-export defaults zodat de UI ze in sync kan blijven met de backend.
export { ALERT_DEFAULTS };
