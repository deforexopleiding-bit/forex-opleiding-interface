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
    const { error: logErr } = await supabaseAdmin
      .from('follow_up_events_log')
      .insert({
        source: 'zoom',
        event_type: event,
        payload: body,
        processed: false,
      });

    if (logErr) {
      console.error('[zoom-webhook] kon event niet loggen:', logErr.message);
    }

    if (event === 'meeting.started') {
      await tryMapAppointment(body);
    }

    // Status-tracking via Zoom uitgeschakeld op verzoek Jeffrey 2026-05-19
    // Dave doet status-wijzigingen handmatig via Wijzig-knop

    return res.status(200).json({ received: true, logged: !logErr });
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

async function tryMarkInProgress(body) {
  const meetingObject = body?.payload?.object;
  if (!meetingObject) return;

  const zoomMeetingId = String(meetingObject.id || '');
  if (!zoomMeetingId) return;

  const participantEmail = (meetingObject?.participant?.email || '').toLowerCase();
  const daveEmail = (process.env.DAVE_ZOOM_EMAIL || '').toLowerCase();

  // Lege email = telefoon-inbel of gast zonder account → telt als lead-join
  // Geldige email die niet Dave is → ook lead-join
  const isLeadJoin = !participantEmail || participantEmail !== daveEmail;
  if (!isLeadJoin) {
    console.log('[zoom-webhook] host joinde eigen meeting, geen in_progress update');
    return;
  }

  const { data: appt } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, status')
    .eq('zoom_meeting_id', zoomMeetingId)
    .eq('status', 'scheduled')
    .maybeSingle();

  if (!appt) {
    console.log('[zoom-webhook] geen appointment gevonden voor zoom_meeting_id', zoomMeetingId);
    return;
  }

  // Alleen 'scheduled' → 'in_progress'; niet overschrijven als al completed/no_show
  if (appt.status !== 'scheduled') {
    console.log('[zoom-webhook] appointment', appt.id, 'heeft al status', appt.status, '— in_progress skip');
    return;
  }

  const { error: updateErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({ status: 'in_progress' })
    .eq('id', appt.id);

  if (updateErr) {
    console.error('[zoom-webhook] in_progress update mislukt:', updateErr.message);
  } else {
    console.log('[zoom-webhook] in_progress gezet voor appointment', appt.id, 'via lead-join participant_joined');
  }
}

async function tryMapAppointment(body) {
  const meetingObject = body?.payload?.object;
  if (!meetingObject) return;

  const zoomMeetingId = String(meetingObject.id || '');
  const meetingStartTime = meetingObject.start_time;
  const hostEmail = (meetingObject.host_email || '').toLowerCase();
  const joinUrl = meetingObject.join_url || null;

  if (!zoomMeetingId) return;

  // Strategie 1: match via lead-email in participants (komt later via participant_joined event)
  // Strategie 2 (nu actief): match via scheduled_at tijd-proximity ± 15 min
  // Match alleen Dave's appointments (host_email check)
  const daveEmail = (process.env.DAVE_ZOOM_EMAIL || '').toLowerCase();
  if (daveEmail && hostEmail && hostEmail !== daveEmail) {
    console.log('[zoom-webhook] meeting started door niet-Dave host:', hostEmail);
    return;
  }

  if (!meetingStartTime) return;

  const startDate = new Date(meetingStartTime);
  const windowStart = new Date(startDate.getTime() - 15 * 60_000);
  const windowEnd = new Date(startDate.getTime() + 15 * 60_000);

  const { data: candidates } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, scheduled_at, zoom_meeting_id')
    .gte('scheduled_at', windowStart.toISOString())
    .lte('scheduled_at', windowEnd.toISOString())
    .is('zoom_meeting_id', null);

  if (!candidates || candidates.length === 0) {
    console.log('[zoom-webhook] geen unmapped appointment binnen window voor zoom meeting', zoomMeetingId);
    return;
  }

  // Pak de dichtstbijzijnde
  candidates.sort((a, b) => {
    const diffA = Math.abs(new Date(a.scheduled_at).getTime() - startDate.getTime());
    const diffB = Math.abs(new Date(b.scheduled_at).getTime() - startDate.getTime());
    return diffA - diffB;
  });

  const target = candidates[0];

  const updateRow = { zoom_meeting_id: zoomMeetingId };
  if (joinUrl) updateRow.zoom_join_url = joinUrl;

  const { error: updateErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update(updateRow)
    .eq('id', target.id);

  if (updateErr) {
    console.error('[zoom-webhook] kon mapping niet schrijven:', updateErr.message);
  } else {
    console.log('[zoom-webhook] zoom_meeting_id', zoomMeetingId, joinUrl ? '+ join_url' : '', 'gekoppeld aan appointment', target.id);
  }
}
