// api/finance-dashboard-chart-joost-intents.js
//
// Joost-intents trend over tijd (chart C4 in roadmap).
//
// Aanpak: lees joost_suggestions waar created_at >= NOW() - INTERVAL '30 days'.
// Bucketeer per dag (UTC) per detected_intent. Returnt 1 serie per intent
// met dagelijkse counts (0-vulling voor dagen zonder suggesties zodat de
// Recharts stacked-line geen gaten heeft).
//
// Intents (zelfde enum als joost-suggest DETECTED_INTENTS):
//   - payment_promise
//   - verify_payment
//   - arrangement_request
//   - general_question
//   - escalation_needed
//   - other
//
// Response:
//   {
//     series: [
//       { intent: 'payment_promise', label: 'Betaalbelofte', points: [{ date, count }] },
//       ...
//     ],
//     dates: ['2026-05-11', ..., '2026-06-10'],   // ordered day keys (30 days)
//     totalCount: number,
//     fromCache: boolean,
//   }
//
// RBAC: finance.module.access.
//
// Cache: in-memory SWR ~5min zoals andere chart-endpoints.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

const INTENTS = [
  'payment_promise',
  'verify_payment',
  'arrangement_request',
  'general_question',
  'escalation_needed',
  'other',
];
const INTENT_LABELS = {
  payment_promise:     'Betaalbelofte',
  verify_payment:      'Verify-betaling',
  arrangement_request: 'Arrangement',
  general_question:    'Algemene vraag',
  escalation_needed:   'Escalatie',
  other:               'Overig',
};

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function dayKeyUTC(d) {
  return d.toISOString().slice(0, 10);
}

function buildDayWindow(daysBack) {
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const out = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(todayUtc.getTime() - i * 86400000);
    out.push(dayKeyUTC(d));
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.module.access)' });
  }

  const days = clampInt(req.query?.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const force = String(req.query?.force || '').toLowerCase() === 'true';
  const cacheKey = `days:${days}`;
  if (!force) {
    const hit = _cache.get(cacheKey);
    if (hit && (Date.now() - hit.t) < SWR_TTL_MS) {
      return res.status(200).json({ ...hit.body, fromCache: true });
    }
  }

  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('joost_suggestions')
      .select('id, created_at, detected_intent')
      .gte('created_at', since)
      .not('detected_intent', 'is', null)
      .limit(5000);
    if (error) throw new Error('joost-intents: ' + error.message);

    const dates = buildDayWindow(days);
    const dateIndex = new Map(dates.map((d, i) => [d, i]));

    // intent -> array van counts per dag (zelfde lengte als dates).
    const series = INTENTS.reduce((acc, intent) => {
      acc[intent] = new Array(dates.length).fill(0);
      return acc;
    }, {});

    let total = 0;
    for (const r of (data || [])) {
      const intent = INTENTS.includes(r.detected_intent) ? r.detected_intent : 'other';
      if (!r.created_at) continue;
      const dk = dayKeyUTC(new Date(r.created_at));
      const idx = dateIndex.get(dk);
      if (idx == null) continue;
      series[intent][idx] += 1;
      total += 1;
    }

    const seriesOut = INTENTS.map(intent => ({
      intent,
      label:  INTENT_LABELS[intent],
      points: dates.map((d, i) => ({ date: d, count: series[intent][i] })),
    }));

    const body = {
      series: seriesOut,
      dates,
      totalCount: total,
      fromCache:  false,
    };
    _cache.set(cacheKey, { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-joost-intents]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
