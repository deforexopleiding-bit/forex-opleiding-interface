// api/inbox-conversation-set-status.js
//
// POST { conversation_id, status: 'open'|'afgehandeld'|'gearchiveerd' }
// → update whatsapp_conversations.status.
//
// UI ↔ on-wire mapping:
//   'open'         ↔ 'open'      (actief)
//   'afgehandeld'  ↔ 'closed'    (tijdelijk weg; komt terug bij inbound)
//   'gearchiveerd' ↔ 'archived'  (definitief weg; komt NIET terug bij inbound)
//
// De CHECK-constraint op whatsapp_conversations.status accepteert al
// alle drie de on-wire waarden, dus geen migratie nodig.
//
// Permission: finance.inbox.view (lichte actie — geen berichten sturen).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_UI_STATUSES = ['open', 'afgehandeld', 'gearchiveerd'];
const UI_TO_DB = { open: 'open', afgehandeld: 'closed', gearchiveerd: 'archived' };
const DB_TO_UI = { open: 'open', closed: 'afgehandeld', archived: 'gearchiveerd' };

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
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const convId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : null;
  const uiStatus = typeof body.status === 'string' ? body.status.trim().toLowerCase() : null;
  if (!convId || !UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
  if (!VALID_UI_STATUSES.includes(uiStatus)) {
    return res.status(400).json({ error: `status verwacht ${VALID_UI_STATUSES.join('|')}` });
  }

  const dbStatus = UI_TO_DB[uiStatus];

  try {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ status: dbStatus })
      .eq('id', convId)
      .select('id, status')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)  return res.status(404).json({ error: 'Conversation niet gevonden' });
    return res.status(200).json({
      ok       : true,
      id       : data.id,
      status   : data.status,
      ui_status: DB_TO_UI[data.status] || uiStatus,
    });
  } catch (e) {
    console.error('[inbox-conversation-set-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
