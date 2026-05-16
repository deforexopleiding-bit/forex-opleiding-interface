// api/zoom-webhook.js
//
// Stub endpoint voor Zoom Marketplace webhooks (Follow-up Module).
//
// VERSIE: stub — handelt alleen CRC URL validation af voor Zoom
// Marketplace app verification. Echte event-handlers (meeting.started,
// meeting.ended, meeting.participant_joined/left) komen in Fase 1A
// van de Follow-up Module.
//
// POST /api/zoom-webhook
//
// Zoom URL Validation Request body:
//   { event: "endpoint.url_validation", payload: { plainToken: "..." } }
//
// Required response within 3 seconds:
//   { plainToken: "...", encryptedToken: "<HMAC-SHA256 hex>" }
//
// Echte events worden later geverifieerd via x-zm-signature header.
// Voor nu loggen we ze alleen en geven 200 terug zodat Zoom geen
// retries doet.

import crypto from 'node:crypto';

const SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!SECRET_TOKEN) {
    console.error('[zoom-webhook] ZOOM_WEBHOOK_SECRET_TOKEN env var niet ingesteld');
    return res.status(500).json({ error: 'Webhook secret niet geconfigureerd.' });
  }

  const body = req.body || {};
  const event = body.event;

  // CRC URL validation request van Zoom (eenmalig bij Validate-klik
  // in Marketplace + bij app activatie)
  if (event === 'endpoint.url_validation') {
    const plainToken = body?.payload?.plainToken;
    if (!plainToken || typeof plainToken !== 'string') {
      return res.status(400).json({ error: 'plainToken ontbreekt in payload.' });
    }

    const encryptedToken = crypto
      .createHmac('sha256', SECRET_TOKEN)
      .update(plainToken)
      .digest('hex');

    return res.status(200).json({ plainToken, encryptedToken });
  }

  // Andere events: stub-gedrag — log en accept. Echte handling
  // komt in Fase 1A.
  console.log('[zoom-webhook] event ontvangen (stub):', event);
  return res.status(200).json({ received: true, stub: true });
}
