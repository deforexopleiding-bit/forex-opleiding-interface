// api/inbox-messages-list.js
// GET → lijst whatsapp_messages voor een conversation, oudste → nieuwste.
// Permission: finance.inbox.view OF events.inbox.view (additief; events-hub
// gebruikt deze endpoint sinds stap 6a/6b zonder finance-rechten te hebben).
//
// Query params:
//   conversation_id  uuid (required)
//   limit            integer (default 50, clamp 1..200)
//   offset           integer (default 0)
//   mark_as_read     'true' | '1' → reset unread_count op de conversation
//
// Response: { conversation: { id, phone_number, display_name, customer_id,
//                             customer_name, status, last_message_at, last_inbound_at,
//                             unread_count, can_send_text },
//             items: [{ id, direction, body, media_url, media_type, template_name,
//                       status, sent_at, delivered_at, read_at, failed_reason,
//                       meta_wamid, created_at }],
//             total }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  // FIX 3 — additief: events.inbox.view ook accepteren. Finance-callers met
  // finance.inbox.view blijven byte-identiek werken (short-circuit).
  const hasFinanceView = await requirePermission(req, 'finance.inbox.view');
  const hasEventsView  = hasFinanceView ? true : await requirePermission(req, 'events.inbox.view');
  if (!hasFinanceView && !hasEventsView) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view of events.inbox.view)' });
  }

  const q = req.query || {};
  const convId = String(q.conversation_id || '').trim();
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });

  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const markRead = q.mark_as_read === 'true' || q.mark_as_read === '1';

  try {
    // Parent conversation eerst, zodat we 404 kunnen geven als 'ie niet bestaat.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select(
        'id, phone_number, display_name, customer_id, status, last_message_at, ' +
        'last_inbound_at, unread_count, ' +
        'customer:customers(id, first_name, last_name, company_name)'
      )
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // Messages — oudste eerst voor chronologische chat-weergave
    const { data: msgs, error: msgErr, count } = await supabaseAdmin
      .from('whatsapp_messages')
      .select(
        'id, direction, body, media_url, media_type, template_name, status, ' +
        'sent_at, delivered_at, read_at, failed_reason, meta_wamid, created_at',
        { count: 'exact' }
      )
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);
    if (msgErr) throw new Error('messages: ' + msgErr.message);

    // Optioneel: unread-counter resetten
    if (markRead && (conv.unread_count || 0) > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ unread_count: 0 })
        .eq('id', convId);
      if (updErr) console.error('[inbox-messages-list] mark_as_read update failed:', updErr.message);
      else conv.unread_count = 0;
    }

    // Customer-name + can_send_text computed velden
    const cust = conv.customer || null;
    let customerName = null;
    if (cust) {
      const parts = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim();
      customerName = parts || cust.company_name || null;
    }
    let canSendText = false;
    if (conv.last_inbound_at) {
      const t = new Date(conv.last_inbound_at).getTime();
      if (Number.isFinite(t) && (Date.now() - t) <= TWENTY_FOUR_HOURS_MS) canSendText = true;
    }

    return res.status(200).json({
      conversation: {
        id: conv.id,
        phone_number: conv.phone_number,
        display_name: conv.display_name,
        customer_id: conv.customer_id,
        customer_name: customerName,
        status: conv.status,
        last_message_at: conv.last_message_at,
        last_inbound_at: conv.last_inbound_at,
        unread_count: conv.unread_count || 0,
        can_send_text: canSendText,
      },
      items: msgs || [],
      total: count || (msgs ? msgs.length : 0),
    });
  } catch (e) {
    console.error('[inbox-messages-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
