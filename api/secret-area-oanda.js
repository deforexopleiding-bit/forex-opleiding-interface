// api/secret-area-oanda.js
//
// Blok B / stap 1 — bewijs dat OANDA-candles ophaalbaar zijn. GEEN opslag,
// GEEN meerdere paren tegelijk, GEEN retention. Alleen: fetch → schone shape.
//
// Owner-gated (Secret Area). Token blijft server-side; nooit gelogd, nooit
// in een response geëchoed. SSRF-hygiëne: instrument + granularity worden
// tegen een strikte allowlist gevalideerd voordat er een URL wordt gebouwd.
//
// Query:
//   instrument         ^[A-Z]{3}_[A-Z]{3}$  (default 'EUR_USD')
//   granularity        ∈ {'M15','H4'}       (default 'M15')
//   count              1..500               (default 50)
//   includeIncomplete  '1' = ook lopende candle meesturen (default: nee)
//
// Response 200: { ok:true, instrument, granularity, count, candles:[
//                 { time, o, h, l, c, complete } ] }
// Response 400: validatie
// Response 403: owner-gate faalt
// Response 500: config-fout (OANDA_API_TOKEN of OANDA_ENV ontbreekt)
// Response 502: OANDA fout (upstream) — met status + korte melding, ZONDER token.

import { requireOwner } from './_lib/secretArea.js';

const INSTRUMENT_RE   = /^[A-Z]{3}_[A-Z]{3}$/;
const ALLOWED_GRAN    = new Set(['M15', 'H4']);
const DEFAULT_COUNT   = 50;
const MAX_COUNT       = 500;
const FETCH_TIMEOUT_MS = 8000;

function baseUrlForEnv(env) {
  const v = String(env || '').trim().toLowerCase();
  if (v === 'live')     return 'https://api-fxtrade.oanda.com';
  if (v === 'practice') return 'https://api-fxpractice.oanda.com';
  return null; // onbekende / lege env → laat caller falen met 500 config-fout
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
  const instrument = typeof q.instrument === 'string' && q.instrument.trim()
    ? q.instrument.trim().toUpperCase()
    : 'EUR_USD';
  if (!INSTRUMENT_RE.test(instrument)) {
    return res.status(400).json({ error: 'instrument moet ^[A-Z]{3}_[A-Z]{3}$ zijn' });
  }
  const granularity = typeof q.granularity === 'string' && q.granularity.trim()
    ? q.granularity.trim().toUpperCase()
    : 'M15';
  if (!ALLOWED_GRAN.has(granularity)) {
    return res.status(400).json({ error: 'granularity moet M15 of H4 zijn' });
  }
  let count = Number(q.count);
  if (!Number.isFinite(count) || count <= 0) count = DEFAULT_COUNT;
  count = Math.min(Math.floor(count), MAX_COUNT);

  const includeIncomplete = String(q.includeIncomplete || '') === '1';

  // 4) Externe call — timeout via AbortController.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url = `${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles`
    + `?granularity=${encodeURIComponent(granularity)}`
    + `&count=${count}`
    + `&price=M`;

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
