// api/_lib/ghl-custom-field.js
//
// GoHighLevel LeadConnector v3 client voor het bijwerken van een location-
// scoped dropdown-custom-field 'single_dropdown_12e8o'. Wordt gebruikt door
// Events F2 publish-sync om de upcoming-events lijst (labels) gesynchroniseerd
// te houden met het GHL form-builder dropdown.
//
// Defensief design:
//   - Runtime field-id resolve via /locations/{loc}/customFields (cached 30m)
//   - Runtime detect van de juiste options-array-key
//     (candidates: options/picklistOptions/choices/textBoxList)
//   - Runtime detect van item-shape binnen die array (object {id,name,value}
//     vs plain string). Bij update mirroren we exact dezelfde shape terug.
//   - Graceful degradation: 401/403 of body-shape-mismatch returnt
//     { skipped:true, reason } - de orchestrator faalt niet op een GHL-error
//     omdat Webflow het primaire kanaal is.
//
// Constants:
//   GHL_BASE        = https://services.leadconnectorhq.com
//   GHL_VERSION     = '2021-07-28' (v3 LeadConnector standaard header)
//   GHL_LOCATION    = hardcoded 'YdIAWnq0DutM7VNOGReg' (Events-specifieke loc)
//   TARGET_FIELD_KEY = 'single_dropdown_12e8o'

const GHL_BASE        = 'https://services.leadconnectorhq.com';
const GHL_VERSION     = '2021-07-28';
const GHL_LOCATION    = 'YdIAWnq0DutM7VNOGReg';
const TARGET_FIELD_KEY = 'single_dropdown_12e8o';

const FIELD_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

const OPTIONS_KEY_CANDIDATES = ['options', 'picklistOptions', 'choices', 'textBoxList'];

let _fieldCache = {
  fieldId      : null,
  optionsKey   : null,                    // 'options' | 'picklistOptions' | ...
  fieldShape   : null,                    // 'object' | 'string'
  rawFieldBody : null,                    // raw GHL custom-field object voor latere mirror
  lastFetched  : 0,
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function getToken() {
  const t = process.env.GHL_EVENTS_PIT_TOKEN || null;
  return t;
}

function ghlHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Version'      : GHL_VERSION,
    'Content-Type' : 'application/json',
    'Accept'       : 'application/json',
  };
}

async function ghlFetch(path, opts = {}) {
  const token = getToken();
  if (!token) {
    return { ok: false, status: 0, body: null, error: 'GHL_EVENTS_PIT_TOKEN ontbreekt' };
  }
  let resp;
  try {
    resp = await fetch(`${GHL_BASE}${path}`, {
      method : opts.method || 'GET',
      headers: ghlHeaders(token),
      body   : opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, body: null, error: `network: ${e?.message || 'fetch failed'}` };
  }
  const text = await resp.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  return { ok: resp.ok, status: resp.status, body, error: null };
}

// Pak de array met custom-fields uit de respons (probeer meerdere keys)
function extractCustomFieldsArray(body) {
  if (!body) return null;
  if (Array.isArray(body)) return body;
  const candidates = [body.customFields, body.data, body.fields, body.items];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return null;
}

// Detect welke key in een field-object de options-array bevat
function detectOptionsKey(field) {
  if (!field || typeof field !== 'object') return null;
  for (const k of OPTIONS_KEY_CANDIDATES) {
    if (Array.isArray(field[k])) return k;
  }
  return null;
}

// Detect of items in de array objecten zijn of plain strings
function detectShape(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 'object'; // default
  const first = arr[0];
  if (typeof first === 'string') return 'string';
  return 'object';
}

// Capitalize eerste letter (voor 'woensdag' -> 'Woensdag')
function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Format een event-rij naar het label-formaat voor de GHL-dropdown.
 *   met ends_at: 'Woensdag 24 juni 2026 | 18:00 - 21:00'
 *   zonder ends_at: 'Woensdag 24 juni 2026 | 18:00'
 */
export function formatEventLabel(event) {
  if (!event?.starts_at) return '';
  try {
    const start = new Date(event.starts_at);
    const dateFmt = new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Europe/Amsterdam',
    });
    const timeFmt = new Intl.DateTimeFormat('nl-NL', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Europe/Amsterdam',
    });
    const datePart  = capitalize(dateFmt.format(start));
    const startTime = timeFmt.format(start);
    if (event.ends_at) {
      const end = new Date(event.ends_at);
      const endTime = timeFmt.format(end);
      return `${datePart} | ${startTime} - ${endTime}`;
    }
    return `${datePart} | ${startTime}`;
  } catch {
    return '';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve het target field-id + options-key + shape. Cache 30min.
 * Returnt:
 *   - success: { ok:true, fieldId, optionsKey, fieldShape, rawFieldBody }
 *   - skipped: { skipped:true, reason }
 *   - error  : { ok:false, error_code, message }
 */
export async function resolveFieldId(opts = {}) {
  const { force = false } = opts || {};
  const now = Date.now();

  if (!force && _fieldCache.fieldId && (now - _fieldCache.lastFetched) < FIELD_CACHE_TTL_MS) {
    return {
      ok          : true,
      fieldId     : _fieldCache.fieldId,
      optionsKey  : _fieldCache.optionsKey,
      fieldShape  : _fieldCache.fieldShape,
      rawFieldBody: _fieldCache.rawFieldBody,
      cached      : true,
    };
  }

  if (!getToken()) {
    return { skipped: true, reason: 'GHL_AUTH_OR_SCOPE_FAIL', message: 'GHL_EVENTS_PIT_TOKEN ontbreekt' };
  }

  // Stap 1: list custom fields voor location
  const listResp = await ghlFetch(`/locations/${GHL_LOCATION}/customFields`, { method: 'GET' });

  if (!listResp.ok) {
    if (listResp.status === 401 || listResp.status === 403) {
      return { skipped: true, reason: 'GHL_AUTH_OR_SCOPE_FAIL', message: `GHL list customFields ${listResp.status}` };
    }
    return {
      ok        : false,
      error_code: 'GHL_DOWN',
      message   : `GHL list customFields ${listResp.status}: ${listResp.body?.message || listResp.error || 'unknown'}`,
    };
  }

  const arr = extractCustomFieldsArray(listResp.body);
  if (!Array.isArray(arr)) {
    return {
      ok        : false,
      error_code: 'GHL_SHAPE_MISMATCH',
      message   : 'GHL customFields response heeft geen herkenbare array',
    };
  }

  // Vind field op key/fieldKey/uniqueKey - GHL gebruikt 'fieldKey' (location.<key>)
  const matched = arr.find((f) => {
    const candidates = [
      f?.fieldKey,
      f?.key,
      f?.uniqueKey,
      f?.field_key,
    ].filter(Boolean).map((s) => String(s).toLowerCase());
    const target = String(TARGET_FIELD_KEY).toLowerCase();
    return candidates.some((c) => c === target || c.endsWith(`.${target}`));
  });

  if (!matched) {
    return {
      ok        : false,
      error_code: 'GHL_FIELD_NOT_FOUND',
      message   : `Custom field '${TARGET_FIELD_KEY}' niet gevonden in location ${GHL_LOCATION}`,
    };
  }

  const fieldId = matched.id || matched._id || null;
  if (!fieldId) {
    return {
      ok        : false,
      error_code: 'GHL_SHAPE_MISMATCH',
      message   : 'Custom field gevonden maar zonder id',
    };
  }

  // Stap 2: GET single field om actuele shape + options te hebben
  const fieldResp = await ghlFetch(`/locations/${GHL_LOCATION}/customFields/${fieldId}`, { method: 'GET' });

  let fieldBody = matched; // fallback naar list-item
  if (fieldResp.ok && fieldResp.body) {
    fieldBody = fieldResp.body?.customField || fieldResp.body?.data || fieldResp.body;
  }

  const optionsKey = detectOptionsKey(fieldBody);
  if (!optionsKey) {
    return {
      ok        : false,
      error_code: 'GHL_SHAPE_MISMATCH',
      message   : `Custom field '${TARGET_FIELD_KEY}' heeft geen herkenbare options-array (tried: ${OPTIONS_KEY_CANDIDATES.join(',')})`,
    };
  }

  const fieldShape = detectShape(fieldBody[optionsKey]);

  _fieldCache = {
    fieldId,
    optionsKey,
    fieldShape,
    rawFieldBody: fieldBody,
    lastFetched : now,
  };

  return {
    ok          : true,
    fieldId,
    optionsKey,
    fieldShape,
    rawFieldBody: fieldBody,
    cached      : false,
  };
}

/**
 * Update de options-array van het target custom-field met de gegeven labels.
 *
 * @param {{labels: string[]}} args
 * @returns
 *   - success: { ok:true, optionsKey, optionsCount }
 *   - graceful skip: { skipped:true, reason: 'GHL_AUTH_OR_SCOPE_FAIL' | 'GHL_SHAPE_MISMATCH' }
 *   - error: { ok:false, error_code:'GHL_DOWN', message }
 */
export async function updateOptions({ labels }) {
  if (!Array.isArray(labels)) {
    return { ok: false, error_code: 'INVALID_INPUT', message: 'labels must be array' };
  }

  const resolved = await resolveFieldId();
  if (resolved.skipped) return resolved;
  if (!resolved.ok)    return resolved;

  const { fieldId, optionsKey, fieldShape, rawFieldBody } = resolved;

  // Bouw nieuwe options-array in dezelfde shape als oorspronkelijk
  let newOptionsArr;
  if (fieldShape === 'string') {
    newOptionsArr = labels.map((l) => String(l));
  } else {
    // object-shape: probeer {id,name,value} of {label,value} - we gebruiken
    // de keys die we observeren in de bestaande array indien aanwezig
    const sample = Array.isArray(rawFieldBody?.[optionsKey]) && rawFieldBody[optionsKey][0]
      ? rawFieldBody[optionsKey][0]
      : null;
    const sampleKeys = sample && typeof sample === 'object' ? Object.keys(sample) : null;

    newOptionsArr = labels.map((l) => {
      const str = String(l);
      if (sampleKeys && sampleKeys.length > 0) {
        const obj = {};
        for (const k of sampleKeys) {
          if (k === 'id' || k === '_id') {
            // Laat GHL nieuwe id toewijzen - skippen vermijdt collisions
            continue;
          } else if (k === 'name' || k === 'label' || k === 'text' || k === 'displayName') {
            obj[k] = str;
          } else if (k === 'value' || k === 'key') {
            obj[k] = str;
          } else {
            // Onbekende key: kopieer leeg om shape te behouden
            obj[k] = '';
          }
        }
        // Zorg dat er minstens 1 zinnig veld is
        if (!('name' in obj) && !('label' in obj) && !('value' in obj)) {
          obj.name  = str;
          obj.value = str;
        }
        return obj;
      }
      // Geen sample beschikbaar: veilige defaults
      return { name: str, value: str };
    });
  }

  // Mirror bestaande body, replace alleen de options-array
  const putBody = { ...(rawFieldBody || {}) };
  putBody[optionsKey] = newOptionsArr;
  // Verwijder velden die GHL niet accepteert op PUT (defensief)
  delete putBody.id;
  delete putBody._id;
  delete putBody.locationId;
  delete putBody.dateAdded;
  delete putBody.dateUpdated;

  const putResp = await ghlFetch(`/locations/${GHL_LOCATION}/customFields/${fieldId}`, {
    method: 'PUT',
    body  : putBody,
  });

  if (!putResp.ok) {
    if (putResp.status === 401 || putResp.status === 403) {
      return { skipped: true, reason: 'GHL_AUTH_OR_SCOPE_FAIL', message: `PUT ${putResp.status}` };
    }
    if (putResp.status === 400 || putResp.status === 422) {
      return { skipped: true, reason: 'GHL_SHAPE_MISMATCH', message: `PUT ${putResp.status}: ${putResp.body?.message || ''}` };
    }
    return {
      ok        : false,
      error_code: 'GHL_DOWN',
      message   : `GHL PUT customField ${putResp.status}: ${putResp.body?.message || putResp.error || 'unknown'}`,
    };
  }

  return {
    ok          : true,
    optionsKey,
    optionsCount: newOptionsArr.length,
  };
}
