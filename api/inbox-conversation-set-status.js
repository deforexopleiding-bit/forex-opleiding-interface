// api/inbox-conversation-set-status.js
//
// POST { conversation_id, status: 'open'|'afgehandeld' } → update
// whatsapp_conversations.status. 'afgehandeld' wordt on-wire opgeslagen
// als 'closed' (CHECK-constraint accepteert alleen 'open'|'closed'|
// 'archived', dus geen migratie nodig). Op de weg terug is 'closed'
// equivalent aan "Afgehandeld" in de UI.
//
// Permission: finance.inbox.view (lichte actie — geen berichten sturen).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_UI_STATUSES = ['open', 'afgehandeld'];

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

  // 'afgehandeld' → on-wire 'closed'.
  const dbStatus = uiStatus === 'afgehandeld' ? 'closed' : 'open';

  try {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ status: dbStatus })
      .eq('id', convId)
      .select('id, status')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)  return res.status(404).json({ error: 'Conversation niet gevonden' });
    return res.status(200).json({ ok: true, id: data.id, status: data.status, ui_status: uiStatus });
  } catch (e) {
    console.error('[inbox-conversation-set-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
