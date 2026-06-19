// api/inbox-unlink-conversation-from-attendee.js
// POST -> zet whatsapp_conversations.attendee_id = NULL voor een conversation.
// Counterpart van api/inbox-link-conversation-to-attendee.js (zelfde RBAC,
// zelfde audit-pattern). Apart endpoint zodat de audit-action duidelijk is
// (parallel met customer-unlink).
//
// Permission: finance.inbox.send OF events.simone.use (zelfde OR-patroon als
// link-endpoint — niemand mag koppelen zonder ook te mogen ontkoppelen).
//
// Body:
//   conversation_id  uuid  required
//
// Response 200:
//   {
//     conversation_id,
//     previous_attendee_id,   // null als al ontkoppeld
//     already_unlinked        // true als er niets te ontkoppelen viel
//   }
//
// Audit-log: action='whatsapp.attendee_unlinked', entity_type='whatsapp_conversation'.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logUnlinkAudit(req, { userId, conversationId, afterJson }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id:     userId || null,
      action:      'whatsapp.attendee_unlinked',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  afterJson || null,
      ip_address:  getClientIp(req),
    });
    if (error) {
      console.error('[inbox-unlink-conversation-from-attendee] audit insert failed:', error.message);
    }
  } catch (e) {
    console.error('[inbox-unlink-conversation-from-attendee] audit exception:', e && e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  const hasFinanceSend = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse   = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  if (!hasFinanceSend && !hasSimoneUse) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send of events.simone.use)' });
  }

  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }

  try {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, attendee_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    const previousAttendeeId = conv.attendee_id || null;
    const alreadyUnlinked = !previousAttendeeId;

    if (!alreadyUnlinked) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ attendee_id: null })
        .eq('id', conv.id);
      if (updErr) throw new Error('conversation update: ' + updErr.message);

      await logUnlinkAudit(req, {
        userId:         user.id,
        conversationId: conv.id,
        afterJson: {
          previous_attendee_id:      previousAttendeeId,
          unlinked_by_user_id:       user.id,
          conversation_phone_number: conv.phone_number || null,
        },
      });
    }

    return res.status(200).json({
      conversation_id:      conv.id,
      previous_attendee_id: previousAttendeeId,
      already_unlinked:     alreadyUnlinked,
    });
  } catch (e) {
    console.error('[inbox-unlink-conversation-from-attendee]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
