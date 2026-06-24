// api/inbox-unlink-conversation-from-customer.js
// POST -> zet whatsapp_conversations.customer_id = NULL voor een conversation.
// Counterpart van api/inbox-link-conversation-to-customer.js (zelfde RBAC,
// zelfde audit-pattern). Apart endpoint i.p.v. action-vlag op link-endpoint
// omdat het body-contract daar customer_id als hard required heeft; een
// conditionele validatie zou de strakke shape verzwakken en audit-payload
// vertakken. Dedicated endpoint = eigen action 'whatsapp.customer_unlinked'
// in het audit-log voor een duidelijker history.
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
//     previous_customer_id,   // null als al ontkoppeld
//     already_unlinked        // true als er niets te ontkoppelen viel
//   }
//
// Edge cases:
//   - Conversation al zonder customer_id: 200, geen update, audit-skip.
//   - Conversation niet gevonden: 404.
//
// Audit-log: action='whatsapp.customer_unlinked', entity_type='whatsapp_conversation',
// entity_id=conv.id, after_json met previous_customer_id + unlinked_by_user_id.
// Fail-soft: audit-fout breekt de business-actie niet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logUnlinkAudit(req, { userId, conversationId, afterJson }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id:     userId || null,
      action:      'whatsapp.customer_unlinked',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  afterJson || null,
      ip_address:  getClientIp(req),
    });
    if (error) {
      console.error('[inbox-unlink-conversation-from-customer] audit insert failed:', error.message);
    }
  } catch (e) {
    console.error('[inbox-unlink-conversation-from-customer] audit exception:', e && e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth: identieke gate als link-endpoint.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  // B1 — onboarding.inbox.send als 3e additieve OR.
  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
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
      .select('id, phone_number, customer_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    const previousCustomerId = conv.customer_id || null;
    const alreadyUnlinked = !previousCustomerId;

    if (!alreadyUnlinked) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ customer_id: null })
        .eq('id', conv.id);
      if (updErr) throw new Error('conversation update: ' + updErr.message);

      // Audit alleen bij echte mutatie (parallel met link-endpoint patroon).
      await logUnlinkAudit(req, {
        userId:         user.id,
        conversationId: conv.id,
        afterJson: {
          previous_customer_id:      previousCustomerId,
          unlinked_by_user_id:       user.id,
          conversation_phone_number: conv.phone_number || null,
        },
      });
    }

    return res.status(200).json({
      conversation_id:      conv.id,
      previous_customer_id: previousCustomerId,
      already_unlinked:     alreadyUnlinked,
    });
  } catch (e) {
    console.error('[inbox-unlink-conversation-from-customer]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
