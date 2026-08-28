// api/public-opstartsessie-free-slots.js
//
// Publieke vrije-slots-endpoint voor de Opstartsessie-pagina op
// deforexopleiding.nl. Server-to-server pattern: de dfo-website heeft een
// serverless-proxy die deze CRM-endpoint aanroept met x-internal-token ==
// OPSTARTSESSIE_SECRET. GHL PIT-token blijft in de CRM (least privilege).
//
// GET  ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD   — venster (max 21 dagen)
// GET  ?date=YYYY-MM-DD                            — één dag
// (Default: vandaag t/m +14 dagen; hard-cap 21 dagen tegen spoof-callers.)
//
// Wraps ÉÉN GHL-agenda (env GHL_CALENDAR_ID) — geen 20 aparte agenda's.
// Retourneert dezelfde shape als api/follow-up-ghl-free-slots.js:
//   { slots:[{ date:'YYYY-MM-DD', times:['09:00',...] }], timezone,
//     window:{ startDate, endDate } }
//
// Fail-soft: bij GHL-fout of missende env → 200 met slots=[] + error='onbeschikbaar'
// (UI toont dan een leeg agenda-scherm i.p.v. te crashen). Token wordt NOOIT
// gelogd of in de response opgenomen.
//
// Auth:
//   x-internal-token == OPSTARTSESSIE_SECRET (verplicht)
//
// Response:
//   200 { slots, timezone, window }         succes of fail-soft leeg
//   401 { error }                            ontbrekend/verkeerd token
//   405                                      geen GET
//   503 { error: 'OPSTARTSESSIE_SECRET ...' } env niet geconfigureerd
//
// 0 incasso-writes. Read-only richting GHL, GEEN DB-writes.

import fetch from 'node-fetch';

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
// v=3 (2026-08-28): venster verruimd van 14/21 → 30/30 dagen. Reden:
// funnels tonen ook langer-vooruit-slots als de klant iets rustiger wil
// inplannen. Als GHL zelf minder ver vooruit aanbiedt (kalender-instelling
// "hoe ver vooruit boekbaar"), dan wint GHL — de diagnose-log toont dan
// welk venster GHL werkelijk teruggeeft.
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS     = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Amsterdam-midnight (respecteert DST). Copie van follow-up-ghl-free-slots.js
// zodat public-endpoint standalone werkt (geen shared-lib-koppeling).
function amsMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utc));
  const map = {}; for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  const offMin = Math.round((asUtc - utc) / 60000);
  return utc - offMin * 60000;
}

function amsPartsOf(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const map = {}; for (const p of parts) map[p.type] = p.value;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
  };
}

async function fetchGhlSlots({ calendarId, token, startMs, endMs }) {
  // v=2 (2026-08-27): parity met api/follow-up-ghl-free-slots.js —
  // timezone-param meesturen zodat GHL Amsterdam-lokale datum-keys
  // retourneert i.p.v. UTC (wat een off-by-one op de datum-grens gaf).
  const url = `${GHL_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots`
    + `?startDate=${startMs}&endDate=${endMs}`
    + `&timezone=${encodeURIComponent('Europe/Amsterdam')}`;
  const res = await fetch(url, {
    headers: {
      Authorization : `Bearer ${token}`,
      Version       : GHL_VERSION,
      Accept        : 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GHL free-slots ${res.status}`);
    err.ghlStatus = res.status;
    err.ghlBody   = body.slice(0, 200);
    throw err;
  }
  return res.json();
}

// Normaliseer GHL free-slots response. GHL retourneert TWEE shapes afhankelijk
// van de kalender-config (bevestigd in productie via follow-up-ghl-free-slots.js):
//   Vorm 1: { slots: [iso, ...] }                                  — platte lijst
//   Vorm 2: { "YYYY-MM-DD": { slots: [iso, ...] } , ... }          — per dag
// Elk slot-element kan string zijn OF een object met .startTime/.start.
// Grouping op Amsterdam-lokale datum die uit de ISO volgt (respecteert DST).
// v=2 (2026-08-27): parity met follow-up-ghl-free-slots.js normaliseer().
function normaliseer(raw) {
  const byDate = new Map();
  const push = (iso) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return;
    const { date, time } = amsPartsOf(t);
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date).add(time);
  };

  if (!raw || typeof raw !== 'object') return [];

  // Vorm 1: platte lijst.
  if (Array.isArray(raw?.slots)) {
    for (const s of raw.slots) push(typeof s === 'string' ? s : s?.startTime || s?.start || '');
  }

  // Vorm 2: object keyed op datum.
  for (const [k, v] of Object.entries(raw)) {
    if (!DATE_RE.test(k)) continue;
    const arr = Array.isArray(v?.slots) ? v.slots : (Array.isArray(v) ? v : []);
    for (const s of arr) push(typeof s === 'string' ? s : s?.startTime || s?.start || '');
  }

  const out = [];
  for (const [date, timesSet] of byDate) {
    out.push({ date, times: [...timesSet].sort() });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth — shared secret voor dfo-website server-to-server.
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht    = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const q = req.query || {};
  const singleDate = typeof q.date === 'string' && DATE_RE.test(q.date) ? q.date : null;
  let startDate = typeof q.startDate === 'string' && DATE_RE.test(q.startDate) ? q.startDate : null;
  let endDate   = typeof q.endDate   === 'string' && DATE_RE.test(q.endDate)   ? q.endDate   : null;

  const todayParts = amsPartsOf(Date.now());
  if (singleDate) {
    startDate = singleDate;
    endDate   = singleDate;
  } else {
    if (!startDate) startDate = todayParts.date;
    if (!endDate) {
      const startMs = amsMidnightMs(startDate);
      const endMs   = startMs + DEFAULT_WINDOW_DAYS * 86400000;
      endDate = amsPartsOf(endMs).date;
    }
  }

  // Hard-cap window (anti-spoof) — verhouding start→end mag niet groter
  // dan MAX_WINDOW_DAYS zijn.
  const startMs = amsMidnightMs(startDate);
  let   endMs   = amsMidnightMs(endDate) + (24 * 3600 * 1000) - 1;
  const maxEndMs = startMs + MAX_WINDOW_DAYS * 86400000;
  if (endMs > maxEndMs) endMs = maxEndMs;

  const calendarId = process.env.GHL_CALENDAR_ID;
  const token      = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!calendarId || !token) {
    console.warn('[public-opstartsessie-free-slots] env ontbreekt', {
      calendarId: !!calendarId, token: !!token,
    });
    return res.status(200).json({
      slots: [], timezone: 'Europe/Amsterdam',
      window: { startDate, endDate }, error: 'onbeschikbaar',
    });
  }

  try {
    const raw = await fetchGhlSlots({ calendarId, token, startMs, endMs });
    const slots = normaliseer(raw);
    // v=3 diagnose-log: ALTIJD loggen wat het effectieve venster is dat GHL
    // teruggeeft — zowel bij lege als niet-lege response. Zo zie je in de
    // Vercel-logs of GHL zelf minder ver vooruit aanbiedt dan wij vragen
    // (kalender-instelling "hoe ver vooruit boekbaar"). Als de min/max date
    // uit de response < endDate, dan is dat een GHL-cap.
    if (slots.length > 0) {
      console.log('[public-opstartsessie-free-slots] GHL window',
        JSON.stringify({
          gevraagd_start: startDate, gevraagd_end: endDate,
          ghl_earliest: slots[0]?.date, ghl_latest: slots[slots.length - 1]?.date,
          n_dagen_met_slots: slots.length,
        }));
    }
    // v=2 diagnose-log: bij lege response is dit hét signaal om te zien
    // of het aan GHL ligt (raw is leeg) of aan parsing (raw heeft data,
    // slots is leeg → shape-mismatch). NOOIT de token loggen; alleen de
    // top-level keys en het aantal slots per key.
    if (slots.length === 0) {
      const rawKeys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
      const sample  = rawKeys.slice(0, 5).map((k) => {
        const v = raw[k];
        const arr = Array.isArray(v?.slots) ? v.slots : (Array.isArray(v) ? v : null);
        return { k, n: Array.isArray(arr) ? arr.length : (arr === null ? 'n/a' : 0) };
      });
      console.warn('[public-opstartsessie-free-slots] parse yielded 0 slots — GHL keys:', rawKeys.length, 'sample:', JSON.stringify(sample));
    }
    return res.status(200).json({
      slots, timezone: 'Europe/Amsterdam',
      window: { startDate, endDate },
    });
  } catch (e) {
    console.warn('[public-opstartsessie-free-slots] GHL-fout', e?.ghlStatus || '?', e?.ghlBody || e?.message || '');
    return res.status(200).json({
      slots: [], timezone: 'Europe/Amsterdam',
      window: { startDate, endDate }, error: 'onbeschikbaar',
    });
  }
}
