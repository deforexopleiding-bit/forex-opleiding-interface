// tests/meta-ads-alerts.test.js
//
// Pure regressietest voor api/_lib/meta-ads-alerts.js. Geen DB / geen HTTP.
// Focus: dat evaluateAlerts() de juiste alert-objecten produceert per regel
// en dat enabled=false een type volledig uitschakelt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAlerts,
  normalizeRules,
  ALERT_DEFAULTS,
  shiftYmd,
} from '../api/_lib/meta-ads-alerts.js';

const TODAY = '2026-07-19';

function makeCampaign(overrides = {}) {
  return {
    id:               '11111111-1111-1111-1111-111111111111',
    meta_id:          '120200000000000001',
    name:             'Testcampagne',
    effective_status: 'ACTIVE',
    ...overrides,
  };
}

function insightsMap(entries) {
  const m = new Map();
  for (const [metaId, rows] of entries) m.set(metaId, rows);
  return m;
}

// ─── normalizeRules ────────────────────────────────────────────────────────

test('normalizeRules: null → defaults', () => {
  const r = normalizeRules(null);
  assert.deepEqual(r, ALERT_DEFAULTS);
});

test('normalizeRules: onbekende types → defaults blijven', () => {
  const r = normalizeRules({ cpl_threshold_eur: 'foo', no_leads_hours: -5 });
  assert.equal(r.cpl_threshold_eur, ALERT_DEFAULTS.cpl_threshold_eur);
  assert.equal(r.no_leads_hours,    ALERT_DEFAULTS.no_leads_hours);
});

test('normalizeRules: valide numeric override werkt', () => {
  const r = normalizeRules({ cpl_threshold_eur: 20, cost_spike_pct: 25 });
  assert.equal(r.cpl_threshold_eur, 20);
  assert.equal(r.cost_spike_pct,    25);
});

// ─── shiftYmd ──────────────────────────────────────────────────────────────

test('shiftYmd: −1 dag', () => {
  assert.equal(shiftYmd('2026-07-19', -1), '2026-07-18');
  assert.equal(shiftYmd('2026-03-01', -1), '2026-02-28');
});

// ─── evaluateAlerts — CPL ─────────────────────────────────────────────────

test('CPL: triggert boven drempel, leads>0', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 100, leads: 2 }, // CPL = 50
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_threshold_eur: 35, cost_spike_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'meta_ads_cpl_high');
  assert.equal(alerts[0].entity_uuid, '11111111-1111-1111-1111-111111111111');
  assert.equal(alerts[0].details.cpl, 50);
});

test('CPL: geen alert onder drempel', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 100, leads: 5 }, // CPL = 20
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_threshold_eur: 35, cost_spike_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

test('CPL: leads=0 → geen CPL-alert (divide-by-zero guard)', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 100, leads: 0 },
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_threshold_eur: 35, cost_spike_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

test('CPL: enabled=false → geen alert ook al is drempel overschreden', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 100, leads: 2 },
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_enabled: false, cost_spike_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

// ─── evaluateAlerts — no-leads ─────────────────────────────────────────────

test('no-leads: spend>0 én 0 leads over venster → alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 40, leads: 0 },
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, no_leads_hours: 24, cpl_enabled: false, cost_spike_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'meta_ads_no_leads');
});

test('no-leads: leads>0 → geen alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 40, leads: 1 },
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_enabled: false, cost_spike_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

test('no-leads: spend=0 → geen alert (campagne niet lopend in venster)', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', []],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_enabled: false, cost_spike_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

test('no-leads: enabled=false → geen alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 40, leads: 0 },
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, no_leads_enabled: false, cpl_enabled: false, cost_spike_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

// ─── evaluateAlerts — cost-spike ───────────────────────────────────────────

test('cost-spike: +50% dag-op-dag boven min_spend → alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-17', spend: 100, leads: 3 }, // eergisteren
        { date: '2026-07-18', spend: 160, leads: 4 }, // gisteren = +60%
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cost_spike_pct: 40, cost_spike_min_spend_eur: 50, cpl_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'meta_ads_cost_spike');
  assert.equal(alerts[0].details.spend_yesterday, 160);
  assert.equal(alerts[0].details.spend_day_before, 100);
});

test('cost-spike: onder min_spend → geen alert (anti-ruis)', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-17', spend: 5,  leads: 0 },
        { date: '2026-07-18', spend: 20, leads: 0 }, // +300% maar spendY < 50
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cost_spike_pct: 40, cost_spike_min_spend_eur: 50, cpl_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  const spike = alerts.filter((a) => a.type === 'meta_ads_cost_spike');
  assert.equal(spike.length, 0);
});

test('cost-spike: onder pct-drempel → geen alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-17', spend: 100, leads: 3 },
        { date: '2026-07-18', spend: 110, leads: 3 }, // +10%
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cost_spike_pct: 40, cost_spike_min_spend_eur: 50, cpl_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  const spike = alerts.filter((a) => a.type === 'meta_ads_cost_spike');
  assert.equal(spike.length, 0);
});

test('cost-spike: enabled=false → geen alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-17', spend: 100, leads: 3 },
        { date: '2026-07-18', spend: 300, leads: 3 },
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cost_spike_enabled: false, cpl_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

test('cost-spike: eergisteren=0 → geen alert (division-by-zero guard)', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-18', spend: 200, leads: 2 }, // gisteren, geen 07-17 row
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cost_spike_pct: 40, cost_spike_min_spend_eur: 50, cpl_enabled: false, no_leads_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.filter((a) => a.type === 'meta_ads_cost_spike').length, 0);
});

// ─── entity-status filter ──────────────────────────────────────────────────

test('effective_status !== ACTIVE → geen enkele alert', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign({ effective_status: 'PAUSED' })],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-17', spend: 100, leads: 3 },
        { date: '2026-07-18', spend: 300, leads: 0 }, // triggert 3 regels tegelijk
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_threshold_eur: 10 },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});

// ─── dedup-key-shape ───────────────────────────────────────────────────────

test('alert bevat entity_uuid (uuid) + type — bruikbaar voor notify-dedup', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign({ id: 'aa11-...' })],  // uuid-shape validatie doet notify.js zelf
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-19', spend: 100, leads: 1 }, // CPL 100
      ]],
    ]),
    rules: { ...ALERT_DEFAULTS, cpl_threshold_eur: 35, no_leads_enabled: false, cost_spike_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].entity_uuid);
  assert.ok(alerts[0].type);
  assert.equal(typeof alerts[0].title, 'string');
});

// ─── alle 3 uitgeschakeld ──────────────────────────────────────────────────

test('alle rules disabled → nooit alerts, ook niet met slechte data', () => {
  const alerts = evaluateAlerts({
    campaigns:          [makeCampaign()],
    insightsByCampaign: insightsMap([
      ['120200000000000001', [
        { date: '2026-07-17', spend: 100, leads: 1 },
        { date: '2026-07-18', spend: 999, leads: 0 },
        { date: '2026-07-19', spend: 999, leads: 0 },
      ]],
    ]),
    rules: { cpl_enabled: false, no_leads_enabled: false, cost_spike_enabled: false },
    today: TODAY,
  });
  assert.equal(alerts.length, 0);
});
