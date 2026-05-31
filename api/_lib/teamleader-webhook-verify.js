// api/_lib/teamleader-webhook-verify.js
//
// PLACEHOLDER signature-verificatie voor inkomende TL-webhooks.
//
// LET OP — nog NIET live geverifieerd. TL stuurt naar verluidt een
// `x-teamleader-signature` header, vermoedelijk HMAC-SHA256 over de RUWE
// request-body met een secret. Het exacte algoritme + de herkomst van het
// secret moeten bevestigd worden zodra de eerste echte `deal.won` binnenkomt
// (inspecteer dan de header + payload in teamleader_webhook_events).
//
// Aanpassen na verificatie = alleen deze functie wijzigen.
//
// Gedrag nu:
//   - Geen TEAMLEADER_WEBHOOK_SECRET gezet → dev-mode: accepteer + log warning.
//   - Wel secret → bereken HMAC-SHA256(rawBody) en vergelijk timing-safe met
//     de header. Bij mismatch → reject.

import crypto from 'crypto';

const SIGNATURE_HEADER = 'x-teamleader-signature';

export function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.TEAMLEADER_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[tl-webhook] TEAMLEADER_WEBHOOK_SECRET niet gezet — dev-mode, signature niet geverifieerd');
    return { valid: true, devMode: true };
  }

  const provided = headers?.[SIGNATURE_HEADER] || headers?.[SIGNATURE_HEADER.toLowerCase()];
  if (!provided) return { valid: false, reason: 'geen signature-header' };

  // Placeholder-schema: HMAC-SHA256(rawBody) hex. Pas aan na live-verificatie.
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: 'signature mismatch' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'vergelijking mislukt' };
  }
}
