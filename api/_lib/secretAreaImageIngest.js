// api/_lib/secretAreaImageIngest.js
//
// Gedeelde image-ingest voor de Secret Area — één plek voor:
//   1. TradingView-URL resolve (SSRF-hardened, met regex-allowlist + og:image
//      extractie + host-allowlist + manual-redirect + timeout).
//   2. Base64 file-decode + MIME- en size-guards.
//   3. Storage-upload naar de private 'secret-area' bucket met een pad
//      dat scoped is op ownerId + kind + refId.
//
// SSRF-GUARDS — VERPLICHT INTACT LATEN:
//   Guard 1 (regex-allowlist): tvUrl moet matchen op
//     ^https://(www\.)?tradingview\.com/x/[A-Za-z0-9]+/?$
//     — geen enkele andere host wordt ooit gefetcht.
//   Guard 2 (manual redirect): fetch met redirect:'manual', dus als TV
//     zelf 3xx serveert, faalt de fetch expliciet (geen automatische
//     host-hop).
//   Guard 3 (host-allowlist): host van de og:image moet in
//     TV_HOSTS staan { s3.tradingview.com, www.tradingview.com, tradingview.com }.
//   Guard 4 (timeout): AbortController timeout op alle outbound fetches.
//   Guard 5 (MIME-allowlist): downloaded content-type moet in ALLOWED_MIME.
//   Guard 6 (size-cap): MAX_BYTES bewaakt.
//
// Callers: secret-area-upload.js (POST) en secret-area-analyze.js
// (chart-analyse). Beide gebruiken exact hetzelfde ingest-pad; guard-drift
// tussen callers is daarmee onmogelijk.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';

export const BUCKET       = 'secret-area';
export const MAX_BYTES    = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
export const EXT_BY_MIME  = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Guard 1 — regex-allowlist. LAAT DEZE STAAN.
export const TV_URL_RE = /^https:\/\/(www\.)?tradingview\.com\/x\/[A-Za-z0-9]+\/?$/;
// Guard 3 — host-allowlist voor og:image download.
export const TV_HOSTS  = new Set(['s3.tradingview.com', 'www.tradingview.com', 'tradingview.com']);

export const KIND_SUBFOLDER = { tool: 'tools', trade: 'trades', analysis: 'analyses' };
export const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS      = 8000;

function sanitizeFilename(name) {
  return (String(name || 'img')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)) || 'img';
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve TradingView snapshot URL → og:image URL, gebonden aan allowlist.
 * Retourneert { imgUrl } bij succes of { error } bij validatie/fetch-fout.
 */
export async function resolveTradingViewImageUrl(tvUrl) {
  // Guard 1 — exacte regex-allowlist op de user-input URL.
  if (typeof tvUrl !== 'string' || !TV_URL_RE.test(tvUrl)) {
    return { error: 'tradingview_url matcht niet met /x/-snapshot-patroon' };
  }
  // Guard 2 + 4 — manual redirect + timeout.
  let html = '';
  try {
    const r = await fetchWithTimeout(tvUrl, {
      method:   'GET',
      redirect: 'manual',
      headers:  { 'User-Agent': 'Mozilla/5.0 (secret-area-resolver)' },
    });
    if (!r.ok) return { error: 'TradingView pagina-fetch HTTP ' + r.status };
    html = await r.text();
  } catch (e) {
    return { error: 'TradingView pagina onbereikbaar: ' + (e?.message || 'fetch-fail') };
  }
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const imgUrl = m ? m[1] : null;
  if (!imgUrl) return { error: 'og:image niet gevonden op TradingView-pagina' };
  // Guard 3 — host-allowlist op de og:image URL.
  let host = '';
  try { host = new URL(imgUrl).host.toLowerCase(); }
  catch { return { error: 'og:image URL ongeldig' }; }
  if (!TV_HOSTS.has(host)) {
    return { error: 'og:image host niet in allowlist: ' + host };
  }
  return { imgUrl };
}

/**
 * Download een URL waarvan we vooraf de host hebben gevalideerd (allowlist).
 * Volgt GEEN redirects — als de host redirect, faalt de download expliciet.
 */
export async function downloadImage(imgUrl) {
  try {
    const r = await fetchWithTimeout(imgUrl, {
      method:   'GET',
      redirect: 'manual',
      headers:  { 'User-Agent': 'Mozilla/5.0 (secret-area-resolver)' },
    });
    if (!r.ok) return { error: 'image download HTTP ' + r.status };
    const ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(ct)) return { error: 'content-type niet toegestaan: ' + ct };
    const arr = new Uint8Array(await r.arrayBuffer());
    if (arr.byteLength === 0)          return { error: 'lege response' };
    if (arr.byteLength > MAX_BYTES)    return { error: 'bestand te groot' };
    return { buf: Buffer.from(arr), contentType: ct };
  } catch (e) {
    return { error: 'image download exception: ' + (e?.message || 'fetch-fail') };
  }
}

/**
 * Bouw een storage-pad {ownerId}/{sub}/{refId}/{uuid}-{safe}.{ext}
 * kind: 'tool' | 'trade' | 'analysis'
 */
export function buildStoragePath(ownerId, kind, refId, contentType, filenameHint) {
  const ext  = EXT_BY_MIME[contentType] || 'jpg';
  const safe = sanitizeFilename(filenameHint).replace(/\.[^.]+$/, '') || 'img';
  const uid  = crypto.randomUUID();
  const sub  = KIND_SUBFOLDER[kind] || 'misc';
  return `${ownerId}/${sub}/${refId}/${uid}-${safe}.${ext}`;
}

/**
 * Ingest een base64-encoded afbeelding.
 * @returns {Promise<{ ok:boolean, image_path?:string, size_bytes?:number, error?:string, status?:number }>}
 */
export async function ingestBase64({ ownerId, kind, refId, contentType, dataBase64, filenameHint }) {
  const ct = String(contentType || '').trim().toLowerCase();
  if (!ct || !ALLOWED_MIME.has(ct)) {
    return { ok: false, error: 'content_type moet JPEG/PNG/WEBP zijn', status: 400 };
  }
  let buf;
  try { buf = Buffer.from(dataBase64 || '', 'base64'); }
  catch { return { ok: false, error: 'data_base64 niet geldig base64', status: 400 }; }
  if (!buf || buf.length === 0) return { ok: false, error: 'data_base64 decode 0 bytes', status: 400 };
  if (buf.length > MAX_BYTES)   return { ok: false, error: 'bestand te groot', status: 400 };

  const path = buildStoragePath(ownerId, kind, refId, ct, filenameHint);
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buf, {
    contentType: ct, upsert: false,
  });
  if (upErr) {
    if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
      return { ok: false, error: `Storage bucket '${BUCKET}' niet gevonden`, status: 503 };
    }
    console.error('[sa-ingest] storage error:', upErr.message);
    return { ok: false, error: 'Upload mislukt: ' + upErr.message, status: 500 };
  }
  return { ok: true, image_path: path, size_bytes: buf.length };
}

/**
 * Ingest een TradingView-URL: resolve → download → upload.
 * Retourneert bij fout image_path=null + source_url zodat callers een fallback
 * naar de externe URL kunnen renderen.
 * @returns {Promise<{ ok:boolean, image_path?:string|null, source_url:string, warning?:string, size_bytes?:number }>}
 */
export async function ingestTradingViewUrl({ ownerId, kind, refId, tvUrl, filenameHint }) {
  const resolved = await resolveTradingViewImageUrl(tvUrl);
  if (resolved.error) {
    console.warn('[sa-ingest] TV resolve:', resolved.error);
    return { ok: true, image_path: null, source_url: tvUrl, warning: resolved.error };
  }
  const dl = await downloadImage(resolved.imgUrl);
  if (dl.error) {
    console.warn('[sa-ingest] TV download:', dl.error);
    return { ok: true, image_path: null, source_url: tvUrl, warning: dl.error };
  }
  const path = buildStoragePath(ownerId, kind, refId, dl.contentType, filenameHint);
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, dl.buf, {
    contentType: dl.contentType, upsert: false,
  });
  if (upErr) {
    if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
      console.error('[sa-ingest] bucket-missing:', upErr.message);
    } else {
      console.error('[sa-ingest] TV storage error:', upErr.message);
    }
    return { ok: true, image_path: null, source_url: tvUrl, warning: 'upload mislukt' };
  }
  return { ok: true, image_path: path, source_url: tvUrl, size_bytes: dl.buf.length };
}
