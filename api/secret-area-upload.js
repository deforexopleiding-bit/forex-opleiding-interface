// api/secret-area-upload.js
// POST → owner-gated image ingest. Twee modes:
//   (a) file: { filename, content_type, data_base64, kind:'tool'|'trade', ref_id }
//   (b) tradingview_url: { tradingview_url, kind:'tool'|'trade', ref_id }
// ref_id = tool_id of trade_id (voor pad-scoping). kind bepaalt subfolder.
// Response: { ok, image_path?, source_url?, size_bytes? }
//
// TRADINGVIEW SSRF-HARDENING:
//  1. URL moet MATCHEN op ^https://(www\.)?tradingview\.com/x/[A-Za-z0-9]+/?$ .
//     Anders 400 — geen enkele andere host wordt ooit gefetcht.
//  2. Fetch die pagina, lees <meta property="og:image"> → afbeeldings-URL.
//  3. Download ALLEEN als de HOST van die og:image in de allowlist
//     { s3.tradingview.com, www.tradingview.com, tradingview.com } zit,
//     anders 400.
//  4. Volg GEEN redirects naar andere hosts (redirect: 'manual').
//  5. Failure → geen crash: retour { image_path:null, source_url } zodat de
//     UI als fallback een embed/pin op de source-URL kan zetten.
// Zo blijft de resolver een gesloten oppervlak.
//
// Bucket = 'secret-area' (private, service-role upload; getekende URLs elders).

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const BUCKET = 'secret-area';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — trade-charts kunnen groot zijn
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const TV_URL_RE  = /^https:\/\/(www\.)?tradingview\.com\/x\/[A-Za-z0-9]+\/?$/;
const TV_HOSTS   = new Set(['s3.tradingview.com', 'www.tradingview.com', 'tradingview.com']);
const KIND       = new Set(['tool', 'trade']);
const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 8000;

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
async function resolveTradingViewImageUrl(tvUrl) {
  // Guard 1: exacte regex-allowlist op de user-input URL.
  if (typeof tvUrl !== 'string' || !TV_URL_RE.test(tvUrl)) {
    return { error: 'tradingview_url matcht niet met /x/-snapshot-patroon' };
  }
  // Guard 4: manual redirect — als TV zelf 3xx serveert, faalt de fetch.
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
  // og:image extractie — enkel het eerste voorkomen.
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const imgUrl = m ? m[1] : null;
  if (!imgUrl) return { error: 'og:image niet gevonden op TradingView-pagina' };
  // Guard 3: host-allowlist op de og:image URL.
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
async function downloadImage(imgUrl) {
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
    if (arr.byteLength === 0) return { error: 'lege response' };
    if (arr.byteLength > MAX_BYTES) return { error: 'bestand te groot' };
    return { buf: Buffer.from(arr), contentType: ct };
  } catch (e) {
    return { error: 'image download exception: ' + (e?.message || 'fetch-fail') };
  }
}

function buildPath(ownerId, kind, refId, contentType, filenameHint) {
  const ext  = EXT[contentType] || 'jpg';
  const safe = sanitizeFilename(filenameHint).replace(/\.[^.]+$/, '') || 'img';
  const uid  = crypto.randomUUID();
  const sub  = kind === 'trade' ? 'trades' : 'tools';
  return `${ownerId}/${sub}/${refId}/${uid}-${safe}.${ext}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const kind  = typeof body.kind === 'string' ? body.kind.trim() : '';
  const refId = typeof body.ref_id === 'string' ? body.ref_id.trim() : '';
  if (!KIND.has(kind))    return res.status(400).json({ error: "kind moet 'tool' of 'trade' zijn" });
  if (!UUID_RE.test(refId)) return res.status(400).json({ error: 'ref_id (uuid) vereist' });

  const filenameHint = typeof body.filename === 'string' ? body.filename : 'img';

  try {
    // ── (a) File-mode ─────────────────────────────────────────────────────
    const dataB64     = typeof body.data_base64 === 'string' ? body.data_base64 : '';
    const contentType = typeof body.content_type === 'string' ? body.content_type.trim().toLowerCase() : '';
    if (dataB64) {
      if (!contentType || !ALLOWED_MIME.has(contentType)) {
        return res.status(400).json({ error: 'content_type moet JPEG/PNG/WEBP zijn' });
      }
      let buf;
      try { buf = Buffer.from(dataB64, 'base64'); }
      catch { return res.status(400).json({ error: 'data_base64 niet geldig base64' }); }
      if (!buf || buf.length === 0) return res.status(400).json({ error: 'data_base64 decode 0 bytes' });
      if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'bestand te groot' });

      const path = buildPath(ctx.userId, kind, refId, contentType, filenameHint);
      const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buf, {
        contentType, upsert: false,
      });
      if (upErr) {
        if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
          return res.status(503).json({ error: `Storage bucket '${BUCKET}' niet gevonden`, detail: upErr.message });
        }
        console.error('[sa-upload] storage error:', upErr.message);
        return res.status(500).json({ error: 'Upload mislukt', detail: upErr.message });
      }
      return res.status(200).json({ ok: true, image_path: path, size_bytes: buf.length });
    }

    // ── (b) TradingView-URL mode ──────────────────────────────────────────
    const tvUrl = typeof body.tradingview_url === 'string' ? body.tradingview_url.trim() : '';
    if (!tvUrl) {
      return res.status(400).json({ error: 'file (data_base64) of tradingview_url vereist' });
    }
    const resolved = await resolveTradingViewImageUrl(tvUrl);
    if (resolved.error) {
      // Fallback: bewaar de source_url; UI kan de externe URL als embed tonen.
      console.warn('[sa-upload] TV resolve:', resolved.error);
      return res.status(200).json({ ok: true, image_path: null, source_url: tvUrl, warning: resolved.error });
    }
    const dl = await downloadImage(resolved.imgUrl);
    if (dl.error) {
      console.warn('[sa-upload] TV download:', dl.error);
      return res.status(200).json({ ok: true, image_path: null, source_url: tvUrl, warning: dl.error });
    }
    const path = buildPath(ctx.userId, kind, refId, dl.contentType, filenameHint);
    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, dl.buf, {
      contentType: dl.contentType, upsert: false,
    });
    if (upErr) {
      if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
        return res.status(503).json({ error: `Storage bucket '${BUCKET}' niet gevonden`, detail: upErr.message });
      }
      console.error('[sa-upload] TV storage error:', upErr.message);
      return res.status(200).json({ ok: true, image_path: null, source_url: tvUrl, warning: 'upload mislukt' });
    }
    return res.status(200).json({ ok: true, image_path: path, source_url: tvUrl, size_bytes: dl.buf.length });
  } catch (e) {
    console.error('[sa-upload]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
