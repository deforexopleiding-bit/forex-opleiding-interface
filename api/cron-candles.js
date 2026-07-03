// api/cron-candles.js
//
// Blok B — de "hartslag". Elke 15 min haalt deze cron de nieuwste afgesloten
// H4 + M15-candles voor de 26 cockpit-instrumenten op en schrijft ze bij in
// sa_candles (upsert, ON CONFLICT DO NOTHING). Zo blijft de opgeslagen data
// levend zonder handmatige backfill. GEEN detectie in deze route.
//
// BEVEILIGING (fail-closed): dit is een MACHINE-route, geen owner-gated
// user-route. De bescherming is CRON_SECRET via checkCronAuth (zelfde patroon
// als alle andere crons): ontbrekend secret → 500, verkeerd/afwezig →
// 401, verder niks. Het secret wordt nooit gelogd of geëchood. requireOwner
// is hier NIET van toepassing.
//
// OANDA: base-URL uit OANDA_ENV, Bearer server-side, timeout via
// AbortController — dezelfde stijl als secret-area-oanda.js /
// secret-area-candles.js. Per (instrument,granularity) een kleine fetch
// (count=10) zodat een gemiste tick tot ~9 candles terug alsnog wordt
// ingehaald. 26×2 = 52 kleine fetches met beperkte concurrency; ruim binnen
// de Vercel-tijdslimiet, dus één tick doet H4 én M15 (geen split nodig).
//
// Response: { ok, combos, total_inserted, errors, duration_ms,
//             updated_per_combo } — geen token, geen secret.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const INSTRUMENT_RE     = /^[A-Z]{3}_[A-Z]{3}$/;
const EXTRA_INSTRUMENTS = new Set(['XAU_USD']);
const FETCH_TIMEOUT_MS  = 12000;
const LATEST_COUNT      = 10;   // klein: laatste ~10 candles per combo
const FETCH_CONCURRENCY = 6;    // parallelle OANDA-fetches (ruim onder rate-limit)

// Zelfde 26 instrumenten als de chart-cockpit (OANDA_INSTRUMENTS in
// modules/secret-area.html) en de backfill-status in secret-area-candles.js.
const SA_INSTRUMENTS = [
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD', 'USD_CAD', 'NZD_USD',
  'EUR_GBP', 'EUR_JPY', 'GBP_JPY', 'EUR_CHF', 'AUD_JPY', 'CAD_JPY', 'CHF_JPY',
  'NZD_JPY', 'GBP_CHF', 'GBP_AUD', 'GBP_CAD', 'GBP_NZD', 'EUR_AUD', 'EUR_CAD',
  'EUR_NZD', 'AUD_CAD', 'AUD_CHF', 'AUD_NZD', 'XAU_USD',
];
const SA_GRANS = ['H4', 'M15'];

function isAllowedInstrument(instr) {
  if (!instr || typeof instr !== 'string') return false;
  if (EXTRA_INSTRUMENTS.has(instr)) return true;
  return INSTRUMENT_RE.test(instr);
}

function baseUrlForEnv(env) {
  const v = String(env || '').trim().toLowerCase();
  if (v === 'live')     return 'https://api-fxtrade.oanda.com';
  if (v === 'practice') return 'https://api-fxpractice.oanda.com';
  return null;
}

/** Simpele concurrency-begrenzer. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(n).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Haal de laatste `count` candles voor één instrument+granularity op.
 * Retourneert de rauwe OANDA-candles-array. Gooit bij netwerk/timeout/
 * upstream-fout (caller vangt per-combo af). Token gaat server-side mee en
 * komt nergens in de return terug.
 */
async function fetchLatest(baseUrl, token, instrument, granularity, count) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url = `${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles`
    + `?granularity=${encodeURIComponent(granularity)}`
    + `&count=${count}`
    + `&price=M`;
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      // Alleen de status doorgeven; OANDA echoot ons token niet in bodies,
      // maar we nemen de body sowieso NIET mee in de foutmelding.
      throw new Error('OANDA ' + upstream.status);
    }
    const payload = await upstream.json();
    return Array.isArray(payload?.candles) ? payload.candles : [];
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('OANDA timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Map + filter naar alleen-complete upsert-rijen. */
function toRows(instrument, granularity, rawCandles) {
  return rawCandles
    .filter((c) => c?.complete === true && c?.time && c?.mid)
    .map((c) => ({
      instrument,
      granularity,
      ts      : c.time,
      o       : c.mid.o != null ? Number(c.mid.o) : null,
      h       : c.mid.h != null ? Number(c.mid.h) : null,
      l       : c.mid.l != null ? Number(c.mid.l) : null,
      c       : c.mid.c != null ? Number(c.mid.c) : null,
      volume  : c.volume != null ? Number(c.volume) : null,
      complete: true,
    }));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1) FAIL-CLOSED: alleen door met geldig CRON_SECRET. Missend secret → 500,
  //    verkeerd/afwezig → 401. Het secret wordt hier nooit gelogd.
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  // 2) Config-check. Ontbrekende env → 500, GEEN token-echo.
  const token = process.env.OANDA_API_TOKEN || '';
  const baseUrl = baseUrlForEnv(process.env.OANDA_ENV || '');
  if (!token)   return res.status(500).json({ error: 'OANDA_API_TOKEN ontbreekt (server-config)' });
  if (!baseUrl) return res.status(500).json({ error: 'OANDA_ENV moet practice|live zijn (server-config)' });

  const startedAt = Date.now();
  const combos = [];
  for (const instrument of SA_INSTRUMENTS) {
    for (const granularity of SA_GRANS) combos.push({ instrument, granularity });
  }

  const updated_per_combo = {};
  let total_inserted = 0;
  let errors = 0;

  await mapLimit(combos, FETCH_CONCURRENCY, async ({ instrument, granularity }) => {
    const key = instrument + ':' + granularity;
    try {
      if (!isAllowedInstrument(instrument)) throw new Error('instrument geweigerd');
      const raw = await fetchLatest(baseUrl, token, instrument, granularity, LATEST_COUNT);
      const rows = toRows(instrument, granularity, raw);
      let inserted = 0;
      if (rows.length) {
        const { data, error } = await supabaseAdmin
          .from('sa_candles')
          .upsert(rows, { onConflict: 'instrument,granularity,ts', ignoreDuplicates: true })
          .select('ts');
        if (error) throw new Error('upsert: ' + (error.message || 'db-fout'));
        inserted = Array.isArray(data) ? data.length : 0;
      }
      total_inserted += inserted;
      updated_per_combo[key] = inserted;
    } catch (e) {
      errors++;
      updated_per_combo[key] = null; // null = deze combo faalde deze tick
      // Log alleen de bovenlaag; nooit token/secret.
      console.error('[cron-candles]', key, e?.message || 'fout');
    }
  });

  return res.status(200).json({
    ok: true,
    combos: combos.length,
    total_inserted,
    errors,
    duration_ms: Date.now() - startedAt,
    updated_per_combo,
  });
}
