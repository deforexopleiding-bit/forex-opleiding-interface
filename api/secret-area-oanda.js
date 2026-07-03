// api/secret-area-oanda.js
//
// Blok B / stap 3 — chart-historie verdiepen. Default-load haalt nu 1500
// candles (i.p.v. 50) en het endpoint ondersteunt ?before=<epoch|RFC3339>
// zodat de frontend bij terugscrollen een OUDERE batch kan bij-laden. Max
// blijft binnen OANDA's harde plafond (5000 per call).
//
// Owner-gated (Secret Area). Token blijft server-side; nooit gelogd, nooit
// in een response geëchoed. SSRF-hygiëne: instrument + granularity worden
// tegen een strikte allowlist gevalideerd voordat er een URL wordt gebouwd.
// De 'before'-parameter wordt gevalideerd naar epoch-seconds en pas dán
// deterministisch als RFC3339 UTC-string doorgestuurd naar OANDA — nooit
// een ruwe user-string in de URL.
//
// Query:
//   instrument         ^[A-Z]{3}_[A-Z]{3}$ of XAU_USD  (default 'EUR_USD')
//   granularity        ∈ {'M1','M5','M15','M30','H1','H4','D','W'}  (default 'M15')
//   count              1..5000                         (default 1500)
//   includeIncomplete  '1' = ook lopende candle meesturen (default: nee)
//   before             optioneel — epoch-seconds (getal) of strict RFC3339
//                      UTC ("YYYY-MM-DDTHH:MM:SSZ" of ".ssssZ"). Vraagt
//                      OANDA om candles die eindigen VÓÓR/OP deze tijd
//                      (v20 'to' + count).
//
// Response 200: { ok:true, instrument, granularity, count, candles:[
//                 { time, o, h, l, c, complete } ] }
// Response 400: validatie
// Response 403: owner-gate faalt
// Response 500: config-fout (OANDA_API_TOKEN of OANDA_ENV ontbreekt)
// Response 502: OANDA fout (upstream) — met status + korte melding, ZONDER token.

import { requireOwner } from './_lib/secretArea.js';

const INSTRUMENT_RE      = /^[A-Z]{3}_[A-Z]{3}$/;
const EXTRA_INSTRUMENTS  = new Set(['XAU_USD']); // metaal — buiten FX-paar regex
const ALLOWED_GRAN       = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D', 'W']);
const DEFAULT_COUNT      = 1500;
const MAX_COUNT          = 5000;
const FETCH_TIMEOUT_MS   = 15000;
// Strikte RFC3339 UTC — geen offset, alleen 'Z'. Optionele fractionele seconden.
const RFC3339_UTC_RE     = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// Sanity-window voor epoch-seconds: 2003-01-01 .. 2100-01-01. Voorkomt dat
// een user per ongeluk ms i.p.v. s stuurt (die zou boven het plafond zitten).
const EPOCH_MIN          = 1041379200;  // 2003-01-01T00:00:00Z
const EPOCH_MAX          = 4102444800;  // 2100-01-01T00:00:00Z

/**
 * Parseer + valideer ?before naar epoch-seconds (int) of null (afwezig).
 * Gooit 'invalid' voor onbekende/afwijkende formaten. Nooit terug: de
 * originele string — caller bouwt de OANDA-URL uit het INT.
 */
function parseBefore(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
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

function isAllowedInstrument(instr) {
  if (!instr || typeof instr !== 'string') return false;
  if (EXTRA_INSTRUMENTS.has(instr)) return true;
  return INSTRUMENT_RE.test(instr);
}

function baseUrlForEnv(env) {
  const v = String(env || '').trim().toLowerCase();
  if (v === 'live')     return 'https://api-fxtrade.oanda.com';
  if (v === 'practice') return 'https://api-fxpractice.oanda.com';
  return null; // onbekende / lege env → laat caller falen met 500 config-fout
}

// ── Multi-price watchlist (action=prices) ──────────────────────────────────
const MAX_PRICES = 40;
// Dag-open cache per instrument (in-memory, per UTC-dag). Dag-open verandert
// maar 1× per dag, dus na warmup doet de frequente refresh alleen de ene
// pricing-call. Bij cold start opnieuw warm.
const _dayOpenCache = new Map();
function _utcDayKey() { return new Date().toISOString().slice(0, 10); }

async function _mapLimit(items, limit, fn) {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const workers = new Array(n).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// Dag-open van vandaag = open van de laatste D-candle. price=M; token server-side.
async function _fetchDayOpen(baseUrl, token, instrument) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url = `${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles?granularity=D&count=1&price=M`;
  try {
    const r = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const candles = Array.isArray(j?.candles) ? j.candles : [];
    const c = candles.length ? candles[candles.length - 1] : null;
    const o = c?.mid?.o != null ? Number(c.mid.o) : null;
    return Number.isFinite(o) ? o : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Één OANDA pricing-call voor alle instrumenten + dag-verandering% t.o.v. de
// dag-open. Verwacht token + baseUrl al gevalideerd door de caller.
async function handlePrices(res, { token, baseUrl, instrumentsRaw }) {
  const accountId = process.env.OANDA_ACCOUNT_ID || '';
  if (!accountId) return res.status(500).json({ error: 'OANDA_ACCOUNT_ID ontbreekt (server-config)' });

  // Instrument-lijst valideren tegen de allowlist (regex + XAU_USD).
  const list = String(instrumentsRaw || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const uniq = [...new Set(list)].filter(isAllowedInstrument).slice(0, MAX_PRICES);
  if (!uniq.length) return res.status(400).json({ error: 'geen geldige instruments (comma-separated, allowlist)' });

  // 1) Eén pricing-call voor alle instrumenten.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url = `${baseUrl}/v3/accounts/${encodeURIComponent(accountId)}/pricing`
    + `?instruments=${uniq.map(encodeURIComponent).join('%2C')}`;
  let payload;
  try {
    const upstream = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      let snip = ''; try { snip = String((await upstream.text()) || '').slice(0, 200); } catch (_) {}
      console.error('[secret-area-oanda] pricing upstream', upstream.status);
      return res.status(502).json({ error: 'OANDA pricing fout', status: upstream.status, detail: snip || null });
    }
    payload = await upstream.json();
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError' ? 'OANDA timeout' : 'OANDA netwerkfout';
    console.error('[secret-area-oanda] pricing fetch fail:', msg);
    return res.status(502).json({ error: msg, status: null });
  }

  const midByInstr = new Map();
  for (const p of (Array.isArray(payload?.prices) ? payload.prices : [])) {
    const bid = Number(p?.bids?.[0]?.price ?? p?.closeoutBid);
    const ask = Number(p?.asks?.[0]?.price ?? p?.closeoutAsk);
    let mid = null;
    if (Number.isFinite(bid) && Number.isFinite(ask)) mid = (bid + ask) / 2;
    else if (Number.isFinite(bid)) mid = bid;
    else if (Number.isFinite(ask)) mid = ask;
    if (p?.instrument && mid != null) midByInstr.set(p.instrument, mid);
  }

  // 2) Dag-open per instrument (cache per UTC-dag → alleen ontbrekende ophalen).
  const dayKey = _utcDayKey();
  const missing = uniq.filter((i) => {
    const c = _dayOpenCache.get(i);
    return !(c && c.day === dayKey && Number.isFinite(c.open));
  });
  await _mapLimit(missing, 5, async (instr) => {
    const open = await _fetchDayOpen(baseUrl, token, instr);
    if (Number.isFinite(open)) _dayOpenCache.set(instr, { day: dayKey, open });
  });

  const prices = uniq.map((instr) => {
    const price = midByInstr.has(instr) ? midByInstr.get(instr) : null;
    const dc = _dayOpenCache.get(instr);
    const dayOpen = (dc && dc.day === dayKey) ? dc.open : null;
    let changePct = null, direction = null;
    if (price != null && Number.isFinite(dayOpen) && dayOpen !== 0) {
      changePct = ((price - dayOpen) / dayOpen) * 100;
      direction = changePct >= 0 ? 'up' : 'down';
    }
    return { instrument: instr, price, changePct, direction };
  });

  return res.status(200).json({ ok: true, count: prices.length, prices });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // 1) Owner-gate ALS EERSTE.
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 2) Config-check. Ontbrekende env → 500, GEEN token-echo in error-text.
  const token = process.env.OANDA_API_TOKEN || '';
  const envName = process.env.OANDA_ENV || '';
  const baseUrl = baseUrlForEnv(envName);
  if (!token) return res.status(500).json({ error: 'OANDA_API_TOKEN ontbreekt (server-config)' });
  if (!baseUrl) return res.status(500).json({ error: 'OANDA_ENV moet practice|live zijn (server-config)' });

  // 3) Query-validatie. STRIKT — geen vrije user-input naar externe URL.
  const q = req.query || {};

  // 3a) Multi-price watchlist-actie: één pricing-call voor een lijst
  //     instrumenten (owner-gated, allowlist, token server-side).
  if (String(q.action || '') === 'prices') {
    return handlePrices(res, { token, baseUrl, instrumentsRaw: q.instruments });
  }

  const instrument = typeof q.instrument === 'string' && q.instrument.trim()
    ? q.instrument.trim().toUpperCase()
    : 'EUR_USD';
  if (!isAllowedInstrument(instrument)) {
    return res.status(400).json({ error: 'instrument niet toegestaan (^[A-Z]{3}_[A-Z]{3}$ of XAU_USD)' });
  }
  const granularity = typeof q.granularity === 'string' && q.granularity.trim()
    ? q.granularity.trim().toUpperCase()
    : 'M15';
  if (!ALLOWED_GRAN.has(granularity)) {
    return res.status(400).json({ error: 'granularity moet M1|M5|M15|M30|H1|H4|D|W zijn' });
  }
  let count = Number(q.count);
  if (!Number.isFinite(count) || count <= 0) count = DEFAULT_COUNT;
  count = Math.min(Math.floor(count), MAX_COUNT);

  const includeIncomplete = String(q.includeIncomplete || '') === '1';

  // ?before — optioneel, strikt gevalideerd naar epoch-seconds. Wordt
  // omgezet naar RFC3339 UTC vóór doorgifte aan OANDA; nooit de rauwe
  // user-string in de URL.
  let beforeSec = null;
  try {
    beforeSec = parseBefore(q.before);
  } catch (_) {
    return res.status(400).json({
      error: 'before ongeldig: gebruik epoch-seconds of RFC3339 UTC (YYYY-MM-DDTHH:MM:SSZ)',
    });
  }

  // 4) Externe call — timeout via AbortController.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let url = `${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles`
    + `?granularity=${encodeURIComponent(granularity)}`
    + `&count=${count}`
    + `&price=M`;
  if (beforeSec != null) {
    // OANDA v20: 'to' + 'count' → geeft `count` candles die eindigen op/vóór `to`.
    // encodeURIComponent op de al-gevalideerde deterministische string; geen
    // ruwe input gaat mee.
    url += `&to=${encodeURIComponent(epochToRfc3339(beforeSec))}`;
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError' ? 'OANDA timeout' : 'OANDA netwerkfout';
    // Log alleen de bovenlaag; NOOIT de token of de headers.
    console.error('[secret-area-oanda] fetch fail:', msg);
    return res.status(502).json({ error: msg, status: null });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    let bodySnippet = '';
    try {
      const txt = await upstream.text();
      // Alleen eerste 200 chars terug — genoeg voor diagnose, en OANDA
      // echoot ons token niet in error-bodies.
      bodySnippet = String(txt || '').slice(0, 200);
    } catch (_) { /* fail-soft */ }
    console.error('[secret-area-oanda] upstream', upstream.status);
    return res.status(502).json({
      error: 'OANDA fout',
      status: upstream.status,
      detail: bodySnippet || null,
    });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch (e) {
    console.error('[secret-area-oanda] parse fail');
    return res.status(502).json({ error: 'OANDA response geen JSON' });
  }

  const rawCandles = Array.isArray(payload?.candles) ? payload.candles : [];
  const mapped = rawCandles.map((c) => ({
    time    : c?.time || null,
    o       : c?.mid?.o != null ? Number(c.mid.o) : null,
    h       : c?.mid?.h != null ? Number(c.mid.h) : null,
    l       : c?.mid?.l != null ? Number(c.mid.l) : null,
    c       : c?.mid?.c != null ? Number(c.mid.c) : null,
    complete: c?.complete === true,
  }));
  const filtered = includeIncomplete ? mapped : mapped.filter((c) => c.complete === true);

  return res.status(200).json({
    ok         : true,
    instrument,
    granularity,
    count      : filtered.length,
    candles    : filtered,
  });
}
