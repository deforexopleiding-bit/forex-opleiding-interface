// api/_lib/webflow-client.js
//
// Webflow Data API v2 client voor Events F2 publish-sync.
//
// Verantwoordelijkheden:
//   - Auth via WEBFLOW_API_TOKEN bearer
//   - Runtime schema-discovery: lees collection-fields ipv hardcoded slugs
//   - Defensieve version-header probe: probeer zonder Accept-Version eerst
//     (v2 is default). Bij 406/400: retry met 'Accept-Version: 2.0.0'.
//   - Best-effort enum-mapping voor Event Type op basis van schema.options
//   - Typed errors zodat caller (event-sync-orchestrator) ze kan loggen
//     en mappen op event_sync_log.error_code
//
// Endpoints (Data API v2):
//   GET    /collections/{coll}                — schema
//   POST   /collections/{coll}/items          — create LIVE item (isDraft:false)
//   PATCH  /collections/{coll}/items/{itemId} — update of unpublish (isDraft:true)
//
// Niet ondersteund (per spec G): DELETE. Unpublish gaat via isDraft=true.

const WEBFLOW_API_BASE   = 'https://api.webflow.com/v2';
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

// In-memory module-scope cache. Reset bij elke koude Lambda-start (acceptabel).
let _schemaCache = {
  collectionId       : null,
  fieldsBySlug       : null,         // { slug -> field-object }
  fieldsByDisplayName: null,         // { lower(displayName) -> field-object }
  eventTypeOptions   : null,         // array van { id?, name, slug? }
  lastFetched        : 0,
};

// Welke version-header werkte voor de laatste succesvolle call (null = default).
let _versionHeaderShape = null; // null of '2.0.0'

// Typed Error-class
export class WebflowError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name   = 'WebflowError';
    this.code   = code;
    this.detail = detail;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getEnv() {
  const token  = process.env.WEBFLOW_API_TOKEN || null;
  const collId = process.env.WEBFLOW_EVENTS_COLLECTION_ID || null;
  if (!token)  throw new WebflowError('AUTH_FAIL',     'WEBFLOW_API_TOKEN ontbreekt in env');
  if (!collId) throw new WebflowError('VALIDATION_FAIL','WEBFLOW_EVENTS_COLLECTION_ID ontbreekt in env');
  return { token, collId };
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'AUTH_FAIL';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 422) return 'VALIDATION_FAIL';
  if (status >= 500) return 'WEBFLOW_DOWN';
  return 'UNKNOWN';
}

// Format starts_at als 'woensdag 24 juni 2026 om 18:00' (nl-NL local).
function formatStartsAtNl(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    const dateFmt = new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Europe/Amsterdam',
    });
    const timeFmt = new Intl.DateTimeFormat('nl-NL', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Europe/Amsterdam',
    });
    return `${dateFmt.format(dt)} om ${timeFmt.format(dt)}`;
  } catch {
    return String(iso);
  }
}

// Fetch met version-header probe en typed-error mapping
async function webflowFetch(path, opts = {}) {
  const { token } = getEnv();

  const baseHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type' : 'application/json',
    'Accept'       : 'application/json',
  };

  // Kies header-shape: cached zoals laatst gewerkt, anders probeer zonder.
  const versionsToTry = _versionHeaderShape === '2.0.0'
    ? ['2.0.0', null]
    : [null, '2.0.0'];

  let lastError = null;

  for (const version of versionsToTry) {
    const headers = { ...baseHeaders };
    if (version) headers['Accept-Version'] = version;

    let resp;
    try {
      resp = await fetch(`${WEBFLOW_API_BASE}${path}`, {
        method : opts.method  || 'GET',
        headers,
        body   : opts.body    ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new WebflowError('WEBFLOW_DOWN', `Netwerkfout: ${e?.message || 'fetch failed'}`, { cause: String(e) });
    }

    // Probe-failure (zou aan een verkeerde version-header kunnen liggen)
    if ((resp.status === 406 || resp.status === 400) && version !== versionsToTry[versionsToTry.length - 1]) {
      lastError = { status: resp.status };
      continue; // probeer de andere shape
    }

    // Onthoud welke shape werkte (alleen bij echte success)
    if (resp.ok) {
      _versionHeaderShape = version || null;
    }

    // Parse body (kan leeg zijn bij 204)
    let bodyJson = null;
    const text = await resp.text();
    if (text) {
      try { bodyJson = JSON.parse(text); } catch { bodyJson = { raw: text }; }
    }

    if (!resp.ok) {
      const code = classifyStatus(resp.status);
      throw new WebflowError(
        code,
        `Webflow ${resp.status} op ${path}: ${bodyJson?.message || bodyJson?.msg || text || 'unknown'}`,
        { status: resp.status, body: bodyJson }
      );
    }

    return bodyJson;
  }

  // Niet bereikt onder normale flow, defensive fallback
  throw new WebflowError(
    classifyStatus(lastError?.status || 500),
    `Webflow probe-failure: ${lastError?.status}`,
    lastError
  );
}

// ── Schema discovery ──────────────────────────────────────────────────────────

// Map van logische naam -> kandidaat-displayName voor matching.
const FIELD_NAME_MAP = {
  title  : 'Name',           // Webflow stelt 'Name' altijd verplicht
  time   : 'Time',
  location: 'Locatie',
  content: 'Event Content',
  niveau : 'Event Type',
};

// Vind een field waar displayName case-insensitive matched.
function findFieldByDisplayName(fields, target) {
  if (!Array.isArray(fields) || !target) return null;
  const lcTarget = String(target).toLowerCase();
  return fields.find((f) =>
    String(f?.displayName || f?.name || '').toLowerCase() === lcTarget
  ) || null;
}

// Parse Event Type options uit field.validations.options of vergelijkbaar
function extractOptionsFromField(field) {
  if (!field) return [];
  const validations = field.validations || field.metadata || {};
  const candidates  = [
    validations.options,
    validations.choices,
    field.options,
    field.choices,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

export async function getCollectionSchema(opts = {}) {
  const { force = false } = opts || {};
  const { collId } = getEnv();

  const now = Date.now();
  const fresh = (
    !force &&
    _schemaCache.collectionId === collId &&
    _schemaCache.fieldsBySlug &&
    (now - _schemaCache.lastFetched) < SCHEMA_CACHE_TTL_MS
  );
  if (fresh) return _schemaCache;

  const data = await webflowFetch(`/collections/${collId}`, { method: 'GET' });

  const fields = Array.isArray(data?.fields) ? data.fields : [];

  const fieldsBySlug        = {};
  const fieldsByDisplayName = {};
  for (const f of fields) {
    if (f?.slug)         fieldsBySlug[f.slug] = f;
    if (f?.displayName)  fieldsByDisplayName[String(f.displayName).toLowerCase()] = f;
    if (f?.name)         fieldsByDisplayName[String(f.name).toLowerCase()] = f;
  }

  // Event Type opties
  const eventTypeField   = findFieldByDisplayName(fields, FIELD_NAME_MAP.niveau);
  const eventTypeOptions = extractOptionsFromField(eventTypeField);

  _schemaCache = {
    collectionId       : collId,
    fieldsBySlug,
    fieldsByDisplayName,
    eventTypeOptions,
    lastFetched        : now,
  };

  return _schemaCache;
}

// Resolve een logische naam naar een slug via schema-cache. Returnt null als
// niet gevonden (caller skipt dat veld in payload).
function resolveSlug(schema, logicalName) {
  const target = FIELD_NAME_MAP[logicalName];
  if (!target) return null;
  const f = schema.fieldsByDisplayName[String(target).toLowerCase()];
  return f?.slug || null;
}

// Best-effort enum-mapping voor Event Type. Returnt option-shape die naar
// Webflow gestuurd kan worden (id wanneer aanwezig, anders name).
//
// TODO: na recon-spike output update deze mapping met definitieve option-IDs.
function matchEventTypeOption(schema, niveau) {
  if (!niveau || !Array.isArray(schema.eventTypeOptions) || schema.eventTypeOptions.length === 0) {
    return null;
  }
  const lc = String(niveau).toLowerCase();
  // Strategie 1: exacte name-match
  let opt = schema.eventTypeOptions.find((o) =>
    String(o?.name || '').toLowerCase() === lc
  );
  // Strategie 2: includes-match (label bevat niveau-slug)
  if (!opt) {
    opt = schema.eventTypeOptions.find((o) =>
      String(o?.name || '').toLowerCase().includes(lc)
    );
  }
  if (!opt) {
    console.warn('[webflow-client] geen Event Type match voor niveau:', niveau);
    return null;
  }
  // Webflow Data API v2 accepteert vaak de option-id als string; sommige
  // collecties verwachten de option-name. We sturen wat aanwezig is.
  return opt.id || opt.slug || opt.name || null;
}

// Bouw fieldData payload met defensieve slug-resolution.
function buildFieldData({ event, descriptionHtml, schema }) {
  const fd = {};

  // Name is verplicht en heeft een vaste slug 'name' in Webflow v2.
  // We bouwen het tonen-label: "<title> - <nl-NL datum om HH:MM>".
  const titlePart = String(event?.title || '').trim();
  const datePart  = formatStartsAtNl(event?.starts_at);
  const display   = datePart ? `${titlePart} - ${datePart}` : titlePart;
  fd.name = display;

  // Slug is verplicht in Data API v2 (auto-uniek). Wij forceren stable slug
  // op basis van event.id zodat herpublish hetzelfde item raakt.
  if (event?.id) fd.slug = `event-${event.id}`;

  // Time veld
  const timeSlug = resolveSlug(schema, 'time');
  if (timeSlug && event?.starts_at) {
    fd[timeSlug] = event.starts_at;
  } else if (!timeSlug) {
    console.warn('[webflow-client] geen slug voor Time-veld in schema; skip');
  }

  // Locatie veld
  const locSlug = resolveSlug(schema, 'location');
  if (locSlug && (event?.location || event?.location === '')) {
    fd[locSlug] = event.location || '';
  } else if (!locSlug) {
    console.warn('[webflow-client] geen slug voor Locatie-veld in schema; skip');
  }

  // Event Content veld (HTML uit markdown)
  const contentSlug = resolveSlug(schema, 'content');
  if (contentSlug) {
    fd[contentSlug] = descriptionHtml || '';
  } else {
    console.warn('[webflow-client] geen slug voor Event Content-veld in schema; skip');
  }

  // Event Type veld (best-effort enum)
  const typeSlug = resolveSlug(schema, 'niveau');
  if (typeSlug) {
    const optionValue = matchEventTypeOption(schema, event?.niveau);
    if (optionValue) {
      fd[typeSlug] = optionValue;
    } else {
      console.warn('[webflow-client] Event Type-veld bekend maar geen option-match voor', event?.niveau, '; skip veld');
    }
  } else {
    console.warn('[webflow-client] geen slug voor Event Type-veld in schema; skip');
  }

  return fd;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createLiveItem({ event, descriptionHtml }) {
  if (!event?.id || !event?.title || !event?.starts_at) {
    throw new WebflowError('VALIDATION_FAIL', 'event.id/title/starts_at vereist');
  }
  const { collId } = getEnv();
  const schema = await getCollectionSchema();
  const fieldData = buildFieldData({ event, descriptionHtml, schema });

  const body = {
    isDraft: false,
    fieldData,
  };

  const data = await webflowFetch(`/collections/${collId}/items`, {
    method: 'POST',
    body,
  });

  // Items API v2 returnt item-object met id
  const itemId = data?.id || data?.item?.id || null;
  if (!itemId) {
    throw new WebflowError('VALIDATION_FAIL', 'Webflow create response zonder item id', { body: data });
  }
  return { itemId, raw: data, requestPayload: body };
}

export async function updateItem({ webflowItemId, event, descriptionHtml }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  if (!event?.id)     throw new WebflowError('VALIDATION_FAIL', 'event.id vereist');
  const { collId } = getEnv();
  const schema = await getCollectionSchema();
  const fieldData = buildFieldData({ event, descriptionHtml, schema });

  const body = {
    isDraft: false,
    fieldData,
  };

  const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}`, {
    method: 'PATCH',
    body,
  });

  return { itemId: webflowItemId, raw: data, requestPayload: body };
}

export async function unpublishItem({ webflowItemId }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  const { collId } = getEnv();

  const body = { isDraft: true };

  const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}`, {
    method: 'PATCH',
    body,
  });

  return { itemId: webflowItemId, raw: data, requestPayload: body };
}
