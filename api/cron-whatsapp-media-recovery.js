// api/cron-whatsapp-media-recovery.js
//
// Vangnet-cron voor WhatsApp-inbound-media die op de placeholder
// `media_url = 'meta-media-id:<id>'` is blijven steken — meestal omdat
// de fire-and-forget download in api/inbox-webhook.js door Vercel is
// afgebroken zodra de webhook 200-OK terugstuurde naar Meta.
//
// Schedule: */10 * * * *  (elke 10 min)
// Auth:     CRON_SECRET via Authorization header
// Env:      META_WHATSAPP_ACCESS_TOKEN vereist
//
// Flow per rij:
//   1) SELECT ≤ BATCH rijen met media_url LIKE 'meta-media-id:%'
//      (recente eerst — meer kans op nog-geldige Meta media).
//   2) Extract media_id + media_type uit de rij.
//   3) downloadAndStoreMetaMedia(media_id, media_type) — idempotent via
//      sha256-pad in de bucket (zie _lib/whatsapp-media-download.js).
//   4) Bij succes → updateInboundMediaUrl() overschrijft media_url naar
//      de publieke bucket-URL (LIKE-guard voorkomt race met een parallel-
//      recovery van dezelfde rij).
//   5) Bij Meta 404 (media verlopen — Meta bewaart ~30d) → markeer als
//      `media_url = 'meta-media-expired:<id>'` zodat de LIKE-selector 'em
//      niet meer oppikt. UI (_shared-v2.js) toont dan "media verlopen".
//   6) Andere fouten → console.warn + stats.failed; volgende run probeert
//      opnieuw (typisch transiente Meta-timeout of storage-hiccup).
//
// 0 incasso-writes. Raakt alleen whatsapp_messages.media_url + bucket
// `whatsapp-media` (via helper).

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { downloadAndStoreMetaMedia, updateInboundMediaUrl } from './_lib/whatsapp-media-download.js';

const BATCH_LIMIT = 25;      // per run — houdt Vercel-timeout in de hand
const ABORT_MS    = 25_000;  // Vercel default 30s, marge houden

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  if (!process.env.META_WHATSAPP_ACCESS_TOKEN) {
    return res.status(503).json({
      error: 'META_WHATSAPP_ACCESS_TOKEN niet geconfigureerd — recovery skip.',
    });
  }

  const startMs = Date.now();
  const stats = {
    picked:    0,
    recovered: 0,
    expired:   0,
    failed:    0,
    skipped:   0,
    timed_out: false,
    errors:    [],
  };

  try {
    // Recente eerst: media binnen 30d-window heeft de meeste kans van slagen.
    // Rijen ouder dan ~30d die nog placeholder zijn zullen na de eerste run
    // als 'meta-media-expired:<id>' gemarkeerd worden en de LIKE-selector
    // verlaten — vanaf dan zit de sweep op net-recente stragglers.
    const { data: rows, error } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id, media_url, media_type, created_at')
      .like('media_url', 'meta-media-id:%')
      .order('created_at', { ascending: false })
      .limit(BATCH_LIMIT);
    if (error) throw error;

    for (const row of (rows || [])) {
      if (Date.now() - startMs > ABORT_MS) {
        stats.timed_out = true;
        break;
      }
      stats.picked++;

      const mediaId = String(row.media_url || '').replace(/^meta-media-id:/, '').trim();
      if (!mediaId) {
        // Malformed placeholder — mark als expired zodat 'ie niet blijft
        // terugkomen en trek de aandacht via failed-count.
        await supabaseAdmin
          .from('whatsapp_messages')
          .update({ media_url: 'meta-media-expired:MALFORMED' })
          .eq('id', row.id);
        stats.failed++;
        if (stats.errors.length < 5) stats.errors.push({ id: row.id, err: 'lege media_id' });
        continue;
      }

      // media_type is de bron van waarheid voor het pad-prefix in de bucket
      // (image/document/audio/video/sticker). Fallback op 'image' als kolom
      // NULL blijkt (bevestigd niet in productie, maar defensief).
      const waType = String(row.media_type || 'image').toLowerCase();

      const dl = await downloadAndStoreMetaMedia(mediaId, waType, { messageId: row.id });

      if (dl.ok && dl.publicUrl) {
        const up = await updateInboundMediaUrl(row.id, dl.publicUrl, {
          originalFilename: dl.originalFilename || null,
          hasBody:          true,  // recovery: nooit body overschrijven met filename
        });
        if (up.ok) {
          stats.recovered++;
        } else {
          stats.failed++;
          if (stats.errors.length < 5) stats.errors.push({ id: row.id, err: 'update: ' + up.error });
        }
      } else {
        const errStr = String(dl.error || '');
        // Meta 404 = media verlopen (>~30d). Markeer met eigen prefix zodat:
        //   (a) de LIKE-selector 'em niet meer oppikt (geen retry-storm).
        //   (b) de UI-render in _shared-v2.js kan detecteren + "media verlopen"
        //       tonen i.p.v. "kon niet geladen worden".
        if (/HTTP 404/.test(errStr) || /Media not found/i.test(errStr)) {
          const { error: markErr } = await supabaseAdmin
            .from('whatsapp_messages')
            .update({ media_url: 'meta-media-expired:' + mediaId })
            .eq('id', row.id)
            .like('media_url', 'meta-media-id:%');
          if (markErr) {
            stats.failed++;
            if (stats.errors.length < 5) stats.errors.push({ id: row.id, err: 'mark-expired: ' + markErr.message });
          } else {
            stats.expired++;
          }
        } else {
          // Transiente fout — volgende run probeert opnieuw. Log de eerste
          // paar zodat Vercel-logs de kern-oorzaak laten zien.
          stats.failed++;
          if (stats.errors.length < 5) stats.errors.push({ id: row.id, err: 'download: ' + errStr.slice(0, 200) });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      duration_ms: Date.now() - startMs,
      ...stats,
    });
  } catch (e) {
    console.error('[cron-whatsapp-media-recovery] onverwacht:', e?.message || e);
    return res.status(500).json({
      error: e?.message || String(e),
      duration_ms: Date.now() - startMs,
      ...stats,
    });
  }
}
