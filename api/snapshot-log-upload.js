// api/snapshot-log-upload.js
// POST → upload een DOM-snapshot (WebP base64) naar 'activity-snapshots'-bucket
// + snapshot_log-rij. Client-hook triggert dit ná write-actions (RFC 2 / #snapshot-B).
//
// Body (JSON + base64 — spiegelt event-image-upload.js zodat Vercel serverless
// geen multipart-parser nodig heeft):
//   {
//     data_base64: string,     -- WebP-blob base64-encoded
//     action_hint: string,     -- ≤ 100 chars (bv. 'customer.update', 'bulk-wa-send')
//     view_url:    string,     -- ≤ 500 chars (location.pathname + hash)
//     view_title?: string,     -- ≤ 200 chars (document.title, optioneel)
//   }
//
// Permission: elke ingelogde CRM-user upload eigen rijen. Read via
// snapshot_log RLS = super_admin only.
// Rate-limit: 10 POST/min/user.
// Errors: 400 validatie, 401 unauth, 429 rate, 500 storage/DB fail.

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { getClientIp } from './_lib/audit-customer.js';

// Base64 blaast 1.33x op. 500KB webp → ~666KB base64 body.
// Body-parser limiet omhoog naar 900KB (default Vercel = 1MB — net krap bij overhead).
export const config = {
  api: { bodyParser: { sizeLimit: '1400kb' } },   // 900KB base64 × 1.33 + JSON overhead
};

const MAX_SIZE_BYTES  = 900 * 1024;   // client-cap in snapshot-hook.js identiek
const MAX_ACTION_HINT = 100;
const MAX_VIEW_URL    = 500;
const MAX_VIEW_TITLE  = 200;
const BUCKET          = 'activity-snapshots';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const rl = await checkRateLimit({ req, bucket: 'snapshot-upload', maxHits: 10, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const dataB64     = typeof body.data_base64 === 'string' ? body.data_base64 : '';
  const action_hint = typeof body.action_hint === 'string' ? body.action_hint.trim() : '';
  const view_url    = typeof body.view_url    === 'string' ? body.view_url.trim()    : '';
  const view_title  = typeof body.view_title  === 'string' ? body.view_title.trim()  : null;

  if (!dataB64)                              return res.status(400).json({ error: 'data_base64 vereist' });
  if (!action_hint)                          return res.status(400).json({ error: 'action_hint vereist' });
  if (!view_url)                             return res.status(400).json({ error: 'view_url vereist' });
  if (action_hint.length > MAX_ACTION_HINT)  return res.status(400).json({ error: `action_hint > ${MAX_ACTION_HINT} chars` });
  if (view_url.length > MAX_VIEW_URL)        return res.status(400).json({ error: `view_url > ${MAX_VIEW_URL} chars` });
  if (view_title && view_title.length > MAX_VIEW_TITLE)
                                             return res.status(400).json({ error: `view_title > ${MAX_VIEW_TITLE} chars` });

  let buf;
  try { buf = Buffer.from(dataB64, 'base64'); }
  catch { return res.status(400).json({ error: 'data_base64 niet geldig base64' }); }
  if (!buf || buf.length === 0)          return res.status(400).json({ error: 'data_base64 decode 0 bytes' });
  if (buf.length > MAX_SIZE_BYTES)       return res.status(400).json({ error: `snapshot > ${Math.round(MAX_SIZE_BYTES/1024)}KB` });

  // WebP-magic-bytes check ('RIFF'…'WEBP') — voorkomt dat we een base64 van
  // een random binary opslaan als "webp". Fail-fast op 400.
  const isWebp = buf.length >= 12
                 && buf.slice(0, 4).toString() === 'RIFF'
                 && buf.slice(8, 12).toString() === 'WEBP';
  if (!isWebp) return res.status(400).json({ error: 'file moet image/webp zijn (RIFF-WEBP header ontbreekt)' });

  const id      = crypto.randomUUID();
  const path    = `${user.id}/${id}.webp`;
  const size_kb = Math.max(1, Math.round(buf.length / 1024));

  try {
    // Upload naar bucket (service-role bypasst storage-RLS).
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, buf, {
        contentType:  'image/webp',
        cacheControl: '3600',
        upsert:       false,
      });
    if (upErr) {
      console.error('[snapshot-log-upload] storage upload fail:', upErr.message);
      return res.status(500).json({ error: 'Interne fout' });
    }

    const { error: dbErr } = await supabaseAdmin.from('snapshot_log').insert({
      id,
      user_id:      user.id,
      user_email:   user.email || null,
      view_url:     view_url.slice(0, MAX_VIEW_URL),
      view_title:   view_title ? view_title.slice(0, MAX_VIEW_TITLE) : null,
      action_hint:  action_hint.slice(0, MAX_ACTION_HINT),
      storage_path: path,
      size_kb,
      ip:           getClientIp(req),
      user_agent:   req.headers?.['user-agent'] || null,
    });
    if (dbErr) {
      // Cleanup upload zodat er geen orphan blijft; cron zou 't sowieso
      // pakken maar early-cleanup houdt bucket schoon bij DB-fail.
      try { await supabaseAdmin.storage.from(BUCKET).remove([path]); } catch (_) {}
      console.error('[snapshot-log-upload] db insert fail:', dbErr.message);
      return res.status(500).json({ error: 'Interne fout' });
    }

    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error('[snapshot-log-upload]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
