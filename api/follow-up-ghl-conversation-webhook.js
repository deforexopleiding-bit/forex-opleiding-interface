// api/follow-up-ghl-conversation-webhook.js
//
// Webhook endpoint dat GHL aanroept bij elke nieuwe message in een
// Conversation (inbound OF outbound). Authenticatie via custom header.
//
// POST /api/follow-up-ghl-conversation-webhook
//   Header: X-Webhook-Token: <GHL_WEBHOOK_TOKEN>
//   Body: { message: {...}, contact: {...}, ... }
//
// Defensief: GHL payload-structuur kan verschillen per message-type.
// Onbekende velden worden gelogd zonder crash.

import { supabaseAdmin } from './supabase.js';

const GHL_TYPE_TO_CHANNEL = {
  TYPE_WHATSAPP: 'whatsapp',
  TYPE_SMS: 'sms',
  TYPE_EMAIL: 'email',
  TYPE_CALL: null,
  WhatsApp: 'whatsapp',
  SMS: 'sms',
  Email: 'email',
};

function detectChannel(message) {
  const type = message?.messageType || message?.type || '';
  if (GHL_TYPE_TO_CHANNEL[type] !== undefined) return GHL_TYPE_TO_CHANNEL[type];
  const lower = String(type).toLowerCase();
  if (lower.includes('whatsapp')) return 'whatsapp';
  if (lower.includes('sms')) return 'sms';
  if (lower.includes('email')) return 'email';
  return null;
}

function detectDirection(message) {
  const dir = String(message?.direction || '').toLowerCase();
  if (dir === 'inbound' || dir === 'outbound') return dir;
  const type = String(message?.type || '').toLowerCase();
  if (type.includes('inbound')) return 'inbound';
  if (type.includes('outbound')) return 'outbound';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const expectedToken = process.env.GHL_WEBHOOK_TOKEN;
  if (!expectedToken) {
    console.error('[ghl-conversation-webhook] GHL_WEBHOOK_TOKEN niet geconfigureerd');
    return res.status(500).json({ error: 'Webhook token niet geconfigureerd.' });
  }

  const receivedToken = req.headers['x-webhook-token'];
  if (!receivedToken || receivedToken !== expectedToken) {
    console.warn('[ghl-conversation-webhook] invalid token');
    return res.status(401).json({ error: 'Ongeldige webhook token.' });
  }

  const body = req.body || {};

  // Log altijd het event voor audit + debug
  await supabaseAdmin
    .from('follow_up_events_log')
    .insert({
      source: 'ghl',
      event_type: body?.type || 'conversation_message',
      payload: body,
      processed: false,
    })
    .then(() => {})
    .catch(err => console.error('[ghl-conversation-webhook] events_log insert failed:', err.message));

  // GHL stuurt verschillende event-types — message kan als wrapper of direct payload komen
  const message = body.message || body;

  if (!message || typeof message !== 'object') {
    return res.status(200).json({ received: true, processed: false, reason: 'no-message' });
  }

  const ghlMessageId = message.id || message.messageId;
  if (!ghlMessageId) {
    console.warn('[ghl-conversation-webhook] geen message id in payload:', JSON.stringify(body).slice(0, 300));
    return res.status(200).json({ received: true, processed: false, reason: 'no-message-id' });
  }

  const channel = detectChannel(message);
  if (!channel) {
    console.log('[ghl-conversation-webhook] niet-tracked channel:', message.type || message.messageType);
    return res.status(200).json({ received: true, processed: false, reason: 'non-tracked-channel' });
  }

  const direction = detectDirection(message);
  if (!direction) {
    console.warn('[ghl-conversation-webhook] geen direction:', JSON.stringify(message).slice(0, 200));
    return res.status(200).json({ received: true, processed: false, reason: 'no-direction' });
  }

  const conversationId = message.conversationId || body.conversationId;
  const contactId = message.contactId || body.contactId || body?.contact?.id;
  const sentAt = message.dateAdded || message.dateCreated || message.createdAt || new Date().toISOString();

  if (!conversationId || !contactId) {
    console.warn('[ghl-conversation-webhook] missing conversationId or contactId');
    return res.status(200).json({ received: true, processed: false, reason: 'missing-ids' });
  }

  // Koppel aan meest recente appointment van deze contact
  let appointmentId = null;
  const { data: appts } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, scheduled_at')
    .eq('lead_ghl_contact_id', contactId)
    .order('scheduled_at', { ascending: false })
    .limit(1);

  if (appts && appts.length > 0) {
    appointmentId = appts[0].id;
  }

  const row = {
    ghl_message_id: ghlMessageId,
    ghl_conversation_id: conversationId,
    lead_ghl_contact_id: contactId,
    appointment_id: appointmentId,
    direction,
    channel,
    body: message.body || message.text || null,
    template_id: message.templateId || null,
    template_variables: message.templateVariables || null,
    sent_at: sentAt,
    source: 'webhook',
  };

  const { error: upsertErr } = await supabaseAdmin
    .from('follow_up_messages')
    .upsert(row, { onConflict: 'ghl_message_id', ignoreDuplicates: true });

  if (upsertErr) {
    console.error('[ghl-conversation-webhook] upsert error:', upsertErr.message);
    return res.status(500).json({ error: upsertErr.message });
  }

  return res.status(200).json({
    received: true,
    processed: true,
    direction,
    channel,
    appointment_id: appointmentId,
  });
}
