// api/_lib/whatsapp-media-download.js
// Meta Graph API media-download helper. Twee stappen (per Meta v20-spec):
//   1) GET /{media_id}?fields=url,mime_type,file_size  → media-metadata,
//      inclusief een tijdelijke download-URL (~5 min geldig).
//   2) GET <url> met dezelfde Bearer-token → bytes.
//
// Uploadt daarna naar de bestaande Supabase storage-bucket
// `whatsapp-media` (zelfde bucket als whatsapp-media-upload.js) en
// retourneert een public URL die whatsapp_messages.media_url kan
// vervangen (dan verdwijnt de 'meta-media-id:<id>' placeholder).
//
// Fail-soft: exports throwen NIET default; caller (webhook) mag ze
// opnieuw runnen. Zie inbox-webhook.js voor de fire-and-forget wrap.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';

const META_API_VERSION = 'v20.0';
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;
const BUCKET           = 'whatsapp-media';

// Mapping van whatsapp-type → path-prefix binnen de bucket.
const KIND_BY_TYPE = {
  image   : 'inbound/images',
  document: 'inbound/documents',
  audio   : 'inbound/audio',
  video   : 'inbound/video',
  sticker : 'inbound/stickers',
};

function extFromMime(ct) {
  if (!ct) return 'bin';
  const s = String(ct).toLowerCase();
  const map = {
    'image/jpeg'                       : 'jpg',
    'image/jpg'                        : 'jpg',
    'image/png'                        : 'png',
    'image/webp'                       : 'webp',
    'image/gif'                        : 'gif',
    'application/pdf'                  : 'pdf',
    'application/msword'               : 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'   : 'docx',
    'application/vnd.ms-excel'         : 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'         : 'xlsx',
    'application/vnd.ms-powerpoint'    : 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'pptx',
    'text/plain'                       : 'txt',
    'audio/mpeg'                       : 'mp3',
    'audio/ogg'                        : 'ogg',
    'audio/mp4'                        : 'm4a',
    'audio/amr'                        : 'amr',
    'video/mp4'                        : 'mp4',
    'video/3gpp'                       : '3gp',
  };
  if (map[s]) return map[s];
  if (s.startsWith('image/'))    return s.split('/')[1];
  if (s.startsWith('audio/'))    return s.split('/')[1];
  if (s.startsWith('video/'))    return s.split('/')[1];
  return 'bin';
}

/**
 * Download een media-file van Meta Cloud API en upload 'em naar de
 * whatsapp-media bucket. Retourneert `{ ok, publicUrl, path, contentType,
 * sizeBytes, sha256, originalFilename? }` bij succes; bij fout
 * `{ ok: false, error }`. Throwt NIET.
 *
 * @param {string} mediaId  — Meta media-id uit webhook payload
 * @param {string} waType   — 'image' | 'document' | 'audio' | 'video' | 'sticker'
 * @param {object} [opts]
 * @param {string} [opts.messageId] — whatsapp_messages.id (voor het pad)
 * @param {string} [opts.filename]  — origineel van klant (bv. bij document)
 */
export async function downloadAndStoreMetaMedia(mediaId, waType, opts = {}) {
  if (!mediaId) return { ok: false, error: 'media_id ontbreekt' };
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) return { ok: false, error: 'META_WHATSAPP_ACCESS_TOKEN ontbreekt' };

  try {
    // Stap 1: media-metadata + tijdelijke download-URL.
    const metaResp = await fetch(`${META_BASE_URL}/${encodeURIComponent(mediaId)}?fields=url,mime_type,file_size,sha256`, {
      method : 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResp.ok) {
      const t = await metaResp.text().catch(() => '');
      return { ok: false, error: `metadata HTTP ${metaResp.status}: ${t.slice(0, 200)}` };
    }
    const info = await metaResp.json().catch(() => ({}));
    const url  = info?.url || null;
    const contentType = info?.mime_type || 'application/octet-stream';
    if (!url) return { ok: false, error: 'geen url in Meta metadata' };

    // Stap 2: bytes ophalen. Meta vereist Bearer op de temp-URL ook.
    const binResp = await fetch(url, {
      method : 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!binResp.ok) {
      const t = await binResp.text().catch(() => '');
      return { ok: false, error: `download HTTP ${binResp.status}: ${t.slice(0, 200)}` };
    }
    const arrayBuf = await binResp.arrayBuffer();
    const bytes    = new Uint8Array(arrayBuf);
    const sizeBytes = bytes.byteLength;
    const sha256    = crypto.createHash('sha256').update(bytes).digest('hex');

    // Stap 3: upload naar bucket. Pad = <kind-prefix>/<yyyy>/<mm>/<hash>.<ext>.
    const prefix = KIND_BY_TYPE[waType] || 'inbound/other';
    const now    = new Date();
    const yyyy   = String(now.getUTCFullYear());
    const mm     = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext    = extFromMime(contentType);
    const path   = `${prefix}/${yyyy}/${mm}/${sha256.slice(0, 32)}.${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, {
        contentType,
        upsert: true,     // deterministisch pad (sha256), dus idempotent bij retry
        cacheControl: '31536000',
      });
    if (upErr) return { ok: false, error: `storage: ${upErr.message}` };

    // Stap 4: publieke URL uit de bucket.
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = pub?.publicUrl || null;
    if (!publicUrl) return { ok: false, error: 'geen publicUrl teruggekregen uit bucket' };

    return {
      ok               : true,
      publicUrl,
      path,
      contentType,
      sizeBytes,
      sha256,
      originalFilename : opts.filename || null,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Update de whatsapp_messages-row met de vers gedownloade media-URL.
 * media_url gaat van 'meta-media-id:<id>' naar public URL.
 * Idempotent: als er al een publieke URL staat, doen we niets.
 */
export async function updateInboundMediaUrl(messageId, publicUrl, extra = {}) {
  if (!messageId || !publicUrl) return { ok: false, error: 'messageId + publicUrl vereist' };
  try {
    const patch = { media_url: publicUrl };
    // Body wordt niet overschreven: caption blijft. Filename hangen we
    // in body als het body nog leeg is (nice-to-have voor UI-download-link).
    if (extra?.originalFilename && !extra.hasBody) {
      patch.body = extra.originalFilename;
    }
    const { error } = await supabaseAdmin
      .from('whatsapp_messages')
      .update(patch)
      .eq('id', messageId)
      .like('media_url', 'meta-media-id:%');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
