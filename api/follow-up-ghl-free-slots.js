// api/follow-up-ghl-free-slots.js
//
// GET  ?date=YYYY-MM-DD               — één dag
// GET  ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD  — venster
// (Default: vandaag t/m +14 dagen)
//
// Returnt Dave's vrije Zoom-slots via GHL calendars/free-slots API,
// genormaliseerd naar { slots:[{ date:'YYYY-MM-DD', times:['09:00',...] }],
// timezone:'Europe/Amsterdam' }.
//
// Read-only. Permissie: sales.tab.retentie of sales.customer.view.
// Fail-soft: bij GHL-fout / missende env → { slots: [], error: 'onbeschikbaar' }
// (HTTP 200 zodat de UI niet breekt). Token wordt NOOIT in response of
// logs opgenomen — alleen als Authorization-header naar GHL.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import fetch from 'node-fetch';

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const DEFAULT_WINDOW_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parse YYYY-MM-DD → epoch ms in Europe/Amsterdam (start-of-day).
// Vermijd Date.parse(dateOnly) omdat dat afhankelijk kan zijn van
// server-TZ. We doen expliciete constructie in UTC en corrigeren met de
// Amsterdam-offset op die datum (respecteert DST).
function amsMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Bepaal offset van Amsterdam op deze datum.
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

// Amsterdam-part van een timestamp voor grouping (date + HH:mm).
function amsPartsOf(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const map = {}; for (const p of parts) map[p.type] = p.value;
  return {
    date : `${map.year}-${map.month}-${map.day}`,
    time : `${map.hour}:${map.minute}`,
  };
}

// Normaliseer verschillende GHL response-vormen naar één shape.
// GHL retourneert typisch: { "YYYY-MM-DD": { slots: ["ISO", ...] }, ... }
// Soms als plat array van ISO-strings. We accepteren beide.
function normalizeGhlSlots(raw) {
  const byDate = new Map();
  const push = (iso) => {
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

  // Sorteer + zet om naar output-shape.
  const out = [];
  for (const [date, timesSet] of byDate) {
    out.push({ date, times: [...timesSet].sort() });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function fetchGhlFreeSlots({ calendarId, token, startMs, endMs }) {
  const url = new URL(`${GHL_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots`);
  url.searchParams.set('startDate', String(startMs));
  url.searchParams.set('endDate',   String(endMs));
  url.searchParams.set('timezone',  'Europe/Amsterdam');

  const res = await fetch(url.toString(), {
    method : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Version      : GHL_VERSION,
      Accept       : 'application/json',
    },
  });

  // Path + query zonder host (host bevat geen secret, maar path+query
  // is genoeg voor debug — en we mixen 'm dus nooit met de token die
  // alleen in de Authorization-header zit).
  const requestPathQuery = url.pathname + url.search;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GHL free-slots ${res.status}`);
    err.ghlStatus       = res.status;
    err.ghlBody         = (body || '').slice(0, 200);
    err.requestPathQuery = requestPathQuery;
    throw err;
  }
  const raw = await res.json();
  return { raw, status: res.status, requestPathQuery };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

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

  // Grens: eindDag inclusive → +1 dag (23:59:59) via +86400s-1ms.
  const startMs = amsMidnightMs(startDate);
  const endMs   = amsMidnightMs(endDate) + (24 * 3600 * 1000) - 1;

  const calendarId = process.env.GHL_CALENDAR_ID;
  const token      = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;

  if (!calendarId || !token) {
    console.warn('[ghl-free-slots] env ontbreekt', {
      calendarId: !!calendarId,
      token     : !!token,
      // NOOIT het token zelf loggen.
    });
    return res.status(200).json({
      slots    : [],
      timezone : 'Europe/Amsterdam',
      window   : { startDate, endDate },
      error    : 'onbeschikbaar',
    });
  }

  // ?debug=1 mag alleen door super_admin/admin/manager. Anders wordt de
  // flag stil genegeerd (payload identiek aan de gewone response).
  const debugRequested = String(q.debug || '') === '1';
  let debugAllowed = false;
  if (debugRequested) {
    try {
      const { data: prof } = await supabaseAdmin
        .from('profiles').select('role').eq('id', user.id).maybeSingle();
      debugAllowed = ADMIN_ROLES.has(String(prof?.role || '').toLowerCase());
    } catch (e) {
      // Fail-soft: rol-lookup faalt → debug niet toestaan.
      console.warn('[ghl-free-slots] role lookup for debug:', e?.message || e);
      debugAllowed = false;
    }
  }

  try {
    const { raw, status: ghlStatus, requestPathQuery } = await fetchGhlFreeSlots({ calendarId, token, startMs, endMs });
    const slots = normalizeGhlSlots(raw);
    // Ook bij 200 loggen: helpt om te zien wanneer GHL wel/geen slots
    // meestuurt zonder DevTools open te hoeven. GEEN token in de log.
    const rawKeys = (raw && typeof raw === 'object') ? Object.keys(raw) : [];
    console.log('[ghl-free-slots] ok status=' + ghlStatus + ' keys=' + JSON.stringify(rawKeys.slice(0, 20)) + ' slotcount=' + slots.reduce((n, d) => n + (d.times?.length || 0), 0));

    const payload = {
      slots,
      timezone: 'Europe/Amsterdam',
      window  : { startDate, endDate },
    };
    if (debugAllowed) {
      payload.debug = {
        requestUrl  : requestPathQuery,   // path+query only, geen host of secret
        ghlStatus,
        ghlRawKeys  : rawKeys,
        ghlRawSample: JSON.stringify(raw).slice(0, 1500),
      };
    }
    return res.status(200).json(payload);
  } catch (e) {
    // Log status/body maar NIET het token.
    console.warn('[ghl-free-slots] fetch faalde', {
      status: e?.ghlStatus || 'unknown',
      body  : e?.ghlBody   || String(e?.message || '').slice(0, 200),
    });
    const payload = {
      slots    : [],
      timezone : 'Europe/Amsterdam',
      window   : { startDate, endDate },
      error    : 'onbeschikbaar',
    };
    if (debugAllowed) {
      payload.debug = {
        requestUrl  : e?.requestPathQuery || null,
        ghlStatus   : e?.ghlStatus || null,
        ghlRawKeys  : [],
        ghlRawSample: (e?.ghlBody || String(e?.message || '')).slice(0, 1500),
      };
    }
    return res.status(200).json(payload);
  }
}
