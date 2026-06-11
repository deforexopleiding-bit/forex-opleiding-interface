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
// Endpoints (Data API v2) - LIVE-VARIANT.
// PATH-VOLGORDE: /live komt NA itemId voor update/unpublish (v2 ondersteunt
// /items/live/{id} NIET - returnt 404). Alleen create heeft /live aan eind.
//   GET    /collections/{coll}                              — schema (read)
//   POST   /collections/{coll}/items/live                   — create LIVE item
//   PATCH  /collections/{coll}/items/{itemId}/live          — update LIVE item
//   DELETE /collections/{coll}/items/{itemId}/live          — unpublish van live site
//                                                              (item blijft als staged bestaan)
//
// WAAROM /items/live ipv /items?  De staged variant (POST /items, PATCH
// /items/{id}) maakt of update STAGED items. Die zijn NIET publiek zichtbaar
// totdat iemand een aparte site-publish (POST /sites/{site_id}/publish) doet.
// De /items/live varianten skippen die stap voor de item-records zelf.
//
// Static-list-publicatie note: Webflow's CMS Collection Page (lijst-pagina van
// een collection) is STATIC en wordt alleen ververst bij een SITE-publish.
// Nieuwe live-items via /items/live zijn dus al "live" als individuele item-
// records, maar de event-overzichtspagina (die ze in een lijst toont) ziet ze
// pas na een site-publish. Daarom is publishSiteIfEnabled() toegevoegd: env-
// flag EVENTS_WEBFLOW_SITE_PUBLISH (default 'false'). Bij 'true' doet de
// client na een succesvolle item-sync 1 POST /sites/{site_id}/publish. Default
// uit zodat staging-omgevingen geen onbedoelde site-publish triggeren.
//
// Spec G (geen DELETE op staged item) blijft gerespecteerd: we DELETEn alleen
// op de /items/{id}/live route, wat een live-unpublish is, geen item-removal.

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

// HARDCODED_FIELD_SLUGS: bron-of-truth uit recon (2026-06-11), bevestigd via
// /api/diag-f2-recon GET response (Collection 6998472019eb629c85b9c448).
//
// WAAROM HARDCODED IPV displayName-runtime-resolve?
// Eerste F2-deploy faalde: alleen het Name-veld werd ingevuld, time/locatie-2/
// event-content bleven leeg. Root cause: de runtime displayName-match in
// resolveSlug() vergelijkt exact lowercase met FIELD_NAME_MAP-target. In de
// echte collection wijken de displayNames af van onze aannames:
//   - time-veld:    onze gok 'Time' matched niet (echte displayName afwijkend)
//   - locatie-2:    onze gok 'Locatie' matched niet (slug '-2' suggereert dat
//                   een eerder Locatie-veld is verwijderd en de huidige
//                   ofwel "Locatie:" met dubbele punt, of "Locatie 2", of
//                   gewoon "Locatie" met variant-spelling heeft)
//   - event-content:onze gok 'Event Content' matched niet
//
// Recon gaf de SLUGS met zekerheid; die zijn stabiel zolang de velden niet
// verwijderd/hernoemd worden in Webflow. We hardcoden ze daarom als primaire
// source. De displayName-fallback in resolveSlug() blijft staan voor
// toekomst-resilience: als een slug onverwacht verandert detecteren we het.
const HARDCODED_FIELD_SLUGS = {
  time    : 'time',
  location: 'locatie-2',
  content : 'event-content',
};

// Map van logische naam -> kandidaat-displayName voor FALLBACK matching.
// (Hardcoded slug hierboven wint; deze map is alleen voor reserve-discovery.)
const FIELD_NAME_MAP = {
  title  : 'Name',           // Webflow stelt 'Name' altijd verplicht (slug 'name')
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

// Resolve een logische naam naar een slug. Volgorde:
//   1. HARDCODED_FIELD_SLUGS (bron-of-truth uit recon 2026-06-11)
//      Sanity-check: slug moet in collection-schema staan; anders fallback.
//   2. Displayname-fallback via FIELD_NAME_MAP (toekomst-resilience)
// Returnt null als niets gevonden (caller skipt dat veld in payload).
function resolveSlug(schema, logicalName) {
  // Stap 1: hardcoded slug uit recon
  const hardSlug = HARDCODED_FIELD_SLUGS[logicalName];
  if (hardSlug) {
    if (schema.fieldsBySlug?.[hardSlug]) {
      return hardSlug;
    }
    console.warn(
      `[webflow-client] HARDCODED slug '${hardSlug}' voor '${logicalName}' ` +
      'NIET in collection-schema gevonden - fallback op displayName-match'
    );
  }
  // Stap 2: displayName-fallback
  const target = FIELD_NAME_MAP[logicalName];
  if (!target) return null;
  const f = schema.fieldsByDisplayName[String(target).toLowerCase()];
  if (!f) {
    console.warn(
      `[webflow-client] FALLBACK displayName-match faalde voor '${logicalName}' ` +
      `(zocht '${target}'). Veld wordt SKIPPED in payload.`
    );
  }
  return f?.slug || null;
}

// Best-effort enum-mapping voor Event Type. Returnt option-shape die naar
// Webflow gestuurd kan worden (id wanneer aanwezig, anders name).
//
// LOCKED OFF na recon (2026-06-11): de "category"-opties in productie zijn
// content-categorieen ("Forex Kickstart Live"/"Trading Deep Dive") plus junk,
// GEEN skill-niveaus. Mapping naar events.niveau geeft dus altijd misclassificatie.
// Helper blijft staan voor schema-introspectie/debug + toekomstige re-introduce
// als juiste niveau-opties in het collection-schema worden aangemaakt.
// CALLER buildFieldData() roept matchEventTypeOption() NIET meer aan.
// includes-fallback verwijderd: bij re-introduce alleen exacte name-match
// (geen risico op stille mismatch).
function matchEventTypeOption(schema, niveau) {
  if (!niveau || !Array.isArray(schema.eventTypeOptions) || schema.eventTypeOptions.length === 0) {
    return null;
  }
  const lc = String(niveau).toLowerCase();
  // Alleen exacte name-match. Geen includes-fallback (recon-lock).
  const opt = schema.eventTypeOptions.find((o) =>
    String(o?.name || '').toLowerCase() === lc
  );
  if (!opt) {
    console.warn('[webflow-client] geen exacte Event Type-match voor niveau:', niveau);
    return null;
  }
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

  // Event Type / category veld: niveau-mapping LOCKED OFF na recon (2026-06-11).
  // De bestaande "category" opties zijn "Forex Kickstart Live" / "Trading Deep
  // Dive" + junk ("d", "E") - GEEN skill-niveaus (basis/gevorderd). Er bestaat
  // dus geen Webflow-tegenhanger voor events.niveau in dit collection-schema.
  // We laten category ongezet bij sync; events.niveau blijft alleen lokaal in
  // onze DB. (FIELD_NAME_MAP/getCollectionSchema behouden de niveau-entry voor
  // schema-introspectie + toekomstige re-introduce bij juiste opties.)

  return fd;
}

// ── Optionele site-publish ────────────────────────────────────────────────────
//
// Webflow's Collection-overzichtspagina (statische lijst-pagina van een
// collection) wordt alleen ververst bij een site-publish. Individuele items
// via /items/live zijn al "live" als records, maar tonen pas in de lijst-
// pagina na deze call.
//
// Gated achter env-flag EVENTS_WEBFLOW_SITE_PUBLISH (default 'false'). Bij
// 'true' wordt na een succesvolle item-sync 1 POST /sites/{site_id}/publish
// gedaan. Optioneel: WEBFLOW_CUSTOM_DOMAIN_IDS (comma-separated) om naar
// custom-domain te publiceren; standaard alleen Webflow-subdomain.
//
// Errors in deze call breken de item-sync NIET (defensive try/catch). Caller
// ontvangt de uitkomst via return.sitePublish voor logging.
async function publishSiteIfEnabled(context = '') {
  const flag = String(process.env.EVENTS_WEBFLOW_SITE_PUBLISH || 'false').toLowerCase();
  if (flag !== 'true') {
    return { skipped: true, reason: 'EVENTS_WEBFLOW_SITE_PUBLISH != true' };
  }
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    console.warn(`[webflow-client] site-publish skipped (${context}): WEBFLOW_SITE_ID missing`);
    return { skipped: true, reason: 'WEBFLOW_SITE_ID missing' };
  }

  const customDomainsRaw = process.env.WEBFLOW_CUSTOM_DOMAIN_IDS || '';
  const customDomains = customDomainsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const body = customDomains.length > 0
    ? { customDomains, publishToWebflowSubdomain: true }
    : { publishToWebflowSubdomain: true };

  console.log(
    `[webflow-client] site-publish triggered (${context}): site=${siteId}, ` +
    `customDomains=${customDomains.length}, subdomain=true`
  );

  try {
    const data = await webflowFetch(`/sites/${siteId}/publish`, {
      method: 'POST',
      body,
    });
    console.log(
      `[webflow-client] site-publish OK (${context}): ${JSON.stringify(data || {}).slice(0, 200)}`
    );
    return { ok: true, body, response: data };
  } catch (e) {
    console.warn(`[webflow-client] site-publish FAILED (${context}): ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createLiveItem({ event, descriptionHtml }) {
  if (!event?.id || !event?.title || !event?.starts_at) {
    throw new WebflowError('VALIDATION_FAIL', 'event.id/title/starts_at vereist');
  }
  const { collId } = getEnv();
  const schema = await getCollectionSchema();
  const fieldData = buildFieldData({ event, descriptionHtml, schema });

  // POST /items/live - publiceert direct op live site, geen aparte site-publish nodig.
  const body = {
    isArchived: false,
    isDraft   : false,
    fieldData,
  };

  const data = await webflowFetch(`/collections/${collId}/items/live`, {
    method: 'POST',
    body,
  });

  // /items/live returnt 202 Accepted met item-object (of items[] bij batch).
  // Single-item POST returnt het object direct met id; we accepteren ook batch-shape.
  const itemId = data?.id
    || data?.items?.[0]?.id
    || data?.item?.id
    || null;
  if (!itemId) {
    throw new WebflowError('VALIDATION_FAIL', 'Webflow create-live response zonder item id', { body: data });
  }

  const sitePublish = await publishSiteIfEnabled('create-' + itemId);
  return { itemId, raw: data, requestPayload: body, sitePublish };
}

export async function updateItem({ webflowItemId, event, descriptionHtml }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  if (!event?.id)     throw new WebflowError('VALIDATION_FAIL', 'event.id vereist');
  const { collId } = getEnv();
  const schema = await getCollectionSchema();
  const fieldData = buildFieldData({ event, descriptionHtml, schema });

  // PATCH /items/live/{id} - update LIVE item (item is + blijft publiek zichtbaar).
  const body = {
    isArchived: false,
    isDraft   : false,
    fieldData,
  };

  // PATCH /items/{id}/live - update LIVE item (item blijft publiek zichtbaar).
  // PATH-volgorde: /live komt NA itemId. /items/live/{id} bestaat NIET in v2.
  const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}/live`, {
    method: 'PATCH',
    body,
  });

  const sitePublish = await publishSiteIfEnabled('update-' + webflowItemId);
  return { itemId: webflowItemId, raw: data, requestPayload: body, sitePublish };
}

export async function unpublishItem({ webflowItemId }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  const { collId } = getEnv();

  // DELETE /items/{id}/live - verwijdert ALLEEN de live-publicatie. Het item
  // blijft als staged record bestaan (kan later hergepubliceerd worden).
  // Geen body nodig. PATH-volgorde: /live komt NA itemId.
  const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}/live`, {
    method: 'DELETE',
  });

  const sitePublish = await publishSiteIfEnabled('unpublish-' + webflowItemId);
  return { itemId: webflowItemId, raw: data, requestPayload: null, sitePublish };
}
