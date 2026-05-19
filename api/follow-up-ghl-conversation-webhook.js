// api/follow-up-ghl-conversation-webhook.js
//
// Webhook endpoint dat GHL aanroept bij elke nieuwe message in een
// Conversation (inbound OF outbound). Authenticatie via custom header.
//
// POST /api/follow-up-ghl-conversation-webhook
//   Header: X-Webhook-Token: <GHL_WEBHOOK_TOKEN>
//   Body: flat GHL Custom Data format ÓÓÓK nested { message, contact } format
//
// Defensief: GHL payload-structuur kan verschillen per message-type.
// Onbekende velden worden gelogd zonder crash.

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';

function normalizePayload(body) {
  if (!body || typeof body !== 'object') {
    return { message: null, contact: null, type: null };
  }

  // SHAPE 1: Origineel test-format met message als object met id
  if (body.message && typeof body.message === 'object' && body.message.id) {
    return {
      message: body.message,
      contact: body.contact || null,
      type: body.type || null,
    };
  }

  // SHAPE 2: Echte GHL standard-data — root-level contact + nested message zonder message.id of conversationId
  if (body.message && typeof body.message === 'object') {
    const contactId = body.contact_id || body.contactId || body?.contact?.id || null;
    const bodyText = body.message.body || body.message.text || '';

    // Detecteer direction expliciet — 'inbound' als default was fout voor outbound berichten
    let direction = body.message.direction;
    if (!direction) {
      // Heuristiek: userId aanwezig (= door user/Dave verzonden) zonder contactId = outbound
      if (body.message?.userId && !body.message?.contactId) {
        direction = 'outbound';
      } else {
        direction = 'inbound';
        console.warn('[ghl-webhook] SHAPE2 direction onbekend, fallback inbound. userId:', body.message?.userId, 'contactId:', body.message?.contactId);
      }
    }

    // Synthetic message id voor dedup: hash van contact + body + minute-bucket
    // Minute-bucket voorkomt dat retries binnen 1 minuut nieuwe records maken
    const minuteBucket = Math.floor(Date.now() / 60000);
    const hashSource = `${contactId || 'unknown'}|${bodyText.slice(0, 200)}|${direction}|${minuteBucket}`;
    const syntheticId = 'ghl-synth-' + crypto.createHash('sha256').update(hashSource).digest('hex').slice(0, 24);

    return {
      message: {
        id: syntheticId,
        body: bodyText,
        type: body.message.type || null,
        messageType: body.message.type || null,
        direction,
        status: body.message.status || null,
        dateAdded: new Date().toISOString(),
        conversationId: null,
        contactId,
      },
      contact: {
        id: contactId,
        firstName: body.first_name || body.firstName || body?.contact?.firstName || null,
        lastName: body.last_name || body.lastName || body?.contact?.lastName || null,
        email: body.email || body?.contact?.email || null,
        phone: body.phone || body?.contact?.phone || null,
      },
      type: body.type || null,
    };
  }

  // SHAPE 3: Flat keys fallback (legacy)
  return {
    message: {
      id: body.message_id || body.messageId || body.id || null,
      body: body.message_body || body.messageBody || body.body || body.text || null,
      type: body.channel || body.messageType || body.message_type || null,
      messageType: body.channel || body.messageType || body.message_type || null,
      direction: body.direction || (body.type === 'OutboundMessage' ? 'outbound' : 'inbound'),
      dateAdded: body.message_date || body.dateAdded || body.date_added || null,
      conversationId: body.conversation_id || body.conversationId || null,
      contactId: body.contact_id || body.contactId || null,
    },
    contact: {
      id: body.contact_id || body.contactId || null,
      firstName: body.contact_first_name || body.first_name || null,
      lastName: body.contact_last_name || body.last_name || null,
    },
    type: body.type || null,
  };
}

const GHL_TYPE_TO_CHANNEL = {
  TYPE_WHATSAPP: 'whatsapp',
  TYPE_SMS: 'sms',
  TYPE_EMAIL: 'email',
  TYPE_CALL: null,
  WhatsApp: 'whatsapp',
  'WhatsApp Business': 'whatsapp',
  SMS: 'sms',
  Email: 'email',
  EMAIL: 'email',
  IVR: null,
  'Facebook Messenger': null,
  'Instagram DM': null,
  'GMB Messaging': null,
};

// GHL Workflow Webhook stuurt message.type als INTEGER enum (anders dan
// Marketplace API InboundMessage payload die strings gebruikt). Mapping
// op basis van praktijk-observatie. Bij onbekende integers: log warning
// in detectChannel zodat we mapping kunnen uitbreiden.
const MESSAGE_TYPE_ID_TO_CHANNEL = {
  1: 'sms',
  2: 'email',
  3: 'webchat',
  4: 'gmb_messaging',     // Google My Business
  5: null,                // Phone Call — niet getrackt
  6: null,                // Voicemail — niet getrackt
  7: 'facebook_messenger',
  8: 'instagram_dm',
  9: 'gmb_messaging',
  10: null,               // SMS Review — niet getrackt
  11: null,               // Email Review — niet getrackt
  12: 'activity',         // Generic activity
  13: null,               // Custom — onzeker
  14: null,
  15: null,
  16: null,
  17: null,
  18: null,
  19: 'whatsapp',         // ← bevestigd via testbericht 16 mei 2026
  20: null,
  21: null,
  22: null,
};

function detectChannel(message) {
  const type = message?.messageType ?? message?.type;
  if (type === null || type === undefined) return null;

  // INTEGER pad: GHL Workflow Webhook stuurt enum-IDs
  if (typeof type === 'number' || /^\d+$/.test(String(type))) {
    const numericType = Number(type);
    if (MESSAGE_TYPE_ID_TO_CHANNEL[numericType] !== undefined) {
      return MESSAGE_TYPE_ID_TO_CHANNEL[numericType];
    }
    console.warn('[ghl-conversation-webhook] onbekende numeric message-type:', numericType, 'overweeg toevoegen aan MESSAGE_TYPE_ID_TO_CHANNEL');
    return null;
  }

  // STRING pad: Marketplace API style + alternatieven
  if (GHL_TYPE_TO_CHANNEL[type] !== undefined) {
    return GHL_TYPE_TO_CHANNEL[type];
  }
  const lower = String(type).toLowerCase();
  if (lower.includes('whatsapp')) return 'whatsapp';
  if (lower.includes('sms')) return 'sms';
  if (lower.includes('email')) return 'email';

  console.warn('[ghl-conversation-webhook] onbekend string message-type:', type);
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

  // Normaliseer flat én nested GHL payload naar één interne shape
  const normalized = normalizePayload(body);
  const message = normalized.message;
  const contact = normalized.contact;

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

  const conversationId = message?.conversationId || normalized.message?.conversationId || null;
  const contactId = message?.contactId || contact?.id || null;
  const sentAt = message.dateAdded || message.dateCreated || message.createdAt || new Date().toISOString();

  if (!contactId) {
    console.warn('[ghl-conversation-webhook] missing contactId');
    return res.status(200).json({ received: true, processed: false, reason: 'missing-contact-id' });
  }

  // conversationId is optioneel — GHL standard-data heeft het niet altijd
  if (!conversationId) {
    console.log('[ghl-conversation-webhook] geen conversationId — gebruik contactId als virtual convo');
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
    ghl_conversation_id: conversationId || `virtual-${contactId}`,
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
