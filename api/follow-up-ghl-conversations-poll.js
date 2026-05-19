// api/follow-up-ghl-conversations-poll.js
//
// Cron-endpoint: elke 15 min haalt messages op voor actieve leads
// (appointment afgelopen 30 dagen OF komende 7 dagen). Veiligheidsnet
// voor missed webhooks.
//
// Schedule: */15 * * * *
// Auth: CRON_SECRET via Authorization header

import { supabaseAdmin, checkCronAuth } from './supabase.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const ABORT_MS = 55_000;

const GHL_TYPE_TO_CHANNEL = {
  TYPE_WHATSAPP: 'whatsapp',
  TYPE_SMS: 'sms',
  TYPE_EMAIL: 'email',
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
  // Heuristiek: userId zonder contactId = outbound (door user/Dave verzonden)
  if (message?.userId && !message?.contactId) return 'outbound';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'GHL env vars niet geconfigureerd.' });
  }

  const startTime = Date.now();
  const stats = { active_leads: 0, conversations_fetched: 0, messages_upserted: 0, errors: 0, skipped: 0 };

  try {
    const now = new Date();
    const past = new Date(now);
    past.setDate(past.getDate() - 30);
    const future = new Date(now);
    future.setDate(future.getDate() + 7);

    const { data: activeAppts, error: apptsErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('lead_ghl_contact_id, id')
      .gte('scheduled_at', past.toISOString())
      .lte('scheduled_at', future.toISOString())
      .not('lead_ghl_contact_id', 'is', null);

    if (apptsErr) {
      console.error('[conversations-poll] active appts query error:', apptsErr.message);
      return res.status(500).json({ error: apptsErr.message });
    }

    // Unieke contact-IDs — meest recente appointment per contact
    const contactToAppointment = new Map();
    for (const a of activeAppts || []) {
      if (!contactToAppointment.has(a.lead_ghl_contact_id)) {
        contactToAppointment.set(a.lead_ghl_contact_id, a.id);
      }
    }

    stats.active_leads = contactToAppointment.size;

    for (const [contactId, appointmentId] of contactToAppointment) {
      if (Date.now() - startTime > ABORT_MS) {
        stats.skipped++;
        continue;
      }

      try {
        const searchUrl = new URL(`${GHL_API_BASE}/conversations/search`);
        searchUrl.searchParams.set('locationId', process.env.GHL_LOCATION_ID);
        searchUrl.searchParams.set('contactId', contactId);
        searchUrl.searchParams.set('limit', '5');

        const convoRes = await fetch(searchUrl.toString(), {
          headers: {
            Authorization: `Bearer ${process.env.GHL_API_KEY}`,
            Version: '2021-04-15',
            Accept: 'application/json',
          },
        });

        if (!convoRes.ok) {
          const errText = await convoRes.text();
          console.error('[conversations-poll] conversations search error:', convoRes.status, 'contact:', contactId, 'body:', errText.slice(0, 200));
          stats.errors++;
          continue;
        }

        const convoData = await convoRes.json();
        const conversations = convoData.conversations || convoData.data || [];
        stats.conversations_fetched += conversations.length;

        for (const convo of conversations) {
          const conversationId = convo.id;
          if (!conversationId) continue;

          const msgUrl = `${GHL_API_BASE}/conversations/${conversationId}/messages?limit=100`;

          const msgRes = await fetch(msgUrl, {
            headers: {
              Authorization: `Bearer ${process.env.GHL_API_KEY}`,
              Version: '2021-04-15',
              Accept: 'application/json',
            },
          });

          if (!msgRes.ok) {
            const errText = await msgRes.text();
            console.error('[conversations-poll] messages fetch error:', msgRes.status, 'convo:', conversationId, 'body:', errText.slice(0, 200));
            stats.errors++;
            continue;
          }

          const msgData = await msgRes.json();
          const messages = msgData.messages?.messages || msgData.messages || msgData.data || [];

          for (const msg of messages) {
            const ghlMessageId = msg.id || msg.messageId;
            if (!ghlMessageId) continue;

            const channel = detectChannel(msg);
            if (!channel) continue;

            const direction = detectDirection(msg);
            if (!direction) continue;

            const row = {
              ghl_message_id: ghlMessageId,
              ghl_conversation_id: conversationId,
              lead_ghl_contact_id: contactId,
              appointment_id: appointmentId,
              direction,
              channel,
              body: msg.body || msg.text || null,
              template_id: msg.templateId || null,
              template_variables: msg.templateVariables || null,
              sent_at: msg.dateAdded || msg.dateCreated || msg.createdAt || new Date().toISOString(),
              source: 'poll',
            };

            const { error: upErr } = await supabaseAdmin
              .from('follow_up_messages')
              .upsert(row, { onConflict: 'ghl_message_id', ignoreDuplicates: true });

            if (!upErr) {
              stats.messages_upserted++;
            } else {
              stats.errors++;
            }
          }
        }
      } catch (innerErr) {
        console.error('[conversations-poll] contact loop exception:', contactId, innerErr.message);
        stats.errors++;
      }
    }

    console.log('[conversations-poll] done:', JSON.stringify(stats), 'duration:', Date.now() - startTime);
    return res.status(200).json({ ...stats, duration_ms: Date.now() - startTime });
  } catch (err) {
    console.error('[conversations-poll] exception:', err.message);
    return res.status(500).json({ error: err.message, ...stats });
  }
}
