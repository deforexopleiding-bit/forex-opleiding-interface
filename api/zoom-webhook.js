// api/zoom-webhook.js
//
// Zoom Marketplace webhook handler voor Follow-up Module (Fase 1A).
//
// POST /api/zoom-webhook
//
// Twee flows:
// 1. CRC URL validation — Zoom valideert endpoint bij app-activatie
//    Body: { event: "endpoint.url_validation", payload: { plainToken: "..." } }
//    Response: { plainToken, encryptedToken: "<HMAC-SHA256 hex>" }
//
// 2. Meeting events — meeting.started / participant_joined / ended / left
//    Worden geverifieerd via x-zm-signature + gelogd in follow_up_events_log.
//    No-show detectie gebeurt in aparte cron (follow-up-no-show-detect),
//    niet hier — voorkomt race conditions.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

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

  // ── 1. CRC URL validation ─────────────────────────────────────────────────
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

  // ── 2. Signature verificatie voor echte events ────────────────────────────
  const zmSignature  = req.headers['x-zm-signature'];
  const zmTimestamp  = req.headers['x-zm-request-timestamp'];

  if (zmSignature && zmTimestamp) {
    const rawBody = JSON.stringify(body);
    const message  = `v0:${zmTimestamp}:${rawBody}`;
    const expected = 'v0=' + crypto
      .createHmac('sha256', SECRET_TOKEN)
      .update(message)
      .digest('hex');

    if (expected !== zmSignature) {
      console.warn('[zoom-webhook] ongeldige signature voor event:', event);
      return res.status(401).json({ error: 'Ongeldige Zoom webhook signature.' });
    }
  }

  // ── 3. Meeting events — loggen + Supabase update ─────────────────────────
  const payload    = body.payload || {};
  const meetingObj = payload.object || {};
  const meetingId  = String(meetingObj.id || '');

  if (event === 'meeting.started') {
    await logEvent('zoom', event, payload);
    // Optioneel: zoom_meeting_id koppelen aan appointment op basis van meetingId
    if (meetingId) {
      await supabaseAdmin
        .from('follow_up_appointments')
        .update({ zoom_meeting_id: meetingId, updated_at: new Date().toISOString() })
        .eq('zoom_meeting_id', meetingId);
    }
    return res.status(200).json({ received: true });
  }

  if (event === 'meeting.participant_joined') {
    await logEvent('zoom', event, payload);
    return res.status(200).json({ received: true });
  }

  if (event === 'meeting.ended') {
    await logEvent('zoom', event, payload);
    return res.status(200).json({ received: true });
  }

  if (event === 'meeting.participant_left') {
    await logEvent('zoom', event, payload);
    return res.status(200).json({ received: true });
  }

  // Onbekend event — accepteren zodat Zoom geen retries doet
  console.log('[zoom-webhook] onbekend event ontvangen:', event);
  return res.status(200).json({ received: true });
}

async function logEvent(source, eventType, payload) {
  try {
    const { error } = await supabaseAdmin
      .from('follow_up_events_log')
      .insert({
        source:     source,
        event_type: eventType,
        payload:    payload,
        processed:  false,
      });
    if (error) console.error('[zoom-webhook] log insert fout:', error.message);
  } catch (e) {
    console.error('[zoom-webhook] log exception:', e.message);
  }
}
