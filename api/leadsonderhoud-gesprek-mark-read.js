// api/leadsonderhoud-gesprek-mark-read.js
//
// POST — Zet whatsapp_conversations.unread_count op 0 (gelezen) of >0
// (ongelezen). Aparte endpoint voor Leadsonderhoud-context omdat de
// bestaande api/inbox-mark-read + inbox-mark-unread finance.inbox.view /
// events.inbox.view / onboarding.inbox.view als RBAC-scope hebben; de
// leadsonderhoud-flow gebruikt leads.view (spiegel van
// leadsonderhoud-gesprek-berichten).
//
// Body:
//   conversation_id  uuid required
//   unread           boolean optional (default false) — true = markeer ongelezen (unread_count=1)
//
// Response: 200 { ok, conversation_id, unread_count }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  if (!UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id (uuid) is verplicht.' });
  }
  const wantUnread = body.unread === true;
  const newCount = wantUnread ? 1 : 0;

  // Bestaans-check + veilige update.
  const { data: existing, error: sel } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, unread_count')
    .eq('id', convId)
    .maybeSingle();
  if (sel) {
    console.error('[leadsonderhoud-gesprek-mark-read] lookup:', sel.message);
    return res.status(500).json({ error: sel.message });
  }
  if (!existing) return res.status(404).json({ error: 'Conversation niet gevonden.' });

  const { error: upd } = await supabaseAdmin
    .from('whatsapp_conversations')
    .update({ unread_count: newCount })
    .eq('id', convId);
  if (upd) {
    console.error('[leadsonderhoud-gesprek-mark-read] update:', upd.message);
    return res.status(500).json({ error: upd.message });
  }

  return res.status(200).json({
    ok: true,
    conversation_id: convId,
    unread_count: newCount,
  });
}
