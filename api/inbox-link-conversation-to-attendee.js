// api/inbox-link-conversation-to-attendee.js
// POST -> handmatig een whatsapp_conversation koppelen aan een event_attendee.
// Spiegelt 1:1 het bestaande inbox-link-conversation-to-customer.js patroon
// (RBAC, audit, edge-cases). Use-case: een attendee uit Webflow stuurt een
// WhatsApp; de conversation belandt los in de inbox; operator koppelt
// 'm handmatig zodat templates met attendee-context automatisch werken.
//
// Permission: finance.inbox.send OF events.simone.use (zelfde OR-patroon).
//
// Body:
//   conversation_id  uuid  required
//   attendee_id      uuid  required
//
// Response 200:
//   {
//     conversation_id, attendee_id,
//     attendee_name, attendee_event_title, attendee_event_starts_at,
//     previous_attendee_id, relinked (bool)
//   }
//
// Edge cases:
//   - Conversation al aan dezelfde attendee gekoppeld: 200, geen update, audit-skip.
//   - Conversation aan andere attendee gekoppeld: re-link (previous_attendee_id
//     in audit). UI moet dat eerder bevestigen.
//   - Attendee of conversation niet gevonden: 404.
//
// Audit-log: action='whatsapp.attendee_linked', entity_type='whatsapp_conversation',
// entity_id=conv.id. Fail-soft: audit-fout breekt de business-actie niet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logLinkAudit(req, { userId, conversationId, afterJson }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id:     userId || null,
      action:      'whatsapp.attendee_linked',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  afterJson || null,
      ip_address:  getClientIp(req),
    });
    if (error) {
      console.error('[inbox-link-conversation-to-attendee] audit insert failed:', error.message);
    }
  } catch (e) {
    console.error('[inbox-link-conversation-to-attendee] audit exception:', e && e.message);
  }
}

function attendeeDisplayName(att) {
  if (!att) return null;
  const parts = [att.first_name, att.last_name].filter(Boolean).join(' ').trim();
  return parts || att.email || att.phone || null;
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
  const convId     = String(body.conversation_id || '').trim();
  const attendeeId = String(body.attendee_id     || '').trim();
  if (!convId)     return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId))     return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  if (!attendeeId) return res.status(400).json({ error: 'attendee_id vereist' });
  if (!UUID_RE.test(attendeeId)) return res.status(400).json({ error: 'attendee_id moet geldige uuid zijn' });

  try {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, attendee_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    const { data: att, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, first_name, last_name, email, phone, event_id, events:event_id ( id, title, starts_at )')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee lookup: ' + attErr.message);
    if (!att) return res.status(404).json({ error: 'Aanmelding niet gevonden' });

    const previousAttendeeId  = conv.attendee_id || null;
    const alreadyLinkedToSame = previousAttendeeId && previousAttendeeId === att.id;
    const isRelink            = previousAttendeeId && previousAttendeeId !== att.id;

    if (!alreadyLinkedToSame) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ attendee_id: att.id })
        .eq('id', conv.id);
      if (updErr) throw new Error('conversation update: ' + updErr.message);
    }

    if (!alreadyLinkedToSame) {
      await logLinkAudit(req, {
        userId:         user.id,
        conversationId: conv.id,
        afterJson: {
          attendee_id:                att.id,
          previous_attendee_id:       previousAttendeeId,
          match_reason:               'manual',
          linked_by_user_id:          user.id,
          relinked:                   !!isRelink,
          conversation_phone_number:  conv.phone_number || null,
          event_id:                   att.event_id || null,
        },
      });
    }

    const attendeeName    = attendeeDisplayName(att);
    const eventTitle      = att.events?.title || null;
    const eventStartsAt   = att.events?.starts_at || null;
    return res.status(200).json({
      conversation_id:          conv.id,
      attendee_id:              att.id,
      attendee_name:            attendeeName,
      attendee_event_title:     eventTitle,
      attendee_event_starts_at: eventStartsAt,
      previous_attendee_id:     previousAttendeeId,
      relinked:                 !!isRelink,
    });
  } catch (e) {
    console.error('[inbox-link-conversation-to-attendee]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
