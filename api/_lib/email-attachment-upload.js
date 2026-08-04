// api/_lib/email-attachment-upload.js
//
// Upload e-mailbijlagen (uit mailparser `parsed.attachments`) naar Supabase
// Storage bucket `email-attachments`. Gedeelde helper tussen sync-emails.js
// (live-poll) en backfill-email-attachments.js (achteraf uploaden voor mails
// waar dit nog niet gebeurd is).
//
// ── Waarom een aparte helper ───────────────────────────────────────
// Pattern-consistent met api/_lib/whatsapp-media-download.js voor WhatsApp-
// media. Dezelfde failure-modes (upload-fout, ontbrekende bucket, size-cap)
// afhandelen op één plek zodat sync + backfill dezelfde garanties geven.
//
// ── FAIL-SOFT ──────────────────────────────────────────────────────
// Deze helper throwt NOOIT bij een individuele upload-fout. Sync mag door,
// mail wordt gewoon opgeslagen met attachments-veld = de rijen die wel
// lukten (of [] bij totaal falen). Caller kan `warnings` inspecteren voor
// diagnose.
//
// ── SIZE-CAP + TIME-BUDGET ─────────────────────────────────────────
// - Bijlagen > MAX_SIZE_BYTES (default 10MB) worden geskipt met warning.
// - Elke upload heeft een per-attachment timeout via AbortController
//   (default 8s) zodat een trage Supabase-upload niet de sync-run kill.
// - Caller kan een globaal `deadlineMs` (Unix timestamp) meegeven zodat
//   remaining attachments worden geskipt zodra dat moment gepasseerd is
//   (bv. sync-emails guard: SYNC_HARD_DEADLINE-5s).
//
// ── API ────────────────────────────────────────────────────────────
// `uploadEmailAttachments(parsedAttachments, opts) → { rows, warnings }`
//   parsedAttachments : output van mailparser (array, kan leeg zijn)
//   opts.mailbox      : 'administratie'|'onboarding'|... (voor path-prefix)
//   opts.imapUid      : integer, unieke id per mailbox (voor path)
//   opts.maxSize      : optioneel; default 10MB
//   opts.deadlineMs   : optioneel; als Date.now() > deadlineMs → skip resterende
//   opts.timeoutMs    : optioneel; default 8000 per upload
//
// Return:
//   rows = [{ filename, mime_type, size_bytes, path, public_url, uploaded_at }]
//   warnings = [string]  (per skipped/failed attachment één regel)

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';

const BUCKET               = 'email-attachments';
const DEFAULT_MAX_SIZE     = 10 * 1024 * 1024;  // 10 MB
const DEFAULT_TIMEOUT_MS   = 8000;
const HARD_MAX_ATTACHMENTS = 20;                 // stop na 20 (spam-guard)

// Mime → extensie voor path-slug. Fallback op 'bin' voor onbekend.
function extFromMime(ct) {
  if (!ct) return 'bin';
  const s = String(ct).toLowerCase();
  const map = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/html': 'html',
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
    'image/svg+xml': 'svg', 'image/tiff': 'tiff',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/quicktime': 'mov',
    'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
    'application/octet-stream': 'bin',
  };
  if (map[s]) return map[s];
  if (s.startsWith('image/')) return s.split('/')[1];
  if (s.startsWith('audio/')) return s.split('/')[1];
  if (s.startsWith('video/')) return s.split('/')[1];
  return 'bin';
}

// Filename safe-slug voor path-injection prevention. Behoudt alleen [a-zA-Z0-9_-.].
// Andere karakters worden '_'. Voorkomt problemen bij bv. filenames met '/' of
// non-ASCII die Supabase Storage-key kunnen breken.
function safeName(name) {
  return String(name || 'file')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function nowIso()      { return new Date().toISOString(); }
function yyyy(dt)      { return String(dt.getUTCFullYear()); }
function mm(dt)        { const m = dt.getUTCMonth() + 1; return m < 10 ? '0' + m : String(m); }

// Wrap fetch/upload met AbortController-based timeout.
async function withTimeout(promise, ms, label) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms)),
  ]);
}

/**
 * Upload een array parsed attachments naar de bucket. Returnt metadata-
 * rijen voor DB-opslag + warnings-lijst voor diagnose.
 *
 * @param {Array}   parsedAttachments  mailparser output array
 * @param {object}  opts
 * @param {string}  opts.mailbox       short-label ('administratie' etc)
 * @param {number}  opts.imapUid       unieke id per mailbox
 * @param {number}  [opts.maxSize]     size-cap in bytes, default 10MB
 * @param {number}  [opts.deadlineMs]  Unix ms; stop als nu > deadlineMs
 * @param {number}  [opts.timeoutMs]   per-upload timeout, default 8000
 * @returns {Promise<{rows: Array, warnings: Array<string>}>}
 */
export async function uploadEmailAttachments(parsedAttachments, opts = {}) {
  const rows     = [];
  const warnings = [];
  const list     = Array.isArray(parsedAttachments) ? parsedAttachments : [];
  if (list.length === 0) return { rows, warnings };

  const mailbox    = String(opts.mailbox || '').trim().toLowerCase();
  const imapUid    = Number(opts.imapUid);
  const maxSize    = Number.isFinite(opts.maxSize) ? opts.maxSize : DEFAULT_MAX_SIZE;
  const timeoutMs  = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : Infinity;
  if (!mailbox || !Number.isFinite(imapUid) || imapUid <= 0) {
    warnings.push('upload skipped: mailbox+imapUid vereist');
    return { rows, warnings };
  }

  // Cap totaal aantal — spam-guard tegen mails met 100+ inline images.
  const bounded = list.slice(0, HARD_MAX_ATTACHMENTS);
  if (list.length > HARD_MAX_ATTACHMENTS) {
    warnings.push(`limited to ${HARD_MAX_ATTACHMENTS} attachments (had ${list.length})`);
  }

  const now = new Date();

  for (let i = 0; i < bounded.length; i++) {
    // Deadline-check per iteratie: als er nog maar seconden over zijn, skip
    // de rest zodat de sync-run zichzelf niet kill.
    if (Date.now() > deadlineMs) {
      warnings.push(`deadline reached; skipped ${bounded.length - i} attachments`);
      break;
    }
    const att = bounded[i];
    try {
      // mailparser attachment-shape: { filename, contentType, size, content: Buffer, cid?, contentDisposition }
      // Inline images met contentDisposition='inline' zijn typisch ook interessant
      // (screenshots ge-embed in body); we filteren NIET op disposition.
      const buf = att?.content;
      if (!buf || !Buffer.isBuffer(buf)) {
        warnings.push(`#${i}: geen buffer content`);
        continue;
      }
      const sizeBytes = buf.length;
      if (sizeBytes === 0) {
        warnings.push(`#${i}: 0 bytes, skipped`);
        continue;
      }
      if (sizeBytes > maxSize) {
        warnings.push(`#${i}: ${sizeBytes} > ${maxSize} bytes, skipped`);
        continue;
      }
      const filename    = safeName(att.filename || `attachment_${i + 1}`);
      const contentType = String(att.contentType || 'application/octet-stream');
      const ext         = extFromMime(contentType);
      const sha8        = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
      // Path-shape: inbound/<mailbox>/<yyyy>/<mm>/<imapUid>-<idx>-<sha8>.<ext>
      // - mailbox scope voor makkelijke cleanup per mailbox
      // - yyyy/mm bucket-splitsing voor overzicht + toekomstige retention
      // - imapUid-idx-sha8 maakt unieke path zonder collision (idempotent bij
      //   backfill: zelfde bytes → zelfde sha8 → zelfde path → upsert no-op)
      const path = `inbound/${mailbox}/${yyyy(now)}/${mm(now)}/${imapUid}-${i}-${sha8}.${ext}`;

      const { error: upErr } = await withTimeout(
        supabaseAdmin.storage.from(BUCKET).upload(path, buf, {
          contentType,
          cacheControl: '3600',
          upsert: true, // idempotent bij backfill van dezelfde mail
        }),
        timeoutMs,
        `upload ${filename}`
      );
      if (upErr) {
        warnings.push(`#${i} ${filename}: upload fail — ${upErr.message}`);
        continue;
      }
      const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
      if (!pub?.publicUrl) {
        warnings.push(`#${i} ${filename}: getPublicUrl leverde niks — bucket public?`);
        continue;
      }
      rows.push({
        filename,
        mime_type: contentType,
        size_bytes: sizeBytes,
        path,
        public_url: pub.publicUrl,
        uploaded_at: nowIso(),
      });
    } catch (e) {
      warnings.push(`#${i}: exception — ${e?.message || String(e)}`);
    }
  }

  return { rows, warnings };
}

// Test-exports
export const _internals = { extFromMime, safeName, BUCKET, DEFAULT_MAX_SIZE, HARD_MAX_ATTACHMENTS };
