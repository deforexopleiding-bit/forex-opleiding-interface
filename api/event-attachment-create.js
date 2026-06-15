// api/event-attachment-create.js
// POST -> nieuwe e-mail-bijlage toevoegen aan de events-mail-bibliotheek.
//
// Permission: events.event.create.
//
// Body (JSON), 2 modi:
//
//   1) URL-modus:
//      { mode: 'url', label: string, url: string (http/https) }
//      → filename = laatste pad-segment uit URL, of label als segment ontbreekt
//      → storage_path = NULL, mime_type = NULL, size_bytes = NULL
//
//   2) Upload-modus:
//      { mode: 'upload', label, filename, mimeType, contentBase64 }
//      → mirror van api/event-image-upload.js, maar pad
//        'mail-attachments/<uuid>-<veilige-filename>.<ext>' in bucket
//        'event-images'.
//      → mime-type-allowlist: afbeeldingen + PDF + gangbare office-docs +
//        text/csv. Uitvoerbare types worden impliciet geweigerd doordat
//        ze niet in de allowlist staan.
//      → max 10 MB binary.
//      → storage_path bewaard zodat delete het bestand kan opruimen.
//
// Response 201: { item: { id, label, filename, url, mime_type, size_bytes,
//                         storage_path, created_at } }
//
// Errors:
//   400  body-validatie (mode, ontbrekende velden, mime niet toegestaan,
//        size > 10 MB, base64-decode-fout, ongeldige http(s)-URL)
//   401  geen sessie
//   403  geen rechten
//   500  storage- of DB-fout
//   503  storage bucket niet gevonden

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const BUCKET    = 'event-images';
const PATH_PREFIX = 'mail-attachments';
const MAX_BYTES = 10 * 1024 * 1024;

// Allowlist: alleen "veilige" bestandstypen. Uitvoerbare formaten
// (exe/msi/bat/sh/ps1/jar/com/scr) staan hier expres NIET in.
const ALLOWED_MIME = new Set([
  // afbeeldingen
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  // PDF
  'application/pdf',
  // Office
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // OpenDocument
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // Tekst
  'text/plain',
  'text/csv',
]);

const EXT_FROM_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg' : 'jpg',
  'image/png' : 'png',
  'image/webp': 'webp',
  'image/gif' : 'gif',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'text/plain': 'txt',
  'text/csv'  : 'csv',
};

function sanitizeFilename(name) {
  return (String(name || 'bijlage')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)) || 'bijlage';
}

function extractFilenameFromUrl(urlStr, fallback) {
  try {
    const u = new URL(urlStr);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) {
      try { return decodeURIComponent(seg); } catch { return seg; }
    }
  } catch { /* fall through */ }
  return fallback || 'bijlage';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.create)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const mode  = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) return res.status(400).json({ error: 'label vereist' });
  if (label.length > 200) return res.status(400).json({ error: 'label max 200 tekens' });

  // ── Mode 1: URL ─────────────────────────────────────────────────────────
  if (mode === 'url') {
    const urlIn = typeof body.url === 'string' ? body.url.trim() : '';
    if (!urlIn) return res.status(400).json({ error: 'url vereist (mode=url)' });
    let parsed;
    try { parsed = new URL(urlIn); }
    catch { return res.status(400).json({ error: 'url ongeldig' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'url moet http(s) zijn' });
    }
    const filename = extractFilenameFromUrl(urlIn, label).slice(0, 200);

    try {
      const { data: row, error } = await supabaseAdmin
        .from('event_mail_attachments')
        .insert({
          label,
          filename,
          url           : urlIn,
          mime_type     : null,
          size_bytes    : null,
          storage_path  : null,
          created_by    : user.id,
        })
        .select('id, label, filename, url, mime_type, size_bytes, storage_path, created_at')
        .single();
      if (error) throw new Error('attachment-insert: ' + error.message);
      return res.status(201).json({ item: row });
    } catch (e) {
      console.error('[event-attachment-create url]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Mode 2: Upload (base64) ─────────────────────────────────────────────
  if (mode === 'upload') {
    const filename    = typeof body.filename === 'string' ? body.filename.trim() : '';
    const mimeTypeRaw = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
    const dataB64     = typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
    if (!filename || !mimeTypeRaw || !dataB64) {
      return res.status(400).json({ error: 'filename + mimeType + contentBase64 vereist (mode=upload)' });
    }
    if (!ALLOWED_MIME.has(mimeTypeRaw)) {
      return res.status(400).json({ error: `mimeType '${mimeTypeRaw}' niet toegestaan` });
    }

    let buf;
    try { buf = Buffer.from(dataB64, 'base64'); }
    catch { return res.status(400).json({ error: 'contentBase64 niet geldig base64' }); }
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'contentBase64 decode 0 bytes' });
    if (buf.length > MAX_BYTES) {
      return res.status(400).json({ error: `Bestand te groot (${buf.length} bytes, max ${MAX_BYTES}).` });
    }

    const baseSafe = sanitizeFilename(filename).replace(/\.[^.]+$/, '') || 'bijlage';
    const ext = EXT_FROM_MIME[mimeTypeRaw] || (filename.match(/\.([a-z0-9]+)$/i) || [])[1] || 'bin';
    const storagePath = `${PATH_PREFIX}/${crypto.randomUUID()}-${baseSafe}.${ext}`;

    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, buf, {
      contentType: mimeTypeRaw,
      upsert     : false,
    });
    if (upErr) {
      if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
        return res.status(503).json({ error: `Storage bucket '${BUCKET}' niet gevonden.`, detail: upErr.message });
      }
      console.error('[event-attachment-create storage]', upErr.message);
      return res.status(500).json({ error: 'Upload mislukt', detail: upErr.message });
    }

    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
    const url = pub?.publicUrl || null;
    if (!url) {
      // Cleanup tegen weeskind-uploads bij URL-resolve faal.
      try { await supabaseAdmin.storage.from(BUCKET).remove([storagePath]); } catch {}
      return res.status(500).json({ error: 'Upload geslaagd maar publicUrl-resolve mislukte' });
    }

    try {
      const { data: row, error } = await supabaseAdmin
        .from('event_mail_attachments')
        .insert({
          label,
          filename     : filename.slice(0, 200),
          url,
          mime_type    : mimeTypeRaw,
          size_bytes   : buf.length,
          storage_path : storagePath,
          created_by   : user.id,
        })
        .select('id, label, filename, url, mime_type, size_bytes, storage_path, created_at')
        .single();
      if (error) {
        // Best-effort cleanup zodat we geen weeskind-bestanden achterlaten.
        try { await supabaseAdmin.storage.from(BUCKET).remove([storagePath]); } catch {}
        throw new Error('attachment-insert: ' + error.message);
      }
      return res.status(201).json({ item: row });
    } catch (e) {
      console.error('[event-attachment-create upload-insert]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: "mode moet 'url' of 'upload' zijn" });
}
