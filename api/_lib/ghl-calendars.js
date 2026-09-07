// api/_lib/ghl-calendars.js
//
// Dynamische GHL-agenda-inventaris voor de verbrede afspraak-reminders.
// GET /calendars/?locationId=… (Version 2021-07-28). Gebruikt door de poll (B)
// en het one-off import-endpoint (C) om per-calendar te pollen i.p.v. per-user.
//
// Fail-soft: bij fout/geen-config → lege lijst (caller beslist wat te doen).

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

export async function listCalendars({ token, locationId } = {}) {
  const t = token || process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY || null;
  const loc = locationId || process.env.GHL_LOCATION_ID || null;
  if (!t || !loc) return [];
  try {
    const r = await fetch(`${GHL_BASE}/calendars/?locationId=${encodeURIComponent(loc)}`, {
      headers: { Authorization: `Bearer ${t}`, Version: GHL_VERSION, Accept: 'application/json' },
    });
    if (!r.ok) {
      console.warn('[ghl-calendars] list fail', r.status);
      return [];
    }
    const j = await r.json().catch(() => ({}));
    const all = j.calendars || j.data || [];
    return all
      .map((c) => ({ id: c.id, name: c.name || null, isActive: (c.isActive !== undefined ? c.isActive : c.is_active) ?? null }))
      .filter((c) => c.id);
  } catch (e) {
    console.warn('[ghl-calendars] list exception:', e?.message || e);
    return [];
  }
}

// Alle agenda's die niet expliciet inactief zijn (active of onbekend).
export async function listActiveCalendars(opts) {
  return (await listCalendars(opts)).filter((c) => c.isActive !== false);
}

export async function listActiveCalendarIds(opts) {
  return (await listActiveCalendars(opts)).map((c) => c.id);
}

// In-memory gecachete id→naam-map (TTL ~15 min), fail-soft. Voor het tonen van
// de agenda-naam bij directe GHL-calls in de Opstartsessies-lijst — géén
// GHL-call per lijst-load.
let _nameCache = { map: null, ts: 0 };
const NAME_TTL_MS = 15 * 60 * 1000;
export async function getCalendarNameMap(opts) {
  const now = Date.now();
  if (_nameCache.map && (now - _nameCache.ts) < NAME_TTL_MS) return _nameCache.map;
  const cals = await listCalendars(opts); // fail-soft → []
  const m = new Map();
  for (const c of cals) if (c.id) m.set(c.id, c.name || null);
  if (m.size > 0) { _nameCache = { map: m, ts: now }; return m; }
  return _nameCache.map || m; // val terug op oude cache of lege map
}
