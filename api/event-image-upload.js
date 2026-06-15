// api/event-image-upload.js
// POST -> upload een event-foto (JPEG/PNG/WEBP) naar de Supabase storage
// bucket `event-images`. Returnt een PUBLIEKE, langlevende URL die in
// events.image_url wordt opgeslagen en in de assessment-picker getoond wordt.
//
// RBAC: sessie-JWT + (events.event.create OF events.event.edit).
// Body (JSON, base64 zodat Vercel serverless geen multipart-parser nodig heeft):
//   { filename: string, content_type: string, data_base64: string }
// Limiet: 3 MB binary. Response 200 { ok, url, path, content_type, size_bytes }.
// 400 validatie | 401/403 auth | 503 bucket ontbreekt | 500 upload-fout.

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const BUCKET = 'event-images';
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sanitizeFilename(name) {
  return (String(name || 'foto')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)) || 'foto';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const okCreate = await requirePermission(req, 'events.event.create').catch(() => false);
  const okEdit   = await requirePermission(req, 'events.event.edit').catch(() => false);
  if (!okCreate && !okEdit) {
    return res.status(403).json({ error: 'Geen rechten (events.event.create of events.event.edit vereist)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const filename    = typeof body.filename === 'string' ? body.filename.trim() : '';
  const contentType = typeof body.content_type === 'string' ? body.content_type.trim().toLowerCase() : '';
  const dataB64     = typeof body.data_base64 === 'string' ? body.data_base64 : '';

  if (!filename || !contentType || !dataB64) {
    return res.status(400).json({ error: 'filename + content_type + data_base64 vereist' });
  }
  if (!ALLOWED_MIME.has(contentType)) {
    return res.status(400).json({ error: `content_type '${contentType}' niet toegestaan (alleen JPEG/PNG/WEBP)` });
  }

  let buf;
  try { buf = Buffer.from(dataB64, 'base64'); }
  catch { return res.status(400).json({ error: 'data_base64 niet geldig base64' }); }
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'data_base64 decode 0 bytes' });
  if (buf.length > MAX_BYTES) {
    return res.status(400).json({ error: `Bestand te groot (${buf.length} bytes, max ${MAX_BYTES}).` });
  }

  const now = new Date();
  const ym  = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const baseSafe = sanitizeFilename(filename).replace(/\.[^.]+$/, '') || 'foto';
  const ext = EXT[contentType] || 'jpg';
  const path = `events/${ym}/${crypto.randomUUID()}-${baseSafe}.${ext}`;

  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buf, {
    contentType, upsert: false,
  });
  if (upErr) {
    if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
      return res.status(503).json({ error: `Storage bucket '${BUCKET}' niet gevonden.`, detail: upErr.message });
    }
    console.error('[event-image-upload] storage error:', upErr.message);
    return res.status(500).json({ error: 'Upload mislukt', detail: upErr.message });
  }

  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  const url = pub?.publicUrl || null;
  if (!url) return res.status(500).json({ error: 'Upload geslaagd maar publicUrl-resolve mislukte' });

  return res.status(200).json({ ok: true, url, path, content_type: contentType, size_bytes: buf.length });
}
