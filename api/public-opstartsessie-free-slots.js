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
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS     = 21;
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
  const url = `${GHL_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots?startDate=${startMs}&endDate=${endMs}`;
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

// GHL free-slots response is per-dag: { "YYYY-MM-DD": { slots:[iso,...] } , ... }
function normaliseer(raw) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const [dateKey, val] of Object.entries(raw)) {
    if (!DATE_RE.test(dateKey)) continue;
    const rawSlots = Array.isArray(val?.slots) ? val.slots : [];
    const times = [];
    for (const iso of rawSlots) {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) continue;
      times.push(amsPartsOf(t).time);
    }
    // Uniek + sorted; grouping op de Amsterdam-datum die uit iso volgt.
    if (times.length) {
      out.push({ date: dateKey, times: Array.from(new Set(times)).sort() });
    }
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
