// api/zoom-webhook.js
//
// Zoom Marketplace webhook handler voor Follow-up Module.
//
// Verwerkt:
//   1. endpoint.url_validation (CRC handshake bij Zoom Validate)
//   2. meeting.started / .ended / .participant_joined / .participant_left
//      → log naar follow_up_events_log voor audit + latere processing
//
// Security: HMAC-SHA256 signature verification met ZOOM_WEBHOOK_SECRET_TOKEN.
// Headers verwacht: x-zm-signature (formaat: v0=<hex>), x-zm-request-timestamp.
//
// BELANGRIJK: signature wordt berekend over de RAW request body bytes,
// niet over het JSON.parse-resultaat. Daarom bodyParser uitgeschakeld
// en readRawBody helper gebruikt.
//
// Status updates op appointments worden NIET hier gedaan — dat doet
// een aparte cron (follow-up-no-show-detect, komt in commit 2) op basis
// van events in follow_up_events_log. Voorkomt race conditions.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

export const config = {
  api: { bodyParser: false },
};

const SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const SIGNATURE_TOLERANCE_SECONDS = 300;

const TRACKED_EVENTS = new Set([
  'meeting.started',
  'meeting.ended',
  'meeting.participant_joined',
  'meeting.participant_left',
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!SECRET_TOKEN) {
    console.error('[zoom-webhook] ZOOM_WEBHOOK_SECRET_TOKEN env var ontbreekt');
    return res.status(500).json({ error: 'Webhook secret niet geconfigureerd.' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[zoom-webhook] kon body niet lezen:', err.message);
    return res.status(400).json({ error: 'Body lezen mislukt.' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Body is geen geldige JSON.' });
  }

  const event = body?.event;

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

  const signatureHeader = req.headers['x-zm-signature'];
  const timestampHeader = req.headers['x-zm-request-timestamp'];

  if (!signatureHeader || !timestampHeader) {
    console.warn('[zoom-webhook] missing signature headers');
    return res.status(401).json({ error: 'Signature headers ontbreken.' });
  }

  const timestampNum = Number(timestampHeader);
  if (!Number.isFinite(timestampNum)) {
    return res.status(401).json({ error: 'Ongeldige timestamp.' });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampNum) > SIGNATURE_TOLERANCE_SECONDS) {
    console.warn('[zoom-webhook] timestamp buiten tolerantie:', timestampNum);
    return res.status(401).json({ error: 'Timestamp buiten tolerantie.' });
  }

  const message = `v0:${timestampHeader}:${rawBody}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', SECRET_TOKEN)
    .update(message)
    .digest('hex');

  const signatureBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expectedSignature);

  if (
    signatureBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    console.warn('[zoom-webhook] signature mismatch');
    return res.status(401).json({ error: 'Signature ongeldig.' });
  }

  if (TRACKED_EVENTS.has(event)) {
    const { error } = await supabaseAdmin
      .from('follow_up_events_log')
      .insert({
        source: 'zoom',
        event_type: event,
        payload: body,
        processed: false,
      });

    if (error) {
      console.error('[zoom-webhook] kon event niet loggen:', error.message);
    }
    return res.status(200).json({ received: true, logged: !error });
  }

  console.log('[zoom-webhook] niet-getrackt event:', event);
  return res.status(200).json({ received: true, tracked: false });
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
