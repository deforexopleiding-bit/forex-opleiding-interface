// api/follow-up-send-whatsapp.js
//
// POST endpoint voor outbound WhatsApp via GHL Conversations API.
// Body: { appointment_id, message_text? | template_name?, template_variables? }
//
// Schrijft outbound row naar follow_up_messages met echte GHL messageId.
// RLS-aware via createUserClient — owner_id-check gebeurt impliciet bij
// appointment-lookup.

import { createUserClient, supabaseAdmin } from './supabase.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

const TEMPLATE_WHITELIST = {
  afspraak_maken_romy: { category: 'utility', variables: ['first_name'] },
  opvolging_afspraak_maken: { category: 'marketing', variables: ['first_name'] },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'GHL env vars niet geconfigureerd.' });
  }

  const { appointment_id, message_text, template_name, template_variables } = req.body || {};

  if (!appointment_id || typeof appointment_id !== 'string') {
    return res.status(400).json({ error: 'appointment_id ontbreekt of ongeldig.' });
  }

  if (!message_text && !template_name) {
    return res.status(400).json({ error: 'Geef message_text OF template_name op.' });
  }

  if (message_text && template_name) {
    return res.status(400).json({ error: 'Geef niet beide message_text EN template_name.' });
  }

  if (template_name && !TEMPLATE_WHITELIST[template_name]) {
    return res.status(400).json({
      error: `Onbekend template: ${template_name}. Toegestaan: ${Object.keys(TEMPLATE_WHITELIST).join(', ')}`,
    });
  }

  // RLS-aware: gebruik user-client zodat alleen eigen leads gevonden worden
  const { data: appt, error: apptErr } = await supabase
    .from('follow_up_appointments')
    .select('id, lead_name, lead_ghl_contact_id, lead_first_name')
    .eq('id', appointment_id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: 'Appointment niet gevonden of geen toegang.' });
  }

  if (!appt.lead_ghl_contact_id) {
    return res.status(400).json({ error: 'Appointment heeft geen GHL contact_id — kan niet versturen.' });
  }

  // Build GHL request body
  const ghlBody = {
    type: 'WhatsApp',
    contactId: appt.lead_ghl_contact_id,
  };

  let displayBody = '';

  if (template_name) {
    ghlBody.templateId = template_name;
    const firstName = appt.lead_first_name || (appt.lead_name?.split(' ')[0]) || 'daar';
    ghlBody.templateVariables = { 1: firstName };
    displayBody = `[template: ${template_name}] firstName=${firstName}`;
  } else {
    ghlBody.message = message_text;
    displayBody = message_text;
  }

  let ghlResponse;
  try {
    const ghlRes = await fetch(`${GHL_API_BASE}/conversations/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: '2021-04-15',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(ghlBody),
    });

    if (!ghlRes.ok) {
      const errText = await ghlRes.text();
      console.error('[send-whatsapp] GHL error:', ghlRes.status, 'body:', errText.slice(0, 500));
      return res.status(ghlRes.status === 401 ? 502 : ghlRes.status).json({
        error: `GHL API fout ${ghlRes.status}`,
        details: errText.slice(0, 200),
      });
    }

    ghlResponse = await ghlRes.json();
  } catch (err) {
    console.error('[send-whatsapp] exception:', err.message);
    return res.status(500).json({ error: `Network fout: ${err.message}` });
  }

  const ghlMessageId = ghlResponse.messageId || ghlResponse.id || null;
  const ghlConversationId = ghlResponse.conversationId || `virtual-${appt.lead_ghl_contact_id}`;

  if (!ghlMessageId) {
    console.warn('[send-whatsapp] GHL gaf geen messageId:', JSON.stringify(ghlResponse).slice(0, 200));
  }

  const messageRow = {
    ghl_message_id: ghlMessageId || `sent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ghl_conversation_id: ghlConversationId,
    lead_ghl_contact_id: appt.lead_ghl_contact_id,
    appointment_id: appointment_id,
    direction: 'outbound',
    channel: 'whatsapp',
    body: displayBody,
    template_id: template_name || null,
    template_variables: template_name ? ghlBody.templateVariables : null,
    sent_at: new Date().toISOString(),
    source: template_name ? 'manual_template' : 'manual_freeform',
  };

  const { error: insertErr } = await supabaseAdmin
    .from('follow_up_messages')
    .upsert(messageRow, { onConflict: 'ghl_message_id', ignoreDuplicates: false });

  if (insertErr) {
    console.error('[send-whatsapp] follow_up_messages insert error:', insertErr.message);
    // GHL is al verstuurd, dus geef wel success terug maar log de DB-fout
    return res.status(200).json({
      sent: true,
      ghl_message_id: ghlMessageId,
      ghl_conversation_id: ghlConversationId,
      warning: `Bericht verstuurd maar DB-write faalde: ${insertErr.message}`,
    });
  }

  return res.status(200).json({
    sent: true,
    ghl_message_id: ghlMessageId,
    ghl_conversation_id: ghlConversationId,
    channel: 'whatsapp',
    direction: 'outbound',
  });
}
