// api/_lib/agenda-beschikbaarheid.js
//
// Agenda-beschikbaarheid voor de GEMEENSCHAPPELIJKE opstartsessie-agenda
// (één GHL-kalender, env GHL_CALENDAR_ID). Twee admin-knoppen:
//   1) dichte dagen (losse datums + datumbereiken) → geen nieuwe boekingen;
//   2) max. aantal calls per dag → dag vol = niet meer boekbaar.
//
// Opslag: app_settings['agenda_beschikbaarheid'] (jsonb), vorm:
//   { max_per_dag:int, gesloten_dagen:[ 'YYYY-MM-DD' ], gesloten_ranges:[ {van,tot} ] }
//
// READ-ONLY richting de DB. Deze helper wordt op twee server-side chokepoints
// gebruikt (free-slots + public book). Zie de handlers.
//
// FAIL-OPEN: kan de settings-rij niet gelezen worden, dan geeft leesSettings()
// een "lege" (alles toegestaan) config terug i.p.v. te throwen - een
// settings-glitch mag NOOIT alle boekingen stilleggen. De callers tellen daar
// bovenop: een leesfout op de TELLING levert eveneens "niet vol" (fail-open).

import { supabaseAdmin } from '../supabase.js';
import { nlDayStart, nlDayEndExclusive, nlDateString } from './nl-period.js';

const KEY = 'agenda_beschikbaarheid';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 0 of een niet-positief getal = GEEN limiet (cap uit).
function normMax(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Lees de agenda-beschikbaarheid-settings. FAIL-OPEN: bij een leesfout of
 * ontbrekende rij → { max_per_dag:0, gesloten_dagen:Set(), ok:false }.
 * @returns {Promise<{ max_per_dag:number, gesloten_dagen:Set<string>, ok:boolean }>}
 */
export async function leesSettings() {
  const leeg = { max_per_dag: 0, gesloten_dagen: new Set(), ok: false };
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', KEY).maybeSingle();
    if (error) { console.warn('[agenda-beschikbaarheid] settings lezen (fail-open):', error.message); return leeg; }
    const v = (data && data.value && typeof data.value === 'object') ? data.value : {};
    return {
      max_per_dag: normMax(v.max_per_dag),
      gesloten_dagen: expandeerDichteDagen(v),
      ok: true,
    };
  } catch (e) {
    console.warn('[agenda-beschikbaarheid] settings exception (fail-open):', e?.message || e);
    return leeg;
  }
}

/**
 * Losse dagen + ranges → één Set van 'YYYY-MM-DD'. Ranges inclusief van..tot.
 * Defensief: ongeldige datums worden genegeerd; een range van > 366 dagen wordt
 * afgekapt (anti-typo, bv. '2026' i.p.v. '2026-..').
 */
export function expandeerDichteDagen(v) {
  const uit = new Set();
  if (!v || typeof v !== 'object') return uit;
  for (const d of Array.isArray(v.gesloten_dagen) ? v.gesloten_dagen : []) {
    if (typeof d === 'string' && DATE_RE.test(d)) uit.add(d);
  }
  for (const r of Array.isArray(v.gesloten_ranges) ? v.gesloten_ranges : []) {
    const van = r && typeof r.van === 'string' && DATE_RE.test(r.van) ? r.van : null;
    const tot = r && typeof r.tot === 'string' && DATE_RE.test(r.tot) ? r.tot : null;
    if (!van || !tot) continue;
    // Itereer op UTC-datum (puur kalenderrekenen, tijdzone-onafhankelijk).
    let cur = Date.UTC(+van.slice(0, 4), +van.slice(5, 7) - 1, +van.slice(8, 10));
    const eind = Date.UTC(+tot.slice(0, 4), +tot.slice(5, 7) - 1, +tot.slice(8, 10));
    if (eind < cur) continue;
    let guard = 0;
    while (cur <= eind && guard < 367) {
      const dt = new Date(cur);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      uit.add(`${dt.getUTCFullYear()}-${mm}-${dd}`);
      cur += 86400000; guard += 1;
    }
  }
  return uit;
}

/** Is deze 'YYYY-MM-DD' dichtgezet? */
export function isDicht(dateStr, gesloten_dagen) {
  return gesloten_dagen instanceof Set && gesloten_dagen.has(dateStr);
}

// Actieve-afspraken-definitie, gelijk aan follow-up-metrics.js.
const INACTIEF = new Set(['cancelled', 'verplaatst', 'verwijderd']);

/**
 * Tel geboekte calls per NL-dag op de gedeelde agenda, over een venster.
 * follow_up_appointments, ghl_calendar_id = GHL_CALENDAR_ID, actieve status,
 * scheduled_at in [startIso, endIso). Groepeert op NL-kalenderdag.
 * FAIL-OPEN: bij een leesfout → lege Map (dag telt als "niet vol").
 * @returns {Promise<Map<string, number>>}  'YYYY-MM-DD' → aantal
 */
export async function telPerDag({ startIso, endIso }) {
  const perDag = new Map();
  const calendarId = process.env.GHL_CALENDAR_ID || null;
  if (!calendarId) {
    // Geen gedeelde-agenda-id bekend → kan niet betrouwbaar tellen → fail-open.
    console.warn('[agenda-beschikbaarheid] GHL_CALENDAR_ID ontbreekt - telling overgeslagen (fail-open)');
    return perDag;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('scheduled_at, status')
      .eq('ghl_calendar_id', calendarId)
      .gte('scheduled_at', startIso).lt('scheduled_at', endIso)
      .limit(5000);
    if (error) { console.warn('[agenda-beschikbaarheid] telling (fail-open):', error.message); return perDag; }
    for (const r of data || []) {
      if (!r || INACTIEF.has(r.status)) continue;
      const d = nlDateString(new Date(r.scheduled_at));
      perDag.set(d, (perDag.get(d) || 0) + 1);
    }
  } catch (e) {
    console.warn('[agenda-beschikbaarheid] telling exception (fail-open):', e?.message || e);
  }
  return perDag;
}

/**
 * Tel de actieve calls op ÉÉN NL-dag (voor de boek-check). FAIL-OPEN: leesfout → 0.
 * @param {string} dateStr 'YYYY-MM-DD' (NL-kalenderdag)
 */
export async function telOpDag(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) return 0;
  const ref = new Date(`${dateStr}T12:00:00Z`); // midden op de dag → NL-dag is eenduidig
  const startIso = nlDayStart(ref).toISOString();
  const endIso = nlDayEndExclusive(ref).toISOString();
  const perDag = await telPerDag({ startIso, endIso });
  return perDag.get(dateStr) || 0;
}
