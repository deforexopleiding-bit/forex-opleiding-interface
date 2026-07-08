// api/_lib/rate-limit.js
//
// Generieke rate-limiter voor publieke schrijf-endpoints (H3 security).
// Hergebruikt hashIp/extractClientIp uit assessment-validation.js zodat
// ip-hashing overal consistent is (zelfde salt = SUPABASE_URL).
//
// Gebruik:
//   const { limited } = await checkRateLimit({
//     req,
//     bucket: 'onboarding-complete',
//     maxHits: 10,
//     withinSeconds: 60,
//   });
//   if (limited) return res.status(429).json({ error: '…' });
//
// FAIL-OPEN: bij elke DB-fout of ontbrekend IP-hash return { limited: false }.
// Een storing in de rate-limiter mag legitieme klanten NOOIT blokkeren.
// Alleen console.warn logs zodat we het achteraf kunnen zien.
//
// Persistence: schrijft één rij per verzoek naar rate_limit_hits (migratie 022).
// cron-activity-log-cleanup ruimt rijen > 1 dag op.

import { supabaseAdmin } from '../supabase.js';
import { extractClientIp, hashIp } from './assessment-validation.js';

/**
 * Rate-limit check + hit-registratie in één call.
 *
 * @param {object} opts
 * @param {object} opts.req              — Vercel request (voor IP)
 * @param {string} opts.bucket           — endpoint-naam / bucket-key
 * @param {number} opts.maxHits          — maximum verzoeken binnen het venster
 * @param {number} opts.withinSeconds    — vensterlengte in seconden
 * @returns {Promise<{limited: boolean, count?: number}>}
 */
export async function checkRateLimit({ req, bucket, maxHits, withinSeconds }) {
  if (!bucket || !Number.isFinite(maxHits) || !Number.isFinite(withinSeconds)) {
    console.warn('[rate-limit] misconfigured call — bucket/maxHits/withinSeconds vereist');
    return { limited: false };
  }

  const ip     = extractClientIp(req);
  const ipHash = hashIp(ip);
  if (!ipHash) {
    // Geen IP → we kunnen niet zinnig limiteren. Fail-open (zelfde als
    // assessment-validation.isRateLimited).
    return { limited: false };
  }

  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();

  try {
    // 1) Tel bestaande hits in het venster.
    const { count, error: countErr } = await supabaseAdmin
      .from('rate_limit_hits')
      .select('id', { count: 'exact', head: true })
      .eq('bucket', bucket)
      .eq('ip_hash', ipHash)
      .gte('created_at', since);

    if (countErr) {
      console.warn('[rate-limit] count error (fail-open):', countErr.message);
      return { limited: false };
    }

    if ((count || 0) >= maxHits) {
      return { limited: true, count: count || 0 };
    }

    // 2) Registreer deze hit. Fail-open bij insert-fout — de count-check
    //    hierboven blijft leidend voor volgende requests.
    const { error: insErr } = await supabaseAdmin
      .from('rate_limit_hits')
      .insert({ bucket, ip_hash: ipHash });
    if (insErr) {
      console.warn('[rate-limit] insert error (fail-open):', insErr.message);
    }

    return { limited: false, count: (count || 0) + 1 };
  } catch (e) {
    console.warn('[rate-limit] exception (fail-open):', e?.message || e);
    return { limited: false };
  }
}
