// api/_lib/ghl-custom-field.js
//
// GoHighLevel LeadConnector v3 client voor het bijwerken van een location-
// scoped dropdown-custom-field 'single_dropdown_12e8o'. Wordt gebruikt door
// Events F2 publish-sync om de upcoming-events lijst (labels) gesynchroniseerd
// te houden met het GHL form-builder dropdown.
//
// Defensief design:
//   - Runtime field-id resolve via /locations/{loc}/customFields (cached 30m)
//   - Runtime detect van de GET options-array-key (voor read-context)
//     (candidates: options/picklistOptions/choices/textBoxList)
//   - Graceful degradation: 401/403 of body-shape-mismatch returnt
//     { skipped:true, reason } - de orchestrator faalt niet op een GHL-error
//     omdat Webflow het primaire kanaal is.
//
// RECON-LOCK (2026-06-11) - GHL GET/PUT key-asymmetrie:
//   GET-respons gebruikt 'picklistOptions' als options-array key.
//   PUT-body VERPLICHT 'options' (GHL returnt 422 "property picklistOptions
//   should not exist" bij elke andere key). Scope is OK (geen 401/403).
//   updateOptions() forceert daarom PUT_OPTIONS_KEY='options' ongeacht
//   GET-detect. Primaire shape = string-array (recon: primitive strings);
//   bij 422 fallback naar object-shapes [{key,label}] -> [{value,label}].
//   Field-id: BG0wJnnZegEaNzK856Rj, dataType SINGLE_OPTIONS.
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

  const { fieldId, rawFieldBody } = resolved;

  // RECON-LOCK (2026-06-11): GET-key (picklistOptions) is NIET de PUT-key.
  // GHL accepteert alleen 'options' in de PUT-body; anders 422
  // "property picklistOptions should not exist". Detect-from-GET (optionsKey
  // op resolved) blijft als read-context maar wordt hier NIET gebruikt.
  const PUT_OPTIONS_KEY = 'options';

  // Minimale PUT-body: alleen velden die GHL plausibel accepteert.
  // Recon-output bevestigde dataType=SINGLE_OPTIONS + name onveranderd.
  // Geen volledige mirror van rawFieldBody (zou picklistOptions terug-leveren
  // en triggert 422).
  const baseBody = {
    name    : rawFieldBody?.name || rawFieldBody?.displayName,
    dataType: rawFieldBody?.dataType || rawFieldBody?.type,
  };

  // Drie shape-pogingen in volgorde:
  //   1. string-array (primair - recon: primitive strings)
  //   2. [{key,label}] object-shape
  //   3. [{value,label}] object-shape
  // Bij 422 doorgaan naar volgende; bij 401/403 of andere statussen stoppen.
  const attempts = [
    { shape: 'string_array',        build: () => labels.map((l) => String(l)) },
    { shape: 'object_key_label',    build: () => labels.map((l) => ({ key:   String(l), label: String(l) })) },
    { shape: 'object_value_label',  build: () => labels.map((l) => ({ value: String(l), label: String(l) })) },
  ];

  const triedShapes = [];
  let lastResp = null;

  for (const attempt of attempts) {
    const opts = attempt.build();
    const putBody = { ...baseBody, [PUT_OPTIONS_KEY]: opts };

    const putResp = await ghlFetch(`/locations/${GHL_LOCATION}/customFields/${fieldId}`, {
      method: 'PUT',
      body  : putBody,
    });
    triedShapes.push({ shape: attempt.shape, status: putResp.status });
    lastResp = putResp;

    if (putResp.ok) {
      // Log welke shape uiteindelijk werkte - handig bij toekomstige
      // wijzigingen aan de GHL API.
      if (attempt.shape !== 'string_array') {
        console.warn('[ghl-custom-field] PUT_OPTIONS_KEY="options" + shape', attempt.shape,
          '- string_array faalde met', triedShapes[0]?.status);
      }
      return {
        ok             : true,
        put_options_key: PUT_OPTIONS_KEY,
        used_shape     : attempt.shape,
        optionsCount   : opts.length,
        tried_shapes   : triedShapes,
        // Backward-compat alias voor orchestrator audit-log (event_sync_log
        // response_payload kent optionsKey nog uit de mirror-tijd).
        optionsKey     : PUT_OPTIONS_KEY,
      };
    }

    // 401/403: scope-issue, geen retry zinnig
    if (putResp.status === 401 || putResp.status === 403) {
      return {
        skipped     : true,
        reason      : 'GHL_AUTH_OR_SCOPE_FAIL',
        message     : `PUT ${putResp.status}`,
        tried_shapes: triedShapes,
      };
    }

    // 400/422: shape-mismatch, probeer volgende shape
    if (putResp.status === 400 || putResp.status === 422) {
      // Loop verder
      continue;
    }

    // Andere fout: stop direct (5xx / netwerk / unexpected)
    return {
      ok          : false,
      error_code  : 'GHL_DOWN',
      message     : `GHL PUT customField ${putResp.status}: ${putResp.body?.message || putResp.error || 'unknown'}`,
      tried_shapes: triedShapes,
    };
  }

  // Alle 3 shapes gefaald met 400/422 - log de mismatch voor follow-up
  console.warn('[ghl-custom-field] ALL 3 shapes mismatched on PUT options key. tried:', triedShapes);
  return {
    skipped     : true,
    reason      : 'GHL_SHAPE_MISMATCH',
    message     : `Alle shapes faalden. Last: ${lastResp?.status} ${lastResp?.body?.message || ''}`,
    tried_shapes: triedShapes,
  };
}
