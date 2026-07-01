// api/secret-area-upload.js
// POST → owner-gated image ingest. Twee modes:
//   (a) file: { filename, content_type, data_base64, kind:'tool'|'trade', ref_id }
//   (b) tradingview_url: { tradingview_url, kind:'tool'|'trade', ref_id }
// ref_id = tool_id of trade_id (voor pad-scoping). kind bepaalt subfolder.
// Response: { ok, image_path?, source_url?, size_bytes? }
//
// Alle SSRF-hardening (regex-allowlist, host-allowlist, manual-redirect,
// timeout, MIME/size-cap) leeft in api/_lib/secretAreaImageIngest.js. Dit
// endpoint doet auth + parameter-parsing en delegeert de rest naar de helper,
// zodat secret-area-analyze.js precies dezelfde guards heeft (geen drift).
//
// Bucket = 'secret-area' (private, service-role upload; getekende URLs elders).

import { requireOwner } from './_lib/secretArea.js';
import {
  ingestBase64,
  ingestTradingViewUrl,
  UUID_RE,
} from './_lib/secretAreaImageIngest.js';

const KIND = new Set(['tool', 'trade']);

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
  if (!KIND.has(kind))     return res.status(400).json({ error: "kind moet 'tool' of 'trade' zijn" });
  if (!UUID_RE.test(refId)) return res.status(400).json({ error: 'ref_id (uuid) vereist' });

  const filenameHint = typeof body.filename === 'string' ? body.filename : 'img';

  try {
    // ── (a) File-mode ─────────────────────────────────────────────────────
    const dataB64 = typeof body.data_base64 === 'string' ? body.data_base64 : '';
    if (dataB64) {
      const r = await ingestBase64({
        ownerId:      ctx.userId,
        kind, refId,
        contentType:  body.content_type,
        dataBase64:   dataB64,
        filenameHint,
      });
      if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
      return res.status(200).json({ ok: true, image_path: r.image_path, size_bytes: r.size_bytes });
    }

    // ── (b) TradingView-URL mode ──────────────────────────────────────────
    const tvUrl = typeof body.tradingview_url === 'string' ? body.tradingview_url.trim() : '';
    if (!tvUrl) {
      return res.status(400).json({ error: 'file (data_base64) of tradingview_url vereist' });
    }
    const r = await ingestTradingViewUrl({
      ownerId: ctx.userId,
      kind, refId, tvUrl, filenameHint,
    });
    return res.status(200).json({
      ok:          true,
      image_path:  r.image_path,
      source_url:  r.source_url,
      size_bytes:  r.size_bytes,
      warning:     r.warning,
    });
  } catch (e) {
    console.error('[sa-upload]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
