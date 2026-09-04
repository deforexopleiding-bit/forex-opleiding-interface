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
