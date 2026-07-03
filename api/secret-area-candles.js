// api/secret-area-candles.js
//
// Blok B / stap 3 — candle-OPSLAG + handmatige BACKFILL.
//
// Slaat OANDA-candles (H4 + M15) op in sa_candles voor de chart-cockpit-
// instrumenten, historie vanaf 2025-01-01. Deze PR levert ALLEEN de opslag
// + een handmatige, timeout-veilige backfill; er is GEEN cron (die komt
// apart). De frontend roept per (instrument,granularity) herhaald
// action='backfill_chunk' aan met from=lastTs tot done=true.
//
// Owner-gated (Secret Area) — requireOwner ALS EERSTE, 403 bij null. Token
// blijft server-side; nooit gelogd, nooit in een response geëchoed. SSRF-
// hygiëne identiek aan secret-area-oanda.js: instrument + granularity tegen
// strikte allowlist, en 'from' wordt naar epoch-seconds gevalideerd en pas
// dán deterministisch als RFC3339 UTC-string doorgestuurd — nooit een ruwe
// user-string in de URL.
//
// Acties:
//   action='backfill_chunk' { instrument, granularity, from? }
//     - Haal ÉÉN OANDA-batch (count=5000, price=M) op vanaf 'from' vooruit.
//     - Sla ALLEEN complete candles op (upsert, ON CONFLICT DO NOTHING).
//     - Return { ok, instrument, granularity, inserted, lastTs, done }.
//       done=true als de batch < 5000 candles teruggaf (einde/nu bereikt).
//       Anders geeft de frontend 'lastTs' mee als volgende 'from'.
//   action='status'  (ook default op GET)
//     - Per instrument+granularity: count + min(ts)/max(ts) in sa_candles.
//
// Responses: 200 ok · 400 validatie · 403 owner-gate · 405 method ·
//            500 server-config (OANDA_* ontbreekt) · 502 OANDA upstream.

import { requireOwner } from './_lib/secretArea.js';
import { supabaseAdmin } from './supabase.js';

// ── Allowlists / limieten ──────────────────────────────────────────────
const INSTRUMENT_RE     = /^[A-Z]{3}_[A-Z]{3}$/;
const EXTRA_INSTRUMENTS = new Set(['XAU_USD']);       // metaal — buiten FX-paar regex
const ALLOWED_GRAN      = new Set(['H4', 'M15']);     // deze PR: alleen H4 + M15
const BATCH_COUNT       = 5000;                        // OANDA hard plafond per call
const FETCH_TIMEOUT_MS  = 15000;
// Strikte RFC3339 UTC — geen offset, alleen 'Z'. Optionele fractionele seconden.
const RFC3339_UTC_RE    = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// Sanity-window voor epoch-seconds: 2003-01-01 .. 2100-01-01.
const EPOCH_MIN         = 1041379200;  // 2003-01-01T00:00:00Z
const EPOCH_MAX         = 4102444800;  // 2100-01-01T00:00:00Z
// Default-startpunt van de backfill.
const DEFAULT_FROM_SEC  = Math.floor(Date.UTC(2025, 0, 1, 0, 0, 0) / 1000); // 2025-01-01

// Instrument-lijst voor de STATUS-enumeratie. Spiegelt OANDA_INSTRUMENTS in
// modules/secret-area.html (de chart-cockpit-lijst). Validatie van
// backfill-input gebeurt via de regex-allowlist hierboven, niet via deze
// lijst, zodat de twee onafhankelijk kunnen zijn.
const SA_INSTRUMENTS = [
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD', 'USD_CAD', 'NZD_USD',
  'EUR_GBP', 'EUR_JPY', 'GBP_JPY', 'EUR_CHF', 'AUD_JPY', 'CAD_JPY', 'CHF_JPY',
  'NZD_JPY', 'GBP_CHF', 'GBP_AUD', 'GBP_CAD', 'GBP_NZD', 'EUR_AUD', 'EUR_CAD',
  'EUR_NZD', 'AUD_CAD', 'AUD_CHF', 'AUD_NZD', 'XAU_USD',
];
const SA_GRANS = ['H4', 'M15'];

// ── Validatie-helpers (identiek van vorm aan secret-area-oanda.js) ──────
function isAllowedInstrument(instr) {
  if (!instr || typeof instr !== 'string') return false;
  if (EXTRA_INSTRUMENTS.has(instr)) return true;
  return INSTRUMENT_RE.test(instr);
}

function baseUrlForEnv(env) {
  const v = String(env || '').trim().toLowerCase();
  if (v === 'live')     return 'https://api-fxtrade.oanda.com';
  if (v === 'practice') return 'https://api-fxpractice.oanda.com';
  return null; // onbekende / lege env → caller faalt met 500 config-fout
}

/**
 * Parseer + valideer 'from' naar epoch-seconds (int). Afwezig → default
 * (2025-01-01). Gooit 'invalid' voor onbekende/afwijkende formaten. De
 * originele string wordt NOOIT teruggegeven; caller bouwt de URL uit het int.
 */
function parseFrom(raw) {
  if (raw == null || raw === '') return DEFAULT_FROM_SEC;
  const s = String(raw).trim();
  if (!s) return DEFAULT_FROM_SEC;
  // Case A: puur numeriek → epoch-seconds.
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error('invalid');
    if (n < EPOCH_MIN || n > EPOCH_MAX) throw new Error('invalid');
    return Math.floor(n);
  }
  // Case B: strict RFC3339 UTC.
  if (RFC3339_UTC_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error('invalid');
    const n = Math.floor(ms / 1000);
    if (n < EPOCH_MIN || n > EPOCH_MAX) throw new Error('invalid');
    return n;
  }
  throw new Error('invalid');
}

/** epoch-seconds → RFC3339 UTC-string zonder ms (formaat dat OANDA slikt). */
function epochToRfc3339(sec) {
  return new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Simpele concurrency-begrenzer voor de status-queries. */
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

// ── STATUS ──────────────────────────────────────────────────────────────
async function handleStatus(res) {
  const combos = [];
  for (const instrument of SA_INSTRUMENTS) {
    for (const granularity of SA_GRANS) combos.push({ instrument, granularity });
  }

  try {
    const rows = await mapLimit(combos, 6, async ({ instrument, granularity }) => {
      const [countRes, minRes, maxRes] = await Promise.all([
        supabaseAdmin.from('sa_candles')
          .select('ts', { count: 'exact', head: true })
          .eq('instrument', instrument).eq('granularity', granularity),
        supabaseAdmin.from('sa_candles')
          .select('ts').eq('instrument', instrument).eq('granularity', granularity)
          .order('ts', { ascending: true }).limit(1).maybeSingle(),
        supabaseAdmin.from('sa_candles')
          .select('ts').eq('instrument', instrument).eq('granularity', granularity)
          .order('ts', { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (countRes.error) throw countRes.error;
      return {
        instrument,
        granularity,
        count: countRes.count || 0,
        minTs: minRes.data?.ts || null,
        maxTs: maxRes.data?.ts || null,
      };
    });

    const total = rows.reduce((a, r) => a + r.count, 0);
    return res.status(200).json({ ok: true, total, rows });
  } catch (e) {
    console.error('[secret-area-candles] status fail:', e?.message || e);
    return res.status(500).json({ error: 'Status ophalen mislukt' });
  }
}

// ── BACKFILL CHUNK ────────────────────────────────────────────────────────
async function handleBackfillChunk(res, params) {
  // 1) Config-check. Ontbrekende env → 500, GEEN token-echo in error-text.
  const token = process.env.OANDA_API_TOKEN || '';
  const baseUrl = baseUrlForEnv(process.env.OANDA_ENV || '');
  if (!token)   return res.status(500).json({ error: 'OANDA_API_TOKEN ontbreekt (server-config)' });
  if (!baseUrl) return res.status(500).json({ error: 'OANDA_ENV moet practice|live zijn (server-config)' });

  // 2) Strikte input-validatie — geen vrije user-input naar externe URL.
  const instrument = typeof params.instrument === 'string' && params.instrument.trim()
    ? params.instrument.trim().toUpperCase()
    : '';
  if (!isAllowedInstrument(instrument)) {
    return res.status(400).json({ error: 'instrument niet toegestaan (^[A-Z]{3}_[A-Z]{3}$ of XAU_USD)' });
  }
  const granularity = typeof params.granularity === 'string' && params.granularity.trim()
    ? params.granularity.trim().toUpperCase()
    : '';
  if (!ALLOWED_GRAN.has(granularity)) {
    return res.status(400).json({ error: 'granularity moet H4 of M15 zijn' });
  }
  let fromSec;
  try {
    fromSec = parseFrom(params.from);
  } catch (_) {
    return res.status(400).json({
      error: 'from ongeldig: gebruik epoch-seconds of RFC3339 UTC (YYYY-MM-DDTHH:MM:SSZ)',
    });
  }

  // 3) Externe call — timeout via AbortController. Gedetermineerde RFC3339-
  //    string in de URL; nooit de rauwe input. OANDA v20: 'from' + 'count'
  //    → count candles die beginnen op/na 'from', oplopend.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url = `${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles`
    + `?granularity=${encodeURIComponent(granularity)}`
    + `&count=${BATCH_COUNT}`
    + `&price=M`
    + `&from=${encodeURIComponent(epochToRfc3339(fromSec))}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError' ? 'OANDA timeout' : 'OANDA netwerkfout';
    console.error('[secret-area-candles] fetch fail:', msg);
    return res.status(502).json({ error: msg, status: null });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    let bodySnippet = '';
    try { bodySnippet = String((await upstream.text()) || '').slice(0, 200); } catch (_) {}
    console.error('[secret-area-candles] upstream', upstream.status);
    return res.status(502).json({ error: 'OANDA fout', status: upstream.status, detail: bodySnippet || null });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch (_) {
    console.error('[secret-area-candles] parse fail');
    return res.status(502).json({ error: 'OANDA response geen JSON' });
  }

  const rawCandles = Array.isArray(payload?.candles) ? payload.candles : [];
  // done zodra de batch NIET vol was → einde historie / bij 'nu' aangekomen.
  const done = rawCandles.length < BATCH_COUNT;
  // Cursor voor de volgende chunk: de laatste (nieuwste) candle-tijd uit de
  // rauwe batch (ook als die incompleet is), zodat de frontend altijd
  // vooruit blijft paginéren. Boundary-candle wordt door de upsert
  // gededupliceerd.
  const lastTs = rawCandles.length
    ? (rawCandles[rawCandles.length - 1]?.time || null)
    : null;

  // Alleen COMPLETE candles opslaan.
  const rows = rawCandles
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

  let inserted = 0;
  if (rows.length) {
    // ON CONFLICT (instrument,granularity,ts) DO NOTHING via ignoreDuplicates.
    // .select() geeft alleen de ECHT nieuw-geïnserte rijen terug → exacte
    // inserted-telling zonder dubbeltelling van reeds opgeslagen candles.
    const { data, error } = await supabaseAdmin
      .from('sa_candles')
      .upsert(rows, { onConflict: 'instrument,granularity,ts', ignoreDuplicates: true })
      .select('ts');
    if (error) {
      console.error('[secret-area-candles] upsert fail:', error.message || error);
      return res.status(500).json({ error: 'Opslaan mislukt' });
    }
    inserted = Array.isArray(data) ? data.length : 0;
  }

  return res.status(200).json({ ok: true, instrument, granularity, inserted, lastTs, done });
}

// ── Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // 1) Owner-gate ALS EERSTE.
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  // 2) Actie + params bepalen. GET default = status; POST = actie in body.
  let action;
  let params = {};
  if (req.method === 'GET') {
    action = (req.query && typeof req.query.action === 'string' && req.query.action) || 'status';
  } else if (req.method === 'POST') {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    action = typeof body.action === 'string' ? body.action : '';
    params = body;
  } else {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET of POST' });
  }

  if (action === 'status')         return handleStatus(res);
  if (action === 'backfill_chunk') return handleBackfillChunk(res, params);
  return res.status(400).json({ error: 'action moet status of backfill_chunk zijn' });
}
