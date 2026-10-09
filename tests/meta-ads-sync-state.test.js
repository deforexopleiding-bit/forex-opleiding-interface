// tests/meta-ads-sync-state.test.js
//
// cron-meta-ads-sync + cron-meta-ads-alerts schreven hun status naar
// sync_state met kolom `key` (+ jsonb `state`). De tabel heeft PK `resource`
// en vaste kolommen (docs/sql-migrations/2026-06-06-finance-sync-state.sql);
// de upsert faalde stil (supabase-js gooit niet, isMissingRelationError slikt
// 42703). Nu: echte kolommen, en een fout van de upsert wordt gelogd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

// Kolommen van sync_state volgens de migratie.
const KOLOMMEN = ['resource', 'last_updated_since', 'last_run_at', 'last_run_processed',
  'last_run_errors', 'last_run_duration_ms', 'created_at', 'updated_at'];

function nepAdmin({ syncStateFout = null } = {}) {
  const upserts = [];
  return {
    upserts,
    from(tabel) {
      return {
        upsert: async (rij, opts) => {
          upserts.push({ tabel, rij, opts });
          if (tabel === 'sync_state' && syncStateFout) return { data: null, error: syncStateFout };
          return { data: null, error: null };
        },
      };
    },
  };
}

test('runAdsSync: status naar sync_state met de echte kolommen (resource, geen key/state)', async () => {
  const admin = nepAdmin();
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: admin, checkCronAuth: () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/meta-ads.js'), {
    namedExports: {
      metaAdsFetch: async () => ({}),
      // Entities: 1 rij per niveau; insights: 2 rijen per niveau.
      metaAdsFetchAll: async (endpoint) => (endpoint.endsWith('/insights') ? [{}, {}] : [{}]),
      parseInsightsRow: (_r, { level }) => ({ entity_meta_id: level, date: '2026-10-09' }),
      parseEntityRow: (_r, level) => ({ meta_id: level }),
      computeTimeRange: () => ({ since: '2026-09-26', until: '2026-10-09' }),
      getMetaAdsConfig: () => ({ accountId: 'act_1', leadActionTypes: ['lead'], lookbackDays: 14 }),
      getMetaAdsConfigStatus: () => ({ configured: true, missing: [] }),
    },
  });
  const { runAdsSync } = await import(url('api/cron-meta-ads-sync.js') + '?t=' + Date.now());
  const r = await runAdsSync();
  assert.equal(r.ok, true);

  const s = admin.upserts.filter((u) => u.tabel === 'sync_state');
  assert.equal(s.length, 1);
  const { rij, opts } = s[0];
  assert.deepEqual(opts, { onConflict: 'resource' });
  assert.equal(rij.resource, 'meta_ads_sync');
  for (const k of Object.keys(rij)) assert.ok(KOLOMMEN.includes(k), `onbekende kolom ${k}`);
  assert.equal(rij.last_updated_since, r.summary.started_at, 'NOT NULL-kolom gevuld');
  assert.equal(rij.last_run_at, r.summary.started_at);
  assert.equal(rij.last_run_processed, 6, '2 insights-rijen × 3 niveaus');
  assert.equal(rij.last_run_errors, 0);
  assert.equal(typeof rij.last_run_duration_ms, 'number');
  mock.reset();
});

test('runAdsSync: een fout van de sync_state-upsert wordt gelogd, ook 42703', async () => {
  const admin = nepAdmin({ syncStateFout: { code: '42703', message: 'column sync_state.x does not exist' } });
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: admin, checkCronAuth: () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/meta-ads.js'), {
    namedExports: {
      metaAdsFetch: async () => ({}),
      metaAdsFetchAll: async () => [],
      parseInsightsRow: () => null,
      parseEntityRow: () => null,
      computeTimeRange: () => ({ since: '2026-09-26', until: '2026-10-09' }),
      getMetaAdsConfig: () => ({ accountId: 'act_1', leadActionTypes: ['lead'], lookbackDays: 14 }),
      getMetaAdsConfigStatus: () => ({ configured: true, missing: [] }),
    },
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const { runAdsSync } = await import(url('api/cron-meta-ads-sync.js') + '?t=' + Date.now());
    const r = await runAdsSync();
    assert.equal(r.ok, true, 'fail-soft: de sync zelf slaagt');
  } finally {
    console.warn = origWarn;
    mock.reset();
  }
  assert.ok(warns.some((w) => w.includes('[cron-meta-ads-sync] sync_state touch:') && w.includes('does not exist')));
});

test('cron-meta-ads-alerts: zelfde kolommen, geen key/state meer', () => {
  const src = readFileSync(join(ROOT, 'api/cron-meta-ads-alerts.js'), 'utf8');
  const blok = src.slice(src.indexOf('async function touchSyncState'), src.indexOf('async function loadRules'));
  assert.match(blok, /\{ onConflict: 'resource' \}/);
  assert.match(blok, /last_updated_since:\s+summary\.started_at/);
  assert.match(blok, /if \(error\) console\.warn\('\[cron-meta-ads-alerts\] sync_state touch:'/);
  assert.doesNotMatch(blok, /\bkey,|state:|onConflict: 'key'/);
  assert.match(src, /await touchSyncState\('meta_ads_alerts', summary\);/);
});
