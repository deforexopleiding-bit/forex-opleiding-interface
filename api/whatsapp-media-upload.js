// api/whatsapp-media-upload.js
// POST -> upload een sample/runtime media-file naar de Supabase storage
// bucket `whatsapp-media`. Returnt een PUBLIEKE, langlevende URL die zowel
// als Meta-template-approval-sample (uren/dagen fetchen) als runtime-bijlage
// kan dienen.
//
// RBAC: gebruiker moet sessie-JWT hebben EN minstens een van:
//   - finance.inbox.send       (send-modal media-upload)
//   - admin.whatsapp_templates (editor sample-media upload, Fase B)
//
// Body (JSON, base64-encoded zodat Vercel serverless geen multipart-parser
// nodig heeft):
//   {
//     filename     : string,         // origineel, voor doc-displayName + sanitize
//     content_type : string,         // bv. 'image/jpeg', 'application/pdf'
//     kind         : 'image'|'video'|'document', // bepaalt size-limit + path-prefix
//     data_base64  : string          // base64 van de file-bytes (inclusief padding)
//   }
//
// Limieten (Meta-conform):
//   image    : 5 MB binary
//   video    : 16 MB binary
//   document : 100 MB binary - in praktijk gecapt op MAX_JSON_BODY_MB (Vercel
//              JSON-body-limiet ~ 4.5MB). Voor grotere docs is Fase C
//              (signed-upload-url + direct-to-storage) nodig.
//
// Response 200:
//   { ok:true, url, path, content_type, size_bytes }
// Response 400: validatie-fout (missing fields, bad MIME, oversized)
// Response 401/403: auth/RBAC
// Response 500: storage/upload-fout
// Response 503: storage niet geconfigureerd (bucket bestaat niet)

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const BUCKET = 'whatsapp-media';

// Max base64-payload size voor onze JSON-body. Vercel hobby = ~4.5MB,
// Pro = 5MB JSON-body. Base64 inflates ~4/3. Marge: 3 MB binary post-decode.
const MAX_JSON_BODY_MB = 3;
const MAX_JSON_BODY_BYTES = MAX_JSON_BODY_MB * 1024 * 1024;

// Per Meta-spec — Bytes na decode. We cappen aan onze JSON-body-limiet voor
// document/video; voor image is Meta's eigen limiet kleiner dus die wint.
const META_LIMITS = {
  image   : 5  * 1024 * 1024,  // 5 MB (we cappen impliciet op MAX_JSON_BODY_BYTES = 3 MB)
  video   : 16 * 1024 * 1024,  // 16 MB (idem)
  document: 100 * 1024 * 1024, // 100 MB (we cappen op MAX_JSON_BODY_BYTES)
};

// Sanity-set van geaccepteerde MIME-types per kind, conform Meta-doc 2025.
const ALLOWED_MIME = {
  image: new Set([
    'image/jpeg', 'image/jpg', 'image/png',
  ]),
  video: new Set([
    'video/mp4', 'video/3gpp',
  ]),
  document: new Set([
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
  ]),
};

function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'file.bin';
  const trimmed = name.trim().slice(0, 200);
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file.bin';
}

function extFromContentType(ct) {
  if (!ct) return 'bin';
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'video/mp4': 'mp4', 'video/3gpp': '3gp',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
  };
  return map[ct] || 'bin';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Sessie-JWT.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // RBAC: OR over twee scopes.
  const okSend  = await requirePermission(req, 'finance.inbox.send').catch(() => false);
  const okTmpl  = await requirePermission(req, 'admin.whatsapp_templates').catch(() => false);
  if (!okSend && !okTmpl) {
    return res.status(403).json({
      error: 'Geen rechten (finance.inbox.send of admin.whatsapp_templates vereist)',
    });
  }

  // Body.
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const filename    = typeof body.filename === 'string' ? body.filename.trim() : '';
  const contentType = typeof body.content_type === 'string' ? body.content_type.trim().toLowerCase() : '';
  const kindRaw     = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  const dataB64     = typeof body.data_base64 === 'string' ? body.data_base64 : '';

  if (!filename || !contentType || !kindRaw || !dataB64) {
    return res.status(400).json({
      error: 'filename + content_type + kind + data_base64 vereist',
    });
  }
  if (!ALLOWED_MIME[kindRaw]) {
    return res.status(400).json({ error: `kind moet image|video|document zijn, kreeg '${kindRaw}'` });
  }
  if (!ALLOWED_MIME[kindRaw].has(contentType)) {
    return res.status(400).json({
      error: `content_type '${contentType}' niet toegestaan voor kind='${kindRaw}'`,
    });
  }

  // Decode + size-check.
  let buf;
  try {
    buf = Buffer.from(dataB64, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'data_base64 niet geldig base64' });
  }
  if (!buf || buf.length === 0) {
    return res.status(400).json({ error: 'data_base64 decode 0 bytes' });
  }
  if (buf.length > MAX_JSON_BODY_BYTES) {
    return res.status(400).json({
      error: `Bestand te groot voor base64-upload (${buf.length} bytes, max ${MAX_JSON_BODY_BYTES}). Fase C zal direct-to-storage signed-upload toevoegen.`,
    });
  }
  if (buf.length > META_LIMITS[kindRaw]) {
    return res.status(400).json({
      error: `Bestand overschrijdt Meta-limiet voor ${kindRaw} (${buf.length} bytes, Meta max ${META_LIMITS[kindRaw]}).`,
    });
  }

  // Build storage path: <kind>/<yyyy-mm>/<uuid>-<sanitized-filename>.<ext>.
  // Maand-prefix voor groeperen + uuid voor unieke namen ondanks dezelfde
  // originele filename.
  const now = new Date();
  const ym  = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const safeName = sanitizeFilename(filename);
  const baseSafe = safeName.replace(/\.[^.]+$/, '') || 'file';
  const ext      = extFromContentType(contentType);
  const uuid     = crypto.randomUUID();
  const path     = `${kindRaw}/${ym}/${uuid}-${baseSafe}.${ext}`;

  // Upload naar Supabase storage. service_role bypassed RLS; bucket moet
  // public-read zijn voor de URL die we teruggeven, anders ziet Meta 'm niet.
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buf, {
    contentType,
    upsert: false,
  });
  if (upErr) {
    // Bucket-not-found mapping voor duidelijke admin-feedback.
    if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
      return res.status(503).json({
        error: `Storage bucket '${BUCKET}' niet gevonden. Admin moet 'm aanmaken in Supabase dashboard met public read.`,
        detail: upErr.message,
      });
    }
    console.error('[whatsapp-media-upload] storage upload error:', upErr.message);
    return res.status(500).json({ error: 'Upload mislukt', detail: upErr.message });
  }

  // Public URL voor Meta (langlevend - GEEN signed URL met expiry).
  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  const url = pub?.publicUrl || null;
  if (!url) {
    return res.status(500).json({ error: 'Upload geslaagd maar publicUrl-resolve mislukte' });
  }

  return res.status(200).json({
    ok          : true,
    url,
    path,
    content_type: contentType,
    kind        : kindRaw,
    size_bytes  : buf.length,
  });
}
