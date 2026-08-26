// api/_lib/bubble-one-on-one-count.js
//
// Bedrijfs-brede telling van AFGERONDE 1-op-1 sessies vandaag, via één
// constrained Bubble Data API-call. Aggregeert alle mentoren tegelijk —
// geen per-mentor loop nodig (verschil met api/_lib/coaching-earnings.js
// die per mentor loopt voor 5-jaar-history).
//
// Filter: 1-1-session waar
//   starting_date_date IN [NL-vandaag-start, NL-morgen-start)
//   AND isdone_boolean = true
//   AND learn_type1_option_os___learning_type = 'Alpha Program'  (JS-side)
//   AND noshow_boolean != true  (JS-side)
//
// Cache: 8 min (in-memory Map). Losgekoppeld van de 10s-display-cache.
// Fail-soft: bubble-error → probeer stale te serveren; anders count=null.

import { bubbleList } from './bubble.js';

const CACHE_TTL_MS = 8 * 60 * 1000;
const FETCH_CAP = 5000;
let _cache = { at: 0, day: null, count: null };

function asBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true','yes','ja','1'].includes(s)) return true;
    if (['false','no','nee','0'].includes(s)) return false;
  }
  return !!v;
}
function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
}
function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) { if (u[k] !== undefined) return u[k]; }
  return undefined;
}

/**
 * @param {{start: Date, endExclusive: Date}} nlDayRange
 * @returns {Promise<{count: number|null, as_of: string, source: string}>}
 */
export async function getBubbleOneOnOneCountToday(nlDayRange) {
  const dayKey = nlDayRange.start.toISOString().slice(0, 10);
  const now = Date.now();
  if (_cache.day === dayKey && (now - _cache.at) < CACHE_TTL_MS && _cache.count !== null) {
    return { count: _cache.count, as_of: new Date(_cache.at).toISOString(), source: 'bubble-cached' };
  }

  try {
    // Bubble greater-than/less-than op date is strikt; ±1ms om randen mee te doen.
    const fromIso = new Date(nlDayRange.start.getTime() - 1).toISOString();
    const toIso   = new Date(nlDayRange.endExclusive.getTime() + 1).toISOString();
    const { results } = await bubbleList('1-1-session', [
      { key: 'starting_date_date', constraint_type: 'greater than', value: fromIso },
      { key: 'starting_date_date', constraint_type: 'less than',    value: toIso   },
      { key: 'isdone_boolean',     constraint_type: 'equals',       value: true    },
    ], { limit: FETCH_CAP });

    if (results && results.length >= (FETCH_CAP - 100)) {
      console.warn('[bubble-one-on-one-count] cap-hit — mogelijk incompleet: got=' + results.length + ' cap=' + FETCH_CAP);
    }

    let count = 0;
    for (const s of (results || [])) {
      const lt = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
      if (lt !== 'Alpha Program') continue;
      const ns = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
      if (ns) continue;
      count += 1;
    }

    _cache = { at: now, day: dayKey, count };
    return { count, as_of: new Date(now).toISOString(), source: 'bubble-cached' };
  } catch (e) {
    console.warn('[bubble-one-on-one-count] Bubble-error:', e?.message || e);
    // Stale-serve als er nog een oudere waarde is voor vandaag.
    if (_cache.count !== null && _cache.day === dayKey) {
      return { count: _cache.count, as_of: new Date(_cache.at).toISOString(), source: 'bubble-stale' };
    }
    return { count: null, as_of: new Date().toISOString(), source: 'bubble-error' };
  }
}
