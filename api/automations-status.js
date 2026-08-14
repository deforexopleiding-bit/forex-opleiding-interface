// api/automations-status.js
//
// Aggregate status van alle automation-motoren + crons + schakelaars, voor
// de v2 Automatiseringen-module (Overzicht-tab).
//
// Response:
//   {
//     ok: true,
//     generated_at: <iso>,
//     motoren: [
//       { key, label, kind:'engine'|'cron', schedule?, endpoint?,
//         enabled: bool|null, last_24h_runs, last_24h_failed, last_run_at,
//         status: 'active'|'idle'|'unknown', protected: bool }
//     ],
//     crons: [ { key, label, schedule, endpoint, source } ],
//     schakelaars: [
//       { key, label, value: any, source, editable: bool, permission?: string }
//     ]
//   }
//
// Geen nep-groen: waar we geen runtime-signaal hebben, status='unknown' met
// bron-verwijzing naar Vercel-dashboard. Dunning is PROTECTED — read-only.

import { readFile } from 'fs/promises';
import path from 'path';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const H24_MS = 24 * 60 * 60 * 1000;

async function _readVercelCrons() {
  try {
    const vercelPath = path.join(process.cwd(), 'vercel.json');
    const raw = await readFile(vercelPath, 'utf-8');
    const j = JSON.parse(raw);
    return Array.isArray(j?.crons) ? j.crons : [];
  } catch (e) {
    console.warn('[automations-status] vercel.json parse fail:', e?.message);
    return [];
  }
}

async function _last24hRuns(table) {
  try {
    const since = new Date(Date.now() - H24_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('id, status, started_at')
      .gte('started_at', since)
      .limit(2000);
    if (error) return { runs: 0, failed: 0, last: null };
    const runs = asArr(data);
    const failed = runs.filter((r) => String(r.status || '').toLowerCase() === 'failed' || String(r.status || '').toLowerCase() === 'error').length;
    const last = runs.reduce((acc, r) => {
      const t = r.started_at ? Date.parse(r.started_at) : 0;
      return (!acc || t > acc) ? t : acc;
    }, 0);
    return { runs: runs.length, failed, last: last ? new Date(last).toISOString() : null };
  } catch (e) {
    console.warn('[automations-status] runs-aggregate ' + table + ' fail:', e?.message);
    return { runs: 0, failed: 0, last: null };
  }
}

function asArr(x) { return Array.isArray(x) ? x : []; }

async function _readAppSetting(key) {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    return { value: data.value, updated_at: data.updated_at };
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  // Perm: mag lezen wie events- OF onboarding-automations mag beheren
  const hasEv = await requirePermission(req, 'events.event.view');
  const hasOn = hasEv ? true : await requirePermission(req, 'onboarding.automation.view');
  if (!hasEv && !hasOn) return res.status(403).json({ error: 'Geen rechten (events.event.view of onboarding.automation.view)' });

  try {
    // 1) Vercel crons parsen
    const vercelCrons = await _readVercelCrons();

    // 2) Runs-aggregates (parallel voor snelheid)
    const [evRuns, obRuns] = await Promise.all([
      _last24hRuns('event_automation_runs'),
      _last24hRuns('onboarding_automation_runs'),
    ]);

    // 3) App-settings toggles
    const env = process.env.VERCEL_ENV || 'development';
    const [lsLive, dunAuto, autoClose] = await Promise.all([
      _readAppSetting('leadsonderhoud_live_' + env),
      _readAppSetting('dunning_pipeline_auto'),
      _readAppSetting('events_signup_auto_close_hours'),
    ]);

    // 4) Bouw motoren-lijst — mix van engines + crons
    const motoren = [
      {
        key: 'events-automations',
        label: 'Events automatiseringen',
        kind: 'engine',
        schedule: '* * * * *',
        endpoint: '/api/cron-events-automations',
        enabled: null,
        last_24h_runs: evRuns.runs,
        last_24h_failed: evRuns.failed,
        last_run_at: evRuns.last,
        status: evRuns.runs > 0 ? 'active' : 'idle',
        protected: false,
      },
      {
        key: 'onboarding-automations',
        label: 'Onboarding automatiseringen',
        kind: 'engine',
        schedule: null,
        endpoint: null,
        enabled: null,
        last_24h_runs: obRuns.runs,
        last_24h_failed: obRuns.failed,
        last_run_at: obRuns.last,
        status: obRuns.runs > 0 ? 'active' : 'idle',
        protected: false,
      },
      {
        key: 'leadsonderhoud',
        label: 'Leadsonderhoud (drip-motor)',
        kind: 'cron',
        schedule: '*/15 * * * *',
        endpoint: '/api/cron-leadsonderhoud',
        enabled: (lsLive?.value && (lsLive.value.enabled === true || lsLive.value === true)) ? true : (lsLive?.value === false || lsLive?.value?.enabled === false ? false : null),
        last_24h_runs: null,
        last_24h_failed: null,
        last_run_at: null,
        status: 'unknown',
        protected: false,
      },
      {
        key: 'lisa',
        label: 'Lisa (AI marketing agent)',
        kind: 'cron',
        schedule: null,
        endpoint: '/api/cron-lisa-delayed',
        enabled: null,
        last_24h_runs: null,
        last_24h_failed: null,
        last_run_at: null,
        status: 'unknown',
        protected: false,
      },
      {
        key: 'wanbetalers',
        label: 'Wanbetalers / Dunning',
        kind: 'engine',
        schedule: '0 9 * * *',
        endpoint: '/api/cron-dunning-engine',
        enabled: null,
        last_24h_runs: null,
        last_24h_failed: null,
        last_run_at: null,
        status: 'unknown',
        protected: true,
      },
    ];

    // 5) Crons (raw uit vercel.json — filter uit protected/dubbel niet, we laten alles zien)
    const crons = vercelCrons.map((c) => ({
      key: (c.path || '').replace(/^\/api\//, '').replace(/[^a-z0-9]+/gi, '-'),
      label: c.path || '—',
      schedule: c.schedule || '—',
      endpoint: c.path || '—',
      source: 'vercel.json',
    }));

    // 6) Schakelaars — expliciet listen; alleen editable via bekende endpoints
    const schakelaars = [
      {
        key: 'leadsonderhoud_live',
        label: 'Leadsonderhoud live (per env: ' + env + ')',
        value: lsLive?.value ?? null,
        source: 'app_settings.' + 'leadsonderhoud_live_' + env,
        editable: true,
        editEndpoint: '/api/leadsonderhoud-instellingen',
        permission: 'leads.view',
      },
      {
        key: 'dunning_pipeline_auto',
        label: 'Wanbetalers pipeline auto-fases',
        value: dunAuto?.value ?? null,
        source: 'app_settings.dunning_pipeline_auto',
        editable: false,
        editEndpoint: '/api/dunning-pipeline-settings',
        permission: 'finance.dunning.execute',
        protectedZone: true,
      },
      {
        key: 'events_signup_auto_close',
        label: 'Events signup auto-close',
        value: autoClose?.value ?? null,
        source: 'app_settings.events_signup_auto_close_hours',
        editable: true,
        editEndpoint: '/api/events-settings-auto-close-update',
        permission: 'events.event.edit',
      },
    ];

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      env,
      motoren,
      crons,
      schakelaars,
    });
  } catch (e) {
    console.error('[automations-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
