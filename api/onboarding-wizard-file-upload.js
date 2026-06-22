// api/onboarding-wizard-file-upload.js
//
// ADMIN — vraag een SIGNED UPLOAD URL aan voor een wizard-bestand. De
// editor-UI uploadt vervolgens DIRECT naar Supabase Storage met die URL
// (zonder dat het bestand door deze serverless functie heen hoeft —
// belangrijk i.v.m. Vercel-payload-limieten en 60s timeout).
//
// Permission: onboarding.wizard.edit.
//
// Bucket: 'onboarding-files' (privé). Pad-prefix: 'wizard/' + uuid + '-' +
// sanitized-filename (extensie behouden). Geen user-prefix nodig — alleen
// admins met 'onboarding.wizard.edit' kunnen paden aanmaken.
//
// Body:
//   { filename : string,                    // origineel (voor weergave + extensie-detectie)
//     content_type? : string }              // optioneel, alleen voor cosmetische return
//
// Response 200:
//   { ok:true,
//     path        : string,                 // bucket-relatief pad — sla op in files[].path
//     name        : string,                 // sanitized display-name → files[].name
//     signed_url  : string,                 // hier doet de editor PUT/POST
//     token       : string,                 // Supabase upload-token (uploadToSignedUrl)
//     bucket      : 'onboarding-files',
//     expires_in  : 3600 }
//
// (De UI plaatst {path, name} in files[] van een file_download-block en
// roept onboarding-wizard-config-save aan; lege/onbruikbare paden worden
// door normalizeStructure gedropt.)

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const STORAGE_BUCKET = 'onboarding-files';
const PATH_PREFIX    = 'wizard/';
const MAX_NAME_LEN   = 240;

function sanitizeFilename(name) {
  // Vervang alles wat geen [A-Za-z0-9._-] is door '_'. Voorkom path-traversal.
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, MAX_NAME_LEN) || 'file';
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
  if (!(await requirePermission(req, 'onboarding.wizard.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.wizard.edit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const rawName = typeof body.filename === 'string' ? body.filename.trim() : '';
  if (!rawName) return res.status(400).json({ error: 'filename vereist' });

  const safeName = sanitizeFilename(rawName);
  const path = `${PATH_PREFIX}${crypto.randomUUID()}-${safeName}`;

  try {
    const { data, error } = await supabaseAdmin
      .storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(path);
    if (error) throw new Error('signed upload url: ' + error.message);
    if (!data?.signedUrl || !data?.token) {
      throw new Error('signed upload url: lege response');
    }

    return res.status(200).json({
      ok         : true,
      path,
      name       : safeName,
      signed_url : data.signedUrl,
      token      : data.token,
      bucket     : STORAGE_BUCKET,
      expires_in : 3600,
    });
  } catch (e) {
    console.error('[onboarding-wizard-file-upload]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
