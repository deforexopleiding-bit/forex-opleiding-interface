// api/teamleader-webhook.js
// Anonieme receiver voor TL-webhook-events. Geen auth (TL stuurt anoniem),
// wel signature-verificatie (placeholder, zie _lib/teamleader-webhook-verify).
//
// TL kent GEEN quotation.* events → realtime "offerte getekend" loopt via
// deal.won (de offerte hangt onder een TL-deal die bij acceptatie naar 'won'
// verspringt). deal.moved wordt alleen gelogd (pipeline-stappen variëren).
//
// Geeft ALTIJD 200 terug na ontvangst, anders krijgt TL een retry-storm.

import { supabaseAdmin } from './supabase.js';
import { verifyWebhookSignature } from './_lib/teamleader-webhook-verify.js';

// Ruwe body nodig voor HMAC → bodyParser uit.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let raw = '';
  let payload = {};
  let sig = { valid: false };
  let eventType = null;
  let objectType = null;
  let objectId = null;
  let processedAt = null;
  let errorText = null;

  try {
    raw = await readRawBody(req);
    sig = verifyWebhookSignature(raw, req.headers || {});
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }

    eventType  = payload.type || payload.event || null;
    objectType = payload.subject?.type || payload.data?.type || null;
    objectId   = payload.subject?.id || payload.data?.id || payload.id || null;

    if (sig.valid) {
      if (eventType === 'deal.won' && objectId) {
        const now = new Date().toISOString();
        const { error } = await supabaseAdmin.from('deals').update({
          tl_quotation_status:     'accepted',
          tl_quotation_accepted_at: now,
          tl_quotation_signed_at:   now,
        }).eq('tl_deal_id', objectId);
        if (error) errorText = 'DB-update mislukt: ' + error.message;
        else processedAt = now;
      } else if (eventType === 'deal.moved') {
        // Alleen loggen — pipeline-stappen zijn geen betrouwbaar getekend-signaal.
        processedAt = new Date().toISOString();
      } else {
        // Ander event: enkel loggen.
        processedAt = new Date().toISOString();
      }
    } else {
      errorText = 'signature ongeldig: ' + (sig.reason || 'onbekend');
      console.error('[tl-webhook]', errorText);
    }
  } catch (e) {
    errorText = e.message;
    console.error('[tl-webhook] exception:', e.message);
  }

  // Altijd loggen (best-effort).
  try {
    await supabaseAdmin.from('teamleader_webhook_events').insert({
      event_type:      eventType,
      tl_object_type:  objectType,
      tl_object_id:    objectId,
      payload_json:    payload,
      signature_valid: !!sig.valid,
      processed_at:    processedAt,
      error:           errorText,
    });
  } catch (e) {
    console.error('[tl-webhook] log-insert mislukt:', e.message);
  }

  // Altijd 200 (voorkom TL retry-storm).
  return res.status(200).json({ received: true });
}
