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
// pas na een site-publish.
//
// SITE-PUBLISH (Blok 2 PR 4): publishSite() doet de raw POST
// /sites/{site_id}/publish (idempotent, 429 = retry-baar). De auto-publish
// orchestratie zit in api/_lib/webflow-publish.js: maybePublishSite() leest
// de DB-toggle (app_settings.webflow_auto_publish_enabled), houdt een
// lock + trailing-debounce bij in app_settings.webflow_publish_state zodat
// een burst van mutaties coalesceert tot ~1 publish, en zet pending=true
// als de toggle UIT is voor catch-up later.
//
// publishSiteIfEnabled() blijft als thin wrapper voor de bestaande callers
// in deze file; hij delegeert nu naar maybePublishSite. De oude env-flag
// EVENTS_WEBFLOW_SITE_PUBLISH is geen autoriteit meer; de DB-toggle wint.
//
// Spec G (geen DELETE op staged item) blijft gerespecteerd: we DELETEn alleen
// op de /items/{id}/live route, wat een live-unpublish is, geen item-removal.

const WEBFLOW_API_BASE   = 'https://api.webflow.com/v2';
const SCHEMA_CACHE_TTL_MS   = 5 * 60 * 1000;   // 5 min
const TEMPLATE_CACHE_TTL_MS = 10 * 60 * 1000;  // 10 min (templates wijzigen zelden)

// Mapping: lowercase Event Type option-NAME -> events.niveau slug.
// Wordt gebruikt bij template-discovery om elk Webflow CMS-item te classifyeren
// als basis- of gevorderd-template op basis van zijn category-veld.
const WEBFLOW_TYPE_TO_NIVEAU = {
  'forex kickstart live': 'basis',
  'trading deep dive'   : 'gevorderd',
};

// In-memory module-scope cache. Reset bij elke koude Lambda-start (acceptabel).
let _schemaCache = {
  collectionId       : null,
  fieldsBySlug       : null,         // { slug -> field-object }
  fieldsByDisplayName: null,         // { lower(displayName) -> field-object }
  eventTypeOptions   : null,         // array van { id?, name, slug? }
  lastFetched        : 0,
};

// Template-cache voor clone-from-niveau-template strategie in createLiveItem.
// byNiveau = { basis?: <item>, gevorderd?: <item> } - elke key alleen aanwezig
// als er een Webflow CMS-item met dat niveau is gevonden.
let _templateCache = {
  byNiveau    : null,
  lastFetched : 0,
};

// Cache voor Tijdstip-slug (display "Tijdstip" - runtime gediscovered).
// null = nog niet gepoogd; '' = gepoogd maar veld niet gevonden; '<slug>' = found.
let _tijdstipSlugCache = {
  slug        : null,
  lastFetched : 0,
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
  if (status === 409) return 'CONFLICT';
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
  time       : 'time',
  location   : 'locatie-2',
  content    : 'event-content',
  // Blok 2 PR 3: Gastenlijst-veld voor "<bevestigd>/<capaciteit>" label.
  // Best guess slug uit Webflow-conventie (lowercase NL). Bij mismatch
  // valt resolveSlug() terug op displayName-match 'Gastenlijst' uit
  // FIELD_NAME_MAP hieronder, of skipt het veld + console.warn.
  gastenlijst: 'gastenlijst',
};

// Map van logische naam -> kandidaat-displayName voor FALLBACK matching.
// (Hardcoded slug hierboven wint; deze map is alleen voor reserve-discovery.)
const FIELD_NAME_MAP = {
  title      : 'Name',           // Webflow stelt 'Name' altijd verplicht (slug 'name')
  time       : 'Time',
  location   : 'Locatie',
  content    : 'Event Content',
  niveau     : 'Event Type',
  gastenlijst: 'Gastenlijst',
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
// publishSite - RAW HTTP-call naar Webflow publish-API. Idempotent op site-
// niveau: een tweede publish kort na de eerste levert weer een build op
// (Webflow queueet of dedupeert intern; voor onze hook zorgt webflow-publish.js
// dat dit niet binnen DEBOUNCE_MS gebeurt). 429 wordt door webflowFetch
// geclassificeerd als 'RATE_LIMIT' wat de orchestrator als retry-baar
// behandelt.
//
// Optioneel: WEBFLOW_CUSTOM_DOMAIN_IDS (comma-separated) om naar custom-domain
// te publiceren naast Webflow-subdomain. WEBFLOW_SITE_ID is verplicht.
//
// Errors worden NIET hier afgevangen - we gooien WebflowError zodat de
// caller (maybePublishSite) ze kan classifyeren (rate-limit vs harde fout).
export async function publishSite({ context = '' } = {}) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    throw new WebflowError(
      'VALIDATION_FAIL',
      `publishSite: WEBFLOW_SITE_ID ontbreekt in env (${context})`
    );
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
    `[webflow-client] publishSite (${context}): site=${siteId}, ` +
    `customDomains=${customDomains.length}, subdomain=true`
  );

  try {
    const data = await webflowFetch(`/sites/${siteId}/publish`, {
      method: 'POST',
      body,
    });
    console.log(
      `[webflow-client] publishSite OK (${context}): ${JSON.stringify(data || {}).slice(0, 200)}`
    );
    return { ok: true, body, raw: data };
  } catch (e) {
    // Re-throw met typed code. webflowFetch heeft 'm al geclassificeerd
    // (AUTH_FAIL / RATE_LIMIT / WEBFLOW_DOWN / NOT_FOUND / etc).
    console.warn(`[webflow-client] publishSite FAILED (${context}): ${e?.message || e}`);
    throw e;
  }
}

// Thin wrapper voor backward-compat met bestaande callers (createLiveItem,
// updateItem, unpublishItem, republishItem). Delegeert nu naar
// maybePublishSite uit api/_lib/webflow-publish.js zodat de DB-toggle +
// debounce + pending-flag voor ALLE outbound mutaties consistent zijn.
async function publishSiteIfEnabled(context = '') {
  // Lazy import om circulair import-probleem te voorkomen (webflow-publish
  // importeert publishSite uit deze file).
  const { maybePublishSite } = await import('./webflow-publish.js');
  return maybePublishSite(context);
}

// ── Niveau-template discovery (voor createLiveItem clone-strategie) ──────────
//
// Doel: nieuwe Webflow items er net zo compleet uit laten zien als de
// handmatige (Featured Image / Author / Entreeprijs / Event Type / Speakers /
// Short text / Tekst 3). Aanpak: voor elk niveau (basis/gevorderd) zoeken we
// een bestaand CMS-item dat we als template hergebruiken. createLiveItem
// kloont fieldData uit dat template en overschrijft DAARNA alleen de
// event-specifieke velden (name/slug/time/locatie-2/event-content/Tijdstip).
//
// Niveau-match logica:
//   - Voor elk item: lees Event Type-veldwaarde (option-id of -name)
//   - Map naar option-name via schema.eventTypeOptions
//   - WEBFLOW_TYPE_TO_NIVEAU ('Forex Kickstart Live' -> 'basis',
//                              'Trading Deep Dive'    -> 'gevorderd')
//   - Eerste match per niveau wint (geen sortering ge-impliceerd)
//
// Env-var overrides: WEBFLOW_TEMPLATE_ITEM_ID_BASIS / _GEVORDERD - als gezet,
// gebruiken we dat exacte item-ID als template, anders fallback op auto-match.
//
// Cache: 10 min TTL. Defensief: bij fetch-failure (geen 5xx-retry-loop hier)
// returnen we {} - createLiveItem detecteert dat en valt terug op core-only.
async function discoverNiveauTemplates({ force = false } = {}) {
  const now = Date.now();
  if (!force && _templateCache.byNiveau && (now - _templateCache.lastFetched) < TEMPLATE_CACHE_TTL_MS) {
    return _templateCache.byNiveau;
  }

  try {
    const { collId } = getEnv();
    const schema = await getCollectionSchema();

    // Detecteer Event Type slug uit schema (default 'category' uit recon)
    const eventTypeField = schema.fieldsByDisplayName?.['event type']
      || schema.fieldsBySlug?.category;
    const eventTypeSlug = eventTypeField?.slug || 'category';

    // GET items (staged - bevat alle items inclusief handmatig gemaakte)
    const data = await webflowFetch(`/collections/${collId}/items?limit=100`, {
      method: 'GET',
    });
    const items = Array.isArray(data?.items) ? data.items : [];

    const byNiveau = {};
    for (const item of items) {
      const typeVal = item?.fieldData?.[eventTypeSlug];
      if (!typeVal) continue;
      // typeVal kan option-id zijn; map via schema.eventTypeOptions naar name
      const opt = (schema.eventTypeOptions || []).find((o) =>
        o?.id === typeVal || o?.slug === typeVal || o?.name === typeVal
      );
      const displayName = String(opt?.name || typeVal).toLowerCase().trim();
      const niveau = WEBFLOW_TYPE_TO_NIVEAU[displayName];
      if (niveau && !byNiveau[niveau]) {
        byNiveau[niveau] = item;
      }
    }

    // Env-var overrides hebben voorrang (admin pin een specifieke template)
    const ovBasis     = process.env.WEBFLOW_TEMPLATE_ITEM_ID_BASIS;
    const ovGevorderd = process.env.WEBFLOW_TEMPLATE_ITEM_ID_GEVORDERD;
    if (ovBasis) {
      const it = items.find((i) => i?.id === ovBasis);
      if (it) byNiveau.basis = it;
      else console.warn(`[webflow-client] WEBFLOW_TEMPLATE_ITEM_ID_BASIS=${ovBasis} niet gevonden in items`);
    }
    if (ovGevorderd) {
      const it = items.find((i) => i?.id === ovGevorderd);
      if (it) byNiveau.gevorderd = it;
      else console.warn(`[webflow-client] WEBFLOW_TEMPLATE_ITEM_ID_GEVORDERD=${ovGevorderd} niet gevonden in items`);
    }

    _templateCache = { byNiveau, lastFetched: now };
    return byNiveau;
  } catch (e) {
    console.warn('[webflow-client] template-discovery failed:', e?.message || e);
    return {};
  }
}

// Runtime-resolve van de "Tijdstip" TEXT-veld slug via collection-schema.
// Cache mirror van schema-cache TTL. Return null als veld niet gevonden;
// caller skipt dan dat veld en logt.
async function resolveTijdstipSlug() {
  const now = Date.now();
  if (_tijdstipSlugCache.slug !== null && (now - _tijdstipSlugCache.lastFetched) < SCHEMA_CACHE_TTL_MS) {
    return _tijdstipSlugCache.slug || null;
  }
  try {
    const schema = await getCollectionSchema();
    const fld = schema.fieldsByDisplayName?.['tijdstip'];
    const slug = fld?.slug || '';
    if (slug) {
      console.log(`[webflow-client] Tijdstip-veld slug discovered: '${slug}'`);
    } else {
      console.warn('[webflow-client] Tijdstip-veld niet gevonden in collection-schema; skip');
    }
    _tijdstipSlugCache = { slug, lastFetched: now };
    return slug || null;
  } catch (e) {
    console.warn('[webflow-client] resolveTijdstipSlug error:', e?.message || e);
    return null;
  }
}

// Format Tijdstip TEXT-waarde uit starts_at/ends_at in nl-NL (Europe/Amsterdam).
//   met ends_at: 'HH:MM - HH:MM'
//   alleen starts_at: 'HH:MM'
//   geen starts_at: null
function formatTijdstipNl(startsAt, endsAt) {
  if (!startsAt) return null;
  try {
    const start = new Date(startsAt);
    const timeFmt = new Intl.DateTimeFormat('nl-NL', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Europe/Amsterdam',
    });
    const s = timeFmt.format(start);
    if (!endsAt) return s;
    const e = timeFmt.format(new Date(endsAt));
    return `${s} - ${e}`;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createLiveItem({ event, descriptionHtml }) {
  if (!event?.id || !event?.title || !event?.starts_at) {
    throw new WebflowError('VALIDATION_FAIL', 'event.id/title/starts_at vereist');
  }
  const { collId } = getEnv();
  const schema = await getCollectionSchema();

  // Stap 1: discover niveau-templates (basis / gevorderd)
  const templates = await discoverNiveauTemplates();
  const requestedNiveau = String(event?.niveau || '').toLowerCase().trim();
  let template = null;
  let templateInfo = { used: false, item_id: null, niveau: null, fallback: null };

  if (requestedNiveau && templates[requestedNiveau]) {
    template = templates[requestedNiveau];
    templateInfo = { used: true, item_id: template.id || null, niveau: requestedNiveau, fallback: null };
  } else if (templates.basis || templates.gevorderd) {
    // Fallback op andere niveau-template (basis voorkeur boven gevorderd voor MVP)
    template = templates.basis || templates.gevorderd;
    const fallbackNiveau = templates.basis ? 'basis' : 'gevorderd';
    templateInfo = {
      used: true, item_id: template.id || null, niveau: fallbackNiveau,
      fallback: requestedNiveau || '(empty)',
    };
  } else {
    templateInfo = { used: false, item_id: null, niveau: null, fallback: 'core_only' };
  }

  // Stap 2: clone fieldData uit template, strip conflicterende id-achtige velden.
  // event-specifieke velden worden in stap 3 overschreven.
  const fieldData = template?.fieldData ? { ...template.fieldData } : {};
  // Veiligheidsstrip: voorkom dat de template's id-achtige velden in onze POST komen.
  delete fieldData._id;
  delete fieldData.id;
  delete fieldData['cms-locale-id'];

  // Stap 3: bouw override-set + apply. buildFieldData zet name/slug/time/locatie-2/event-content.
  const overrides = buildFieldData({ event, descriptionHtml, schema });

  // Tijdstip TEXT veld: runtime slug + formatted "HH:MM - HH:MM"
  const tijdstipSlug  = await resolveTijdstipSlug();
  const tijdstipValue = formatTijdstipNl(event?.starts_at, event?.ends_at);
  if (tijdstipSlug && tijdstipValue) {
    overrides[tijdstipSlug] = tijdstipValue;
  }

  // Merge: overrides over template-base. Niet-overschreven velden (Featured
  // Image / Author / Entreeprijs / Event Type / Speakers / Short text / Tekst 3)
  // erven dus de template-waarde, precies de bedoeling van clone-from-niveau.
  for (const [k, v] of Object.entries(overrides)) {
    fieldData[k] = v;
  }

  console.log(
    `[webflow-client] CREATE clone-from-niveau: ` +
    `template=${templateInfo.item_id || 'none'} ` +
    `(niveau=${templateInfo.niveau || 'n/a'}` +
    (templateInfo.fallback ? `, fallback for '${templateInfo.fallback}'` : '') +
    `) tijdstipSlug='${tijdstipSlug || 'n/a'}' tijdstipValue='${tijdstipValue || 'n/a'}' ` +
    `overrides=[${Object.keys(overrides).join(',')}]`
  );

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
  return { itemId, raw: data, requestPayload: body, sitePublish, template: templateInfo };
}

export async function updateItem({ webflowItemId, event, descriptionHtml }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  if (!event?.id)     throw new WebflowError('VALIDATION_FAIL', 'event.id vereist');
  const { collId } = getEnv();
  const schema = await getCollectionSchema();
  const fieldData = buildFieldData({ event, descriptionHtml, schema });

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
  //
  // 404-as-success: bij een herhaalde unpublish (item al unpublished) returnt
  // Webflow 404 NOT_FOUND. Voor reopen-flow en delete-flow is dat semantisch
  // success: de gewenste eindstand (item niet meer live) is al bereikt.
  try {
    const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}/live`, {
      method: 'DELETE',
    });
    const sitePublish = await publishSiteIfEnabled('unpublish-' + webflowItemId);
    return { itemId: webflowItemId, raw: data, requestPayload: null, sitePublish };
  } catch (e) {
    if (e instanceof WebflowError && e.code === 'NOT_FOUND') {
      console.log(`[webflow-client] unpublishItem 404 idempotent (${webflowItemId})`);
      return {
        itemId         : webflowItemId,
        raw            : null,
        requestPayload : null,
        sitePublish    : { skipped: true, reason: 'unpublish 404 already gone' },
        unpublished    : false,
        reason         : '404 already gone',
      };
    }
    throw e;
  }
}

/**
 * Hard-delete een Webflow CMS-item PERMANENT (= weg uit CMS, niet alleen
 * unpublish). Voor archive-pad en cleanup-cron (>7d na event).
 *
 * Path: DELETE /collections/{coll}/items/{itemId} (GEEN /live suffix).
 * 404 = treat as success (item al weg, idempotent).
 *
 * @returns { itemId, raw, requestPayload: null, deleted: true }
 *          | { itemId, raw, requestPayload: null, deleted: false, reason: '404 already gone' }
 */
export async function hardDeleteItem({ webflowItemId }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  const { collId } = getEnv();
  try {
    const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}`, {
      method: 'DELETE',
    });
    // Blok 2 PR 4: trigger site-publish hook zodat overzichts-CMS-pagina
    // het verwijderde item niet meer toont. Lock+debounce zit in
    // maybePublishSite; deze call is fire-and-forward + return-prop.
    const sitePublish = await publishSiteIfEnabled('hard-delete-' + webflowItemId);
    return { itemId: webflowItemId, raw: data, requestPayload: null, deleted: true, sitePublish };
  } catch (e) {
    if (e instanceof WebflowError && e.code === 'NOT_FOUND') {
      console.log(`[webflow-client] hardDeleteItem 404 idempotent (${webflowItemId})`);
      // 404 = al weg; alsnog publish-hook zodat eventueel pending mutaties
      // in dezelfde burst toch een trailing publish krijgen.
      const sitePublish = await publishSiteIfEnabled('hard-delete-404-' + webflowItemId);
      return { itemId: webflowItemId, raw: null, requestPayload: null, deleted: false, reason: '404 already gone', sitePublish };
    }
    throw e;
  }
}

/**
 * Republish een Webflow-item dat in draft staat (gevolg van unpublishItem).
 * Voor reopen-signups flow.
 *
 * SMOKE-LESSON (2026-06-12): PATCH /items/{id}/live op een ge-unpublisht
 * item returnt Webflow 409 met "Live PATCH updates can't be applied to items
 * that have never been published" - de live record bestaat niet meer, alleen
 * de staged versie. Voor herpubliceren is dan een ECHTE publish nodig, niet
 * een PATCH live.
 *
 * Strategie:
 *   1. PATCH /collections/{coll}/items/{itemId} met fieldData (update staged
 *      record met laatste data zodat de PUBLISH-stap straks de juiste content
 *      bevat). Skippen we voor MVP omdat event-data doorgaans niet wijzigt
 *      tussen close en reopen; alleen status verandert.
 *   2. POST /collections/{coll}/items/publish met body { itemIds: [id] }
 *      (Webflow v2 bulk publish - werkt op staged items, ook bij never-published).
 *
 * Optioneel: bij ANY niet-success status -> log + gooi. Bij success: site-
 * publish helper voor lijst-pagina refresh.
 *
 * @returns { itemId, raw, requestPayload, strategy: 'post_publish_bulk' }
 */
export async function republishItem({ webflowItemId, event, descriptionHtml }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  if (!event?.id)     throw new WebflowError('VALIDATION_FAIL', 'event.id vereist');
  const { collId } = getEnv();
  const schema = await getCollectionSchema();
  const fieldData = buildFieldData({ event, descriptionHtml, schema });

  // Stap 1 (best-effort): update staged record met laatste fieldData. Werkt
  // ongeacht of het item live is of niet. Faal != fataal - publish-stap
  // hieronder volgt sowieso.
  const stagedBody = { isArchived: false, isDraft: false, fieldData };
  let stagedResult = null;
  try {
    stagedResult = await webflowFetch(`/collections/${collId}/items/${webflowItemId}`, {
      method: 'PATCH',
      body: stagedBody,
    });
  } catch (e) {
    if (e instanceof WebflowError && e.code === 'NOT_FOUND') {
      console.warn(`[webflow-client] republishItem PATCH staged 404 - item misschien hard-deleted (${webflowItemId})`);
      throw e; // niets te republishen
    }
    // Andere errors loggen maar doorgaan naar publish-stap (vaak werkt die nog)
    console.warn(`[webflow-client] republishItem PATCH staged faalde (${e?.code || 'unknown'}: ${e?.message?.slice(0, 120) || ''}); doorgaan met bulk-publish`);
  }

  // Stap 2: bulk publish endpoint - documented Webflow v2 path voor
  // PUBLISH staged items naar live site. Werkt ook bij never-published items.
  const publishBody = { itemIds: [webflowItemId] };
  const publishData = await webflowFetch(`/collections/${collId}/items/publish`, {
    method: 'POST',
    body: publishBody,
  });

  const sitePublish = await publishSiteIfEnabled('republish-' + webflowItemId);
  return {
    itemId       : webflowItemId,
    raw          : publishData,
    requestPayload: publishBody,
    stagedUpdate : stagedResult ? { ok: true } : { ok: false, skipped: true },
    sitePublish,
    strategy     : 'post_publish_bulk',
  };
}

/**
 * updateLiveFields - PATCH /items/{id}/live met een SUBSET van fields zodat
 * we de Gastenlijst-teller kunnen bijwerken zonder de volledige event-payload
 * te hoeven herbouwen (geen schema-discovery of buildFieldData nodig per
 * registratie).
 *
 * @param {object} arg
 * @param {string} arg.webflowItemId  - id van het live CMS-item
 * @param {object} arg.fieldData      - { logicalName: value, ... } waar
 *                                       logicalName via resolveSlug() vertaald
 *                                       wordt naar de echte Webflow-slug.
 *                                       Onbekende logicalNames worden GESKIPT
 *                                       met console.warn (geen exception).
 *
 * Idempotent: PATCH op /live van een live item; faal-modes:
 *   - 404 (item nooit gepubliceerd / verwijderd) -> WebflowError NOT_FOUND
 *   - 409 / 422 -> WebflowError met code
 *   - alle velden onbekend -> { skipped: true, reason: 'no resolvable fields' }
 *
 * Gevolgd door publishSiteIfEnabled() (Blok 2 PR 4): de DB-toggle + debounce
 * in maybePublishSite zorgt dat een burst van teller-updates samenvalt tot
 * ~1 site-publish, zodat de overzichtspagina de nieuwste "X / Y" toont
 * zonder dat we per registratie een hele site-build triggeren.
 *
 * @returns { itemId, raw, requestPayload, resolvedFields, skipped?, sitePublish? }
 */
export async function updateLiveFields({ webflowItemId, fieldData }) {
  if (!webflowItemId) throw new WebflowError('VALIDATION_FAIL', 'webflowItemId vereist');
  if (!fieldData || typeof fieldData !== 'object') {
    throw new WebflowError('VALIDATION_FAIL', 'fieldData object vereist');
  }
  const { collId } = getEnv();
  const schema = await getCollectionSchema();

  // Vertaal logicalName -> slug. Skip onresolvable.
  const resolved = {};
  for (const [logicalName, value] of Object.entries(fieldData)) {
    const slug = resolveSlug(schema, logicalName);
    if (slug) {
      resolved[slug] = value;
    } else {
      console.warn(`[webflow-client] updateLiveFields skipt '${logicalName}' (geen slug gevonden)`);
    }
  }

  if (Object.keys(resolved).length === 0) {
    return {
      itemId        : webflowItemId,
      raw           : null,
      requestPayload: null,
      resolvedFields: [],
      skipped       : true,
      reason        : 'no resolvable fields',
    };
  }

  const body = {
    isArchived: false,
    isDraft   : false,
    fieldData : resolved,
  };

  const data = await webflowFetch(`/collections/${collId}/items/${webflowItemId}/live`, {
    method: 'PATCH',
    body,
  });

  const sitePublish = await publishSiteIfEnabled('update-fields-' + webflowItemId);

  return {
    itemId        : webflowItemId,
    raw           : data,
    requestPayload: body,
    resolvedFields: Object.keys(resolved),
    sitePublish,
  };
}
