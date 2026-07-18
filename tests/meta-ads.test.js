// tests/meta-ads.test.js
//
// Regressietest voor de pure parse-helpers in api/_lib/meta-ads.js. De HTTP-
// calls naar Meta zelf test ik hier NIET — die vereisen een Meta-mock met
// echte tokens. Focus op:
//   - extractLeadsFromActions: leads-actions optellen met configureerbare set.
//   - parseInsightsRow: mapping van Meta-response naar tabelvelden per niveau.
//   - parseEntityRow: mapping van entity naar meta_ad_entities-velden.
//   - computeTimeRange: rollend venster berekening.
// De cron-handler en config-status testen we via de "niet geconfigureerd"-
// pad-guarantees (via de config-helper-shape).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLeadsFromActions,
  parseInsightsRow,
  parseEntityRow,
  computeTimeRange,
  getMetaAdsConfigStatus,
  DEFAULT_LEAD_ACTION_TYPES,
  META_API_VERSION,
} from '../api/_lib/meta-ads.js';

// ─────────────────────────────────────────────────────────────────────────────
// extractLeadsFromActions
// ─────────────────────────────────────────────────────────────────────────────

test('extractLeadsFromActions: null/undefined → null (geen data)', () => {
  assert.equal(extractLeadsFromActions(null, DEFAULT_LEAD_ACTION_TYPES), null);
  assert.equal(extractLeadsFromActions(undefined, DEFAULT_LEAD_ACTION_TYPES), null);
});

test('extractLeadsFromActions: lege array → 0 (data er, geen leads)', () => {
  assert.equal(extractLeadsFromActions([], DEFAULT_LEAD_ACTION_TYPES), 0);
});

test('extractLeadsFromActions: pakt action_type "lead"', () => {
  const actions = [
    { action_type: 'lead',       value: '5' },
    { action_type: 'link_click', value: '100' },
  ];
  assert.equal(extractLeadsFromActions(actions, DEFAULT_LEAD_ACTION_TYPES), 5);
});

test('extractLeadsFromActions: pakt onsite_conversion.lead_grouped', () => {
  const actions = [
    { action_type: 'onsite_conversion.lead_grouped', value: '12' },
    { action_type: 'video_view', value: '500' },
  ];
  assert.equal(extractLeadsFromActions(actions, DEFAULT_LEAD_ACTION_TYPES), 12);
});

test('extractLeadsFromActions: pakt offsite_conversion.fb_pixel_lead', () => {
  const actions = [
    { action_type: 'offsite_conversion.fb_pixel_lead', value: '7' },
  ];
  assert.equal(extractLeadsFromActions(actions, DEFAULT_LEAD_ACTION_TYPES), 7);
});

test('extractLeadsFromActions: telt meerdere lead-types op', () => {
  const actions = [
    { action_type: 'lead',                              value: '3' },
    { action_type: 'onsite_conversion.lead_grouped',    value: '4' },
    { action_type: 'link_click',                        value: '999' },
  ];
  // 3 + 4 = 7
  assert.equal(extractLeadsFromActions(actions, DEFAULT_LEAD_ACTION_TYPES), 7);
});

test('extractLeadsFromActions: custom leadActionTypes overschrijft default', () => {
  const actions = [
    { action_type: 'lead', value: '5' },
    { action_type: 'my.custom.lead', value: '10' },
  ];
  // Alleen my.custom.lead telt.
  assert.equal(extractLeadsFromActions(actions, ['my.custom.lead']), 10);
});

test('extractLeadsFromActions: string-value wordt naar number geparsed', () => {
  const actions = [{ action_type: 'lead', value: '3.5' }];
  assert.equal(extractLeadsFromActions(actions, DEFAULT_LEAD_ACTION_TYPES), 3.5);
});

test('extractLeadsFromActions: onparseable value wordt overgeslagen', () => {
  const actions = [
    { action_type: 'lead', value: 'invalid' },
    { action_type: 'lead', value: '2' },
  ];
  // 'invalid' skipped, alleen 2.
  assert.equal(extractLeadsFromActions(actions, DEFAULT_LEAD_ACTION_TYPES), 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseInsightsRow
// ─────────────────────────────────────────────────────────────────────────────

test('parseInsightsRow: campaign-niveau volledige row', () => {
  const row = {
    campaign_id: '999',
    date_start:  '2026-07-15',
    date_stop:   '2026-07-15',
    spend:       '48.50',
    impressions: '10000',
    clicks:      '250',
    ctr:         '2.5',
    cpc:         '0.194',
    cpm:         '4.85',
    reach:       '8000',
    frequency:   '1.25',
    actions: [
      { action_type: 'lead',       value: '5' },
      { action_type: 'link_click', value: '250' },
    ],
  };
  const parsed = parseInsightsRow(row, { level: 'campaign', leadActionTypes: DEFAULT_LEAD_ACTION_TYPES });
  assert.equal(parsed.entity_meta_id, '999');
  assert.equal(parsed.level, 'campaign');
  assert.equal(parsed.date, '2026-07-15');
  assert.equal(parsed.spend, 48.5);
  assert.equal(parsed.impressions, 10000);
  assert.equal(parsed.clicks, 250);
  assert.equal(parsed.ctr, 2.5);
  assert.equal(parsed.cpc, 0.194);
  assert.equal(parsed.reach, 8000);
  assert.equal(parsed.leads, 5);
  assert.equal(parsed.cost_per_lead, 9.7); // 48.5 / 5
  assert.equal(parsed.actions.length, 2);
});

test('parseInsightsRow: adset gebruikt adset_id, niet campaign_id', () => {
  const row = { adset_id: 'as1', campaign_id: 'c1', date_start: '2026-07-15' };
  const p = parseInsightsRow(row, { level: 'adset' });
  assert.equal(p.entity_meta_id, 'as1');
});

test('parseInsightsRow: ad gebruikt ad_id', () => {
  const row = { ad_id: 'ad1', adset_id: 'as1', campaign_id: 'c1', date_start: '2026-07-15' };
  const p = parseInsightsRow(row, { level: 'ad' });
  assert.equal(p.entity_meta_id, 'ad1');
});

test('parseInsightsRow: leads=0 → cost_per_lead null (geen div/0)', () => {
  const row = {
    campaign_id: 'c1', date_start: '2026-07-15',
    spend: '10.00', actions: [{ action_type: 'link_click', value: '5' }],
  };
  const p = parseInsightsRow(row, { level: 'campaign', leadActionTypes: DEFAULT_LEAD_ACTION_TYPES });
  assert.equal(p.leads, 0);
  assert.equal(p.cost_per_lead, null);
});

test('parseInsightsRow: actions ontbreekt → leads null', () => {
  const row = { campaign_id: 'c1', date_start: '2026-07-15', spend: '10.00' };
  const p = parseInsightsRow(row, { level: 'campaign' });
  assert.equal(p.leads, null);
  assert.equal(p.cost_per_lead, null);
});

test('parseInsightsRow: ontbrekende id of date → null (row overslaan)', () => {
  assert.equal(parseInsightsRow({ date_start: '2026-07-15' }, { level: 'campaign' }), null);
  assert.equal(parseInsightsRow({ campaign_id: 'c1' }, { level: 'campaign' }), null);
});

test('parseInsightsRow: onbekend level → null', () => {
  assert.equal(parseInsightsRow({ campaign_id: 'c1', date_start: '2026-07-15' }, { level: 'foo' }), null);
});

test('parseInsightsRow: null/undefined row → null', () => {
  assert.equal(parseInsightsRow(null, { level: 'campaign' }), null);
  assert.equal(parseInsightsRow(undefined, { level: 'campaign' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseEntityRow
// ─────────────────────────────────────────────────────────────────────────────

test('parseEntityRow: campaign volledig', () => {
  const row = { id: 'c1', name: 'Zomer 2026', effective_status: 'ACTIVE', objective: 'LEAD_GENERATION' };
  const p = parseEntityRow(row, 'campaign');
  assert.equal(p.meta_id, 'c1');
  assert.equal(p.level, 'campaign');
  assert.equal(p.name, 'Zomer 2026');
  assert.equal(p.effective_status, 'ACTIVE');
  assert.equal(p.objective, 'LEAD_GENERATION');
  assert.equal(p.parent_meta_id, null);
  assert.equal(p.campaign_meta_id, null);
});

test('parseEntityRow: adset heeft parent + campaign', () => {
  const row = { id: 'as1', name: 'AS1', effective_status: 'ACTIVE', campaign_id: 'c1' };
  const p = parseEntityRow(row, 'adset');
  assert.equal(p.parent_meta_id, 'c1');
  assert.equal(p.campaign_meta_id, 'c1');
});

test('parseEntityRow: ad heeft parent=adset, campaign_meta_id=campaign', () => {
  const row = { id: 'ad1', name: 'Ad 1', effective_status: 'ACTIVE', adset_id: 'as1', campaign_id: 'c1' };
  const p = parseEntityRow(row, 'ad');
  assert.equal(p.parent_meta_id, 'as1');
  assert.equal(p.campaign_meta_id, 'c1');
});

test('parseEntityRow: ontbrekende id → null', () => {
  assert.equal(parseEntityRow({ name: 'x' }, 'campaign'), null);
});

test('parseEntityRow: onbekend level → null', () => {
  assert.equal(parseEntityRow({ id: 'x' }, 'foo'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// computeTimeRange
// ─────────────────────────────────────────────────────────────────────────────

test('computeTimeRange: 14 dagen inclusief vandaag', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const r = computeTimeRange(14, now);
  assert.equal(r.until, '2026-07-18');
  // since = until - 13 dagen = 2026-07-05
  assert.equal(r.since, '2026-07-05');
});

test('computeTimeRange: 1 dag = alleen vandaag', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const r = computeTimeRange(1, now);
  assert.equal(r.since, '2026-07-18');
  assert.equal(r.until, '2026-07-18');
});

// ─────────────────────────────────────────────────────────────────────────────
// getMetaAdsConfigStatus (env-gated "niet geconfigureerd" pad)
// ─────────────────────────────────────────────────────────────────────────────

test('getMetaAdsConfigStatus: zonder env → configured=false + missing bevat access_token + account_id', () => {
  // Backup + wipe.
  const bak = {
    tok: process.env.META_ADS_ACCESS_TOKEN,
    acc: process.env.META_ADS_ACCOUNT_ID,
    sec: process.env.META_ADS_APP_SECRET,
  };
  delete process.env.META_ADS_ACCESS_TOKEN;
  delete process.env.META_ADS_ACCOUNT_ID;
  delete process.env.META_ADS_APP_SECRET;
  try {
    const s = getMetaAdsConfigStatus();
    assert.equal(s.configured, false);
    assert.ok(s.missing.includes('META_ADS_ACCESS_TOKEN'));
    assert.ok(s.missing.includes('META_ADS_ACCOUNT_ID'));
    assert.equal(s.hasAppSecret, false);
    assert.equal(s.apiVersion, META_API_VERSION);
  } finally {
    if (bak.tok != null) process.env.META_ADS_ACCESS_TOKEN = bak.tok;
    if (bak.acc != null) process.env.META_ADS_ACCOUNT_ID   = bak.acc;
    if (bak.sec != null) process.env.META_ADS_APP_SECRET   = bak.sec;
  }
});

test('getMetaAdsConfigStatus: met env → configured=true', () => {
  const bak = {
    tok: process.env.META_ADS_ACCESS_TOKEN,
    acc: process.env.META_ADS_ACCOUNT_ID,
  };
  process.env.META_ADS_ACCESS_TOKEN = 'test-token';
  process.env.META_ADS_ACCOUNT_ID   = 'act_123';
  try {
    const s = getMetaAdsConfigStatus();
    assert.equal(s.configured, true);
    assert.deepEqual(s.missing, []);
  } finally {
    if (bak.tok == null) delete process.env.META_ADS_ACCESS_TOKEN; else process.env.META_ADS_ACCESS_TOKEN = bak.tok;
    if (bak.acc == null) delete process.env.META_ADS_ACCOUNT_ID;   else process.env.META_ADS_ACCOUNT_ID   = bak.acc;
  }
});

test('DEFAULT_LEAD_ACTION_TYPES bevat de 4 verwachte types', () => {
  assert.ok(DEFAULT_LEAD_ACTION_TYPES.includes('lead'));
  assert.ok(DEFAULT_LEAD_ACTION_TYPES.includes('onsite_conversion.lead_grouped'));
  assert.ok(DEFAULT_LEAD_ACTION_TYPES.includes('offsite_conversion.fb_pixel_lead'));
  assert.ok(DEFAULT_LEAD_ACTION_TYPES.includes('leadgen.other'));
});
