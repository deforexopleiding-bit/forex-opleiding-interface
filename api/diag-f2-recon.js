// =============================================================================
// TEMPORARY DIAG ENDPOINT — F2.0 recon-spike
// =============================================================================
//
// Doel: bevestig op de Vercel-preview (waar de F2-creds staan) de openstaande
// onzekerheden uit de GHL/Webflow recon. Wordt na de findings VERWIJDERD —
// dit bestand mag NIET in main belanden zonder vervolg-cleanup-PR.
//
// Auth: super_admin Bearer-JWT (verifyAdmin + extra role-check).
//       Read-only voor Webflow + GHL-list; idempotent write-probe voor GHL.
//       Geen secrets in response (tokens worden alleen als set/unset gerapporteerd).
//
// Aanroep (vanuit ingelogde browser-DevTools console op de preview-URL):
//   const tok = (await window.AuthShared.getAccessToken());
//   const r = await fetch('/api/_diag-f2-recon', { headers:{Authorization:'Bearer '+tok} });
//   console.log(JSON.stringify(await r.json(), null, 2));
//
// Optioneel: ?skip_write=true → slaat de PUT-probe over (alleen reads).
// =============================================================================

import fetch from 'node-fetch';
import { verifyAdmin } from './supabase.js';

const WEBFLOW_BASE   = 'https://api.webflow.com/v2';
const GHL_BASE       = 'https://services.leadconnectorhq.com';
const GHL_VERSION    = 'v3';
const GHL_LOCATION   = 'YdIAWnq0DutM7VNOGReg';
const TARGET_FIELD_KEY = 'single_dropdown_12e8o';

// Mask: geef nooit token-waardes terug. Alleen lengte als ruwe sanity-check.
function tokenSet(name) {
  const v = process.env[name];
  return { set: !!v && v.length > 8, length: v ? v.length : 0 };
}

// Defensieve fetch-wrapper: returnt status + parsed body + error-message zonder
// ooit de Authorization-header te echoen.
async function safeFetch(label, url, opts) {
  const out = { label, url: url.replace(GHL_LOCATION, '<LOC>'), status: 0, ok: false };
  try {
    const r = await fetch(url, opts);
    out.status = r.status;
    out.ok = r.ok;
    const txt = await r.text();
    try { out.body = JSON.parse(txt); }
    catch { out.body_raw_excerpt = txt.slice(0, 300); }
    return out;
  } catch (e) {
    out.error = e?.message || 'fetch failed';
    return out;
  }
}

// ─── WEBFLOW ──────────────────────────────────────────────────────────────────

async function webflowSchemaCheck() {
  const collId = process.env.WEBFLOW_EVENTS_COLLECTION_ID;
  const token  = process.env.WEBFLOW_API_TOKEN;
  if (!collId || !token) {
    return { skipped: true, reason: 'WEBFLOW_EVENTS_COLLECTION_ID or WEBFLOW_API_TOKEN missing' };
  }

  // v2 docs noemen Accept-Version optional voor /v2/* paths. Probeer eerst zonder.
  const headers = {
    Authorization: `Bearer ${token}`,
    'Accept': 'application/json',
  };

  const r = await safeFetch(
    'webflow_get_collection',
    `${WEBFLOW_BASE}/collections/${collId}`,
    { method: 'GET', headers }
  );

  // Strip body details we don't need (keep names/slugs/types alleen)
  let fields_summary = null;
  let event_type_field = { found: false };
  if (r.ok && r.body) {
    const fields = Array.isArray(r.body.fields) ? r.body.fields : [];
    fields_summary = fields.map(f => ({
      slug:        f.slug || null,
      displayName: f.displayName || f.name || null,
      type:        f.type || null,
      isRequired:  !!f.isRequired,
      validations_keys: f.validations ? Object.keys(f.validations) : [],
    }));
    // "Event Type" detectie: displayName match OR type=Option
    const evt = fields.find(f =>
      (f.displayName || '').toLowerCase().includes('event type')
      || ((f.displayName || '').toLowerCase() === 'niveau')
      || (f.type === 'Option' && (f.displayName || '').toLowerCase().includes('niveau'))
    );
    if (evt) {
      const opts = (evt.validations && Array.isArray(evt.validations.options))
        ? evt.validations.options
        : [];
      event_type_field = {
        found: true,
        slug: evt.slug,
        displayName: evt.displayName,
        type: evt.type,
        options: opts.map(o => ({ id: o.id || null, name: o.name || null })),
      };
    } else {
      event_type_field = {
        found: false,
        note: 'Geen veld gevonden met displayName matching "event type" of "niveau". Scan fields_summary handmatig.',
        all_option_fields: fields.filter(f => f.type === 'Option').map(f => ({
          slug: f.slug, displayName: f.displayName,
        })),
      };
    }
  }

  return {
    call: { status: r.status, ok: r.ok, error: r.error || null },
    collection_id_used: collId.slice(0, 6) + '...' + collId.slice(-4),
    collection_name: r.body?.displayName || r.body?.name || null,
    field_count: Array.isArray(r.body?.fields) ? r.body.fields.length : null,
    fields_summary,
    event_type_field,
  };
}

// ─── GHL ──────────────────────────────────────────────────────────────────────

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_EVENTS_PIT_TOKEN}`,
    Version:       GHL_VERSION,
    Accept:        'application/json',
    'Content-Type':'application/json',
  };
}

async function ghlListCheck() {
  const token = process.env.GHL_EVENTS_PIT_TOKEN;
  if (!token) {
    return { skipped: true, reason: 'GHL_EVENTS_PIT_TOKEN missing' };
  }

  const r = await safeFetch(
    'ghl_list_custom_fields',
    `${GHL_BASE}/locations/${GHL_LOCATION}/customFields`,
    { method: 'GET', headers: ghlHeaders() }
  );

  let target = { found: false };
  if (r.ok && r.body) {
    // Response shape onbekend - probeer alle bekende keys
    const arr =
      (Array.isArray(r.body.customFields) && r.body.customFields) ||
      (Array.isArray(r.body.data) && r.body.data) ||
      (Array.isArray(r.body.fields) && r.body.fields) ||
      (Array.isArray(r.body) && r.body) ||
      [];
    const fld = arr.find(f =>
      f && (f.fieldKey === TARGET_FIELD_KEY
        || f.field_key === TARGET_FIELD_KEY
        || f.key === TARGET_FIELD_KEY
        || (typeof f.fieldKey === 'string' && f.fieldKey.endsWith(TARGET_FIELD_KEY)))
    );
    if (fld) {
      // Detecteer welk veld de opties bevat
      const candidates = ['picklistOptions','options','choices','picklistImageOptions','textBoxList'];
      const optionsKey = candidates.find(k => Array.isArray(fld[k]) && fld[k].length > 0)
        || candidates.find(k => Array.isArray(fld[k]));
      const opts = optionsKey ? fld[optionsKey] : null;
      target = {
        found: true,
        id: fld.id || fld._id || null,
        fieldKey: fld.fieldKey || fld.field_key || fld.key || null,
        name: fld.name || fld.displayName || null,
        dataType: fld.dataType || fld.type || null,
        all_top_level_keys: Object.keys(fld).sort(),
        options_field_name_detected: optionsKey || null,
        options_count: Array.isArray(opts) ? opts.length : null,
        options_sample_first3: Array.isArray(opts) ? opts.slice(0, 3) : null,
        options_item_shape_keys: (Array.isArray(opts) && opts[0] && typeof opts[0] === 'object')
          ? Object.keys(opts[0]).sort() : (Array.isArray(opts) ? 'primitive_array' : null),
      };
    } else {
      target = {
        found: false,
        scanned_count: arr.length,
        sample_first_keys: arr.slice(0, 1).map(f => f ? Object.keys(f).sort() : null),
        looked_for: TARGET_FIELD_KEY,
      };
    }
  }

  return {
    call: { status: r.status, ok: r.ok, error: r.error || null },
    location_id: GHL_LOCATION,
    target_field: target,
    response_top_level_shape: r.body && typeof r.body === 'object' && !Array.isArray(r.body)
      ? Object.keys(r.body).sort() : (Array.isArray(r.body) ? 'array_root' : null),
  };
}

async function ghlIdempotentWriteProbe(target) {
  if (!process.env.GHL_EVENTS_PIT_TOKEN) {
    return { skipped: true, reason: 'GHL_EVENTS_PIT_TOKEN missing' };
  }
  if (!target?.found) {
    return { skipped: true, reason: 'target_field not found in list call - cannot probe write' };
  }
  if (!target.options_field_name_detected) {
    return {
      skipped: true,
      reason: 'options field name not detected - body-shape would be wrong; manual inspection needed',
    };
  }

  // Re-fetch the FULL field om alle kenbare velden mee te sturen (sommige PUTs
  // vereisen full object). We hergebruiken alleen de schoongepoetste velden.
  const getResp = await safeFetch(
    'ghl_get_single_field',
    `${GHL_BASE}/locations/${GHL_LOCATION}/customFields/${encodeURIComponent(target.id)}`,
    { method: 'GET', headers: ghlHeaders() }
  );

  let putBodyShape = null;
  let putResp = null;
  if (getResp.ok && getResp.body) {
    // Body kan { customField: {...} } zijn of het object zelf
    const fld = getResp.body.customField || getResp.body;
    const optionsKey = target.options_field_name_detected;
    const options = Array.isArray(fld[optionsKey]) ? fld[optionsKey] : [];

    // Minimaal PUT-body: alleen velden die plausibel writeable zijn
    const minimalBody = {
      name: fld.name,
      dataType: fld.dataType || fld.type,
    };
    minimalBody[optionsKey] = options; // EXACT zelfde opties terug
    putBodyShape = {
      keys: Object.keys(minimalBody).sort(),
      options_count: options.length,
    };

    putResp = await safeFetch(
      'ghl_put_idempotent',
      `${GHL_BASE}/locations/${GHL_LOCATION}/customFields/${encodeURIComponent(target.id)}`,
      { method: 'PUT', headers: ghlHeaders(), body: JSON.stringify(minimalBody) }
    );
  }

  return {
    get_for_full_shape: getResp ? { status: getResp.status, ok: getResp.ok } : null,
    put_body_shape: putBodyShape,
    put_call: putResp ? {
      status: putResp.status,
      ok: putResp.ok,
      message: putResp.body?.message
        || putResp.body?.error
        || (putResp.body && putResp.body.statusCode ? `code ${putResp.body.statusCode}` : null),
      validation_keys: putResp.body && Array.isArray(putResp.body.errors)
        ? putResp.body.errors.map(e => e?.path || e?.field || e?.message?.slice(0, 60)).slice(0, 5)
        : null,
      error_payload_excerpt: putResp.body_raw_excerpt
        || (putResp.body && JSON.stringify(putResp.body).slice(0, 300))
        || null,
    } : null,
    interpretation: putResp ? interpretWriteStatus(putResp.status) : 'no PUT attempted',
  };
}

function interpretWriteStatus(status) {
  if (status === 200 || status === 201 || status === 204) {
    return 'WRITE-SCOPE OK - idempotente update geslaagd';
  }
  if (status === 401) return 'AUTH FAIL - PIT token afgewezen';
  if (status === 403) return 'SCOPE MIST - locations/customFields.write niet geactiveerd op deze PIT';
  if (status === 400 || status === 422) return 'BODY-SHAPE MISMATCH - PIT scope mogelijk OK maar body-veldnaam of structuur klopt niet';
  if (status === 404) return 'FIELD NOT FOUND - ID mismatch met list-call';
  if (status === 429) return 'RATE LIMITED - probeer later opnieuw';
  return 'UNKNOWN - zie put_call.error_payload_excerpt';
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Strict super_admin gate
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'auth required' });
  if (admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'super_admin only' });
  }

  const skipWrite = String(req.query?.skip_write || '').toLowerCase() === 'true';

  try {
    // Webflow recon
    const webflow = await webflowSchemaCheck();

    // GHL recon: list eerst, dan write-probe op het gevonden field
    const ghlList = await ghlListCheck();
    const ghlWrite = skipWrite
      ? { skipped: true, reason: 'skip_write=true query param' }
      : await ghlIdempotentWriteProbe(ghlList?.target_field);

    return res.status(200).json({
      ok: true,
      run_at: new Date().toISOString(),
      env: {
        WEBFLOW_API_TOKEN:           tokenSet('WEBFLOW_API_TOKEN'),
        WEBFLOW_SITE_ID:             tokenSet('WEBFLOW_SITE_ID'),
        WEBFLOW_EVENTS_COLLECTION_ID:tokenSet('WEBFLOW_EVENTS_COLLECTION_ID'),
        GHL_EVENTS_PIT_TOKEN:        tokenSet('GHL_EVENTS_PIT_TOKEN'),
      },
      webflow,
      ghl: {
        list_call: ghlList,
        write_probe: ghlWrite,
      },
      meta: {
        endpoint: 'TEMPORARY - delete via cleanup-PR na F2.0 review',
        secrets_in_response: false,
        note: 'Tokens alleen als set/unset + length. Auth-headers nooit ge-echoed.',
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || 'recon-spike crashed',
      meta: { secrets_in_response: false },
    });
  }
}
