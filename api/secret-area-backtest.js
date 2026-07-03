// api/secret-area-backtest.js
//
// Backtest stap 1 — REGELGEBASEERDE FMES "Confirmation"-kandidaatdetectie op
// EUR_USD. Leest UITSLUITEND uit sa_candles (H4 + M15, sinds 2025-01-01) en
// levert kandidaten met alle punten die de frontend nodig heeft om ze op de
// chart uit te tekenen. GEEN AI in deze route — puur deterministische regels.
//
// Een FMES-Confirmation-kandidaat = de volgorde
//     liquidity sweep → displacement → MSS → 0.71-OTE-tap
// mét de H4-bias mee. Elke bouwsteen is een aparte, gedocumenteerde functie en
// alle drempels staan als aanpasbare constanten in THRESHOLDS bovenaan zodat we
// later kunnen kalibreren zonder de logica te herschrijven.
//
// Owner-gated: requireOwner EERST (403 bij null). Alleen-lezen; geen mutaties.
//
// Acties:
//   action='scan_candidates' { instrument:'EUR_USD', from?, to? }
//     → { ok, instrument, period, count, returned, capped, candidates:[...] }
//   action='candidate_detail' { instrument, id } | { instrument, ts }
//     → { ok, candidate } (her-scant een begrensd venster rond de ts)
//
// Responses: 200 ok · 400 validatie · 403 owner-gate · 405 method · 500 intern.

import { requireOwner } from './_lib/secretArea.js';
import { supabaseAdmin } from './supabase.js';

// ── Aanpasbare detectie-drempels (voor latere kalibratie) ───────────────────
const THRESHOLDS = {
  SWING_LOOKBACK:        2,     // M15 pivots: N candles elke kant voor een swing
  H4_SWING_LOOKBACK:     2,     // H4 pivots voor de bias-timeline
  SWEEP_SWING_WINDOW:    30,    // hoe ver terug we een te-vegen swing zoeken (M15 bars)
  SWEEP_RETURN_K:        2,     // candles waarin de prijs terug binnen het niveau moet
  DISPLACEMENT_MULT:     1.5,   // impuls-range ≥ MULT × gemiddelde range
  DISPLACEMENT_AVG_WINDOW: 20,  // venster voor de gemiddelde range
  DISPLACEMENT_MAX_BARS: 6,     // max lengte van de displacement-leg (M15 bars)
  MSS_MAX_BARS:          8,     // MSS moet binnen zoveel bars na de sweep vallen
  FIB_OTE:               0.71,  // OTE-retracementniveau
  FIB_TOLERANCE:         0.06,  // ± tolerantie als fractie van de leg-range
  FIB_MAX_BARS:          20,    // 0.71-tap moet binnen zoveel bars na MSS vallen
};

const MAX_CANDIDATES   = 250;   // payload-cap; count meldt het echte totaal
const DEFAULT_FROM_ISO = '2025-01-01T00:00:00Z';
const DB_PAGE          = 1000;  // PostgREST default page-size
const ALLOWED_INSTR    = new Set(['EUR_USD']); // deze PR: alleen EUR_USD

// ── Datum-bound validatie (geen externe URL; puur sane bounds) ─────────────
function parseBound(raw, fallbackISO) {
  if (raw == null || raw === '') return fallbackISO;
  const s = String(raw).trim();
  if (!s) return fallbackISO;
  // 'YYYY-MM-DD' → middernacht UTC.
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s + 'T00:00:00Z';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('invalid');
  return new Date(ms).toISOString();
}

function tsToSec(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ── DB-read: alle candles voor instrument+granularity in [fromISO,toISO] ────
// Alleen sa_candles. Pagineert via .range zodat we niet op de 1000-rij-cap van
// PostgREST stuk lopen. Retourneert oplopend op ts.
async function fetchCandles(instrument, granularity, fromISO, toISO) {
  const out = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('sa_candles')
      .select('ts,o,h,l,c')
      .eq('instrument', instrument)
      .eq('granularity', granularity)
      .eq('complete', true)
      .gte('ts', fromISO)
      .lte('ts', toISO)
      .order('ts', { ascending: true })
      .range(offset, offset + DB_PAGE - 1);
    if (error) throw new Error('sa_candles: ' + (error.message || 'db-fout'));
    const rows = data || [];
    for (const r of rows) {
      const t = tsToSec(r.ts);
      const o = Number(r.o), h = Number(r.h), l = Number(r.l), c = Number(r.c);
      if (t == null || ![o, h, l, c].every(Number.isFinite)) continue;
      out.push({ ts: r.ts, t, o, h, l, c });
    }
    if (rows.length < DB_PAGE) break;
    offset += DB_PAGE;
  }
  return out;
}

// ── Bouwsteen: swing highs/lows (pivots) ────────────────────────────────────
// Een pivot-high op index k = hoger dan de `lookback` candles ervoor én erna.
// Idem (omgekeerd) voor pivot-low. Retourneert twee oplopende arrays.
function swingPivots(candles, lookback) {
  const highs = [];
  const lows = [];
  for (let k = lookback; k < candles.length - lookback; k++) {
    const hk = candles[k].h, lk = candles[k].l;
    let isHigh = true, isLow = true;
    for (let j = k - lookback; j <= k + lookback; j++) {
      if (j === k) continue;
      if (candles[j].h >= hk) isHigh = false;
      if (candles[j].l <= lk) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: k, t: candles[k].t, ts: candles[k].ts, price: hk });
    if (isLow)  lows.push({ index: k, t: candles[k].t, ts: candles[k].ts, price: lk });
  }
  return { highs, lows };
}

// ── Bouwsteen: H4-bias-timeline (HH/HL = bull, LH/LL = bear) ─────────────────
// Per H4-candle bepalen we de bias uit de laatste twee pivot-highs + laatste
// twee pivot-lows tot dat punt. Retourneert [{ t, bias }] oplopend.
function h4BiasTimeline(h4, lookback) {
  const { highs, lows } = swingPivots(h4, lookback);
  const out = [];
  let hi = 0, li = 0;
  const recentHighs = [];
  const recentLows = [];
  for (let k = 0; k < h4.length; k++) {
    while (hi < highs.length && highs[hi].index <= k) { recentHighs.push(highs[hi].price); hi++; }
    while (li < lows.length && lows[li].index <= k)  { recentLows.push(lows[li].price);  li++; }
    let bias = 'none';
    if (recentHighs.length >= 2 && recentLows.length >= 2) {
      const hUp = recentHighs[recentHighs.length - 1] > recentHighs[recentHighs.length - 2];
      const lUp = recentLows[recentLows.length - 1]  > recentLows[recentLows.length - 2];
      const hDn = recentHighs[recentHighs.length - 1] < recentHighs[recentHighs.length - 2];
      const lDn = recentLows[recentLows.length - 1]  < recentLows[recentLows.length - 2];
      if (hUp && lUp) bias = 'bull';
      else if (hDn && lDn) bias = 'bear';
    }
    out.push({ t: h4[k].t, bias });
  }
  return out;
}

// Binary-search: grootste positie p met pivots[p].index < x, of -1. Houdt de
// scan O(n log P) i.p.v. O(n·P) op ~30k M15-candles.
function _bsLastBefore(pivots, x) {
  let lo = 0, hi = pivots.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pivots[mid].index < x) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

// Bias op een willekeurige tijd = bias van de meest recente H4-candle ≤ t
// (binary-search op de oplopende timeline).
function biasAt(biasTimeline, t) {
  let lo = 0, hi = biasTimeline.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (biasTimeline[mid].t <= t) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res >= 0 ? biasTimeline[res].bias : 'none';
}

// Gemiddelde high-low-range over het venster vóór index i.
function avgRange(candles, i, window) {
  const start = Math.max(0, i - window);
  let sum = 0, n = 0;
  for (let k = start; k < i; k++) { sum += (candles[k].h - candles[k].l); n++; }
  return n ? sum / n : 0;
}

// Meest recente pivot vóór index i (uit een oplopende pivot-array).
function lastPivotBefore(pivots, i) {
  const p = _bsLastBefore(pivots, i);
  return p >= 0 ? pivots[p] : null;
}

// ── Bouwsteen: liquidity sweep op candle i ──────────────────────────────────
// bull: candle i's low veegt een recente swing-LOW (wick eronder) maar sluit
//       er weer BOVEN → sell-side liquidity gepakt. bear = spiegel.
function detectSweepAt(m15, i, pivots, bias, T) {
  if (bias === 'bull') {
    const swing = nearestPivotWithin(pivots.lows, i, T.SWEEP_SWING_WINDOW);
    if (!swing) return null;
    const c = m15[i];
    if (c.l < swing.price && c.c > swing.price) {
      return { index: i, ts: c.ts, price: c.l, sweptLevel: swing.price };
    }
  } else if (bias === 'bear') {
    const swing = nearestPivotWithin(pivots.highs, i, T.SWEEP_SWING_WINDOW);
    if (!swing) return null;
    const c = m15[i];
    if (c.h > swing.price && c.c < swing.price) {
      return { index: i, ts: c.ts, price: c.h, sweptLevel: swing.price };
    }
  }
  return null;
}

// Dichtstbijzijnde pivot met index < i binnen `window` bars.
function nearestPivotWithin(pivots, i, window) {
  const p = _bsLastBefore(pivots, i);
  if (p < 0) return null;
  const piv = pivots[p];
  return piv.index >= i - window ? piv : null;
}

// ── Bouwsteen: displacement na de sweep ─────────────────────────────────────
// De impuls-leg: vanaf de sweep-extreme naar de sterkste tegengestelde extreme
// binnen MAX_BARS, als die range ≥ MULT × gemiddelde range is.
function detectDisplacement(m15, sweep, bias, T) {
  const avg = avgRange(m15, sweep.index, T.DISPLACEMENT_AVG_WINDOW);
  if (avg <= 0) return null;
  const startIdx = sweep.index;
  const startPrice = sweep.price; // sweep-extreme = leg-begin
  let bestIdx = -1, bestPrice = null;
  for (let k = startIdx + 1; k <= Math.min(m15.length - 1, startIdx + T.DISPLACEMENT_MAX_BARS); k++) {
    if (bias === 'bull') {
      if (bestPrice == null || m15[k].h > bestPrice) { bestPrice = m15[k].h; bestIdx = k; }
    } else {
      if (bestPrice == null || m15[k].l < bestPrice) { bestPrice = m15[k].l; bestIdx = k; }
    }
  }
  if (bestIdx < 0) return null;
  const range = Math.abs(bestPrice - startPrice);
  if (range < T.DISPLACEMENT_MULT * avg) return null;
  return {
    fromTs: m15[startIdx].ts, toTs: m15[bestIdx].ts,
    fromPrice: startPrice, toPrice: bestPrice,
    fromIndex: startIdx, toIndex: bestIdx,
  };
}

// ── Bouwsteen: MSS (market structure shift) ─────────────────────────────────
// bull: eerste body-close BOVEN de laatste pivot-high vóór de sweep, binnen
//       MSS_MAX_BARS na de sweep. bear = spiegel.
function detectMSS(m15, sweep, disp, pivots, bias, T) {
  const end = Math.min(m15.length - 1, sweep.index + T.MSS_MAX_BARS);
  if (bias === 'bull') {
    const swing = lastPivotBefore(pivots.highs, sweep.index);
    if (!swing) return null;
    for (let k = sweep.index + 1; k <= end; k++) {
      if (m15[k].c > swing.price) return { ts: m15[k].ts, index: k, brokenLevel: swing.price };
    }
  } else {
    const swing = lastPivotBefore(pivots.lows, sweep.index);
    if (!swing) return null;
    for (let k = sweep.index + 1; k <= end; k++) {
      if (m15[k].c < swing.price) return { ts: m15[k].ts, index: k, brokenLevel: swing.price };
    }
  }
  return null;
}

// ── Bouwsteen: 0.71-OTE-tap ────────────────────────────────────────────────
// Fib op de impuls-leg: 0 = leg-begin, 1 = leg-eind. OTE-prijs = leg-eind
// terug-retraced tot 0.71. We zoeken de eerste candle NA de MSS die dat niveau
// (± tolerantie) raakt.
function detectFibTap(m15, disp, mss, bias, T) {
  const legLow = Math.min(disp.fromPrice, disp.toPrice);
  const legHigh = Math.max(disp.fromPrice, disp.toPrice);
  const legRange = legHigh - legLow;
  if (legRange <= 0) return null;
  const tol = T.FIB_TOLERANCE * legRange;
  const ote = (bias === 'bull')
    ? legHigh - T.FIB_OTE * legRange   // bull: retrace omlaag naar 0.71
    : legLow + T.FIB_OTE * legRange;   // bear: retrace omhoog naar 0.71
  const start = Math.max(mss.index + 1, disp.toIndex + 1);
  const end = Math.min(m15.length - 1, start + T.FIB_MAX_BARS);
  for (let k = start; k <= end; k++) {
    if (m15[k].l <= ote + tol && m15[k].h >= ote - tol) {
      return {
        index: k, ts: m15[k].ts, price: ote,
        level0Price: disp.fromPrice, level1Price: disp.toPrice, level071Price: ote,
      };
    }
  }
  return null;
}

// ── Hoofd-scan ──────────────────────────────────────────────────────────────
function scanCandidates(h4, m15, T) {
  const biasTL = h4BiasTimeline(h4, T.H4_SWING_LOOKBACK);
  const pivots = swingPivots(m15, T.SWING_LOOKBACK);
  const candidates = [];
  let i = 0;
  while (i < m15.length) {
    const bias = biasAt(biasTL, m15[i].t);
    if (bias === 'none') { i++; continue; }
    const sweep = detectSweepAt(m15, i, pivots, bias, T);
    if (!sweep) { i++; continue; }
    const disp = detectDisplacement(m15, sweep, bias, T);
    if (!disp) { i++; continue; }
    const mss = detectMSS(m15, sweep, disp, pivots, bias, T);
    if (!mss) { i++; continue; }
    const tap = detectFibTap(m15, disp, mss, bias, T);
    if (!tap) { i++; continue; }

    const direction = bias === 'bull' ? 'long' : 'short';
    // SL = de swing-extreme die geveegd werd (meest logische invalidatie).
    const slPrice = sweep.price;
    candidates.push({
      id: direction + '@' + tap.ts,
      ts: tap.ts,
      direction,
      sweep: { ts: sweep.ts, price: sweep.price, sweptLevel: sweep.sweptLevel },
      displacement: { fromTs: disp.fromTs, toTs: disp.toTs, fromPrice: disp.fromPrice, toPrice: disp.toPrice },
      mss: { ts: mss.ts, brokenLevel: mss.brokenLevel },
      impulse: { startTs: disp.fromTs, startPrice: disp.fromPrice, endTs: disp.toTs, endPrice: disp.toPrice },
      fib: { level071Price: tap.level071Price, level0Price: tap.level0Price, level1Price: tap.level1Price },
      entry: { price: tap.price },
      sl: { price: slPrice },
      matched: ['h4_bias', 'sweep', 'displacement', 'mss', 'fib071'],
    });
    // Voorbij deze tap verder zoeken → geen overlappende duplicaten.
    i = tap.index + 1;
  }
  return candidates;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // 1) Owner-gate ALS EERSTE.
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  // 2) Actie + params.
  let action, params = {};
  if (req.method === 'GET') {
    action = (req.query && req.query.action) || 'scan_candidates';
    params = req.query || {};
  } else if (req.method === 'POST') {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    action = body.action || 'scan_candidates';
    params = body;
  } else {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET of POST' });
  }

  const instrument = String(params.instrument || 'EUR_USD').toUpperCase();
  if (!ALLOWED_INSTR.has(instrument)) {
    return res.status(400).json({ error: 'instrument moet EUR_USD zijn (deze PR)' });
  }

  let fromISO, toISO;
  try {
    fromISO = parseBound(params.from, DEFAULT_FROM_ISO);
    toISO   = parseBound(params.to, new Date().toISOString());
  } catch (_) {
    return res.status(400).json({ error: 'from/to ongeldig: gebruik YYYY-MM-DD of RFC3339' });
  }

  try {
    if (action === 'scan_candidates') {
      const [h4, m15] = await Promise.all([
        fetchCandles(instrument, 'H4', fromISO, toISO),
        fetchCandles(instrument, 'M15', fromISO, toISO),
      ]);
      const all = scanCandidates(h4, m15, THRESHOLDS);
      const returned = all.slice(0, MAX_CANDIDATES);
      return res.status(200).json({
        ok: true,
        instrument,
        period: { from: fromISO, to: toISO, h4_candles: h4.length, m15_candles: m15.length },
        count: all.length,
        returned: returned.length,
        capped: all.length > returned.length,
        candidates: returned,
      });
    }

    if (action === 'candidate_detail') {
      const wantId = params.id ? String(params.id) : null;
      const wantTs = params.ts ? String(params.ts) : null;
      if (!wantId && !wantTs) return res.status(400).json({ error: 'geef id of ts' });
      // Her-scan een begrensd venster rond de gevraagde ts (± ~2 maanden) zodat
      // we niet de hele historie opnieuw hoeven te verwerken.
      const anchorIso = wantTs || (wantId && wantId.includes('@') ? wantId.split('@')[1] : null);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isFinite(anchorMs)) return res.status(400).json({ error: 'ts/id niet te herleiden' });
      const winFrom = new Date(anchorMs - 60 * 24 * 3600 * 1000).toISOString();
      const winTo   = new Date(anchorMs + 7 * 24 * 3600 * 1000).toISOString();
      const [h4, m15] = await Promise.all([
        fetchCandles(instrument, 'H4', winFrom, winTo),
        fetchCandles(instrument, 'M15', winFrom, winTo),
      ]);
      const all = scanCandidates(h4, m15, THRESHOLDS);
      const match = all.find((c) => (wantId ? c.id === wantId : c.ts === wantTs)) || null;
      if (!match) return res.status(404).json({ error: 'kandidaat niet gevonden in venster' });
      return res.status(200).json({ ok: true, candidate: match });
    }

    return res.status(400).json({ error: 'action moet scan_candidates of candidate_detail zijn' });
  } catch (e) {
    console.error('[secret-area-backtest]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
