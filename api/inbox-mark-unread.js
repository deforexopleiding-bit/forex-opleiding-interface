// api/inbox-mark-unread.js
// POST → zet unread_count op een conversation terug > 0 zodat de gebruiker
// het gesprek later opnieuw als 'te lezen' terugkrijgt (indicator in de
// gesprekkenlijst + 'Ongelezen'-filter).
//
// Bewust GÉÉN Meta-call: WhatsApp heeft geen 'markAsUnread' — de blauwe
// vinkjes bij de klant blijven staan. Dit is puur een lokale UX-vlag.
//
// Permission: finance.inbox.view (spiegelt inbox-mark-read; lezen-rechten
// volstaan) — additieve OR-chain voor events/onboarding zoals de zuster-
// endpoint.
//
// Body:
//   conversation_id  uuid required
//
// Response: 200 { success: true, conversation_id, unread_count }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { checkOnboardingConvAccess } from './_lib/onboardingScope.js';

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
  // Additieve OR-chain (identiek aan inbox-mark-read).
  const hasFinanceView    = await requirePermission(req, 'finance.inbox.view');
  const hasEventsView     = hasFinanceView ? true : await requirePermission(req, 'events.inbox.view');
  const hasOnboardingView = (hasFinanceView || hasEventsView)
    ? true : await requirePermission(req, 'onboarding.inbox.view');
  if (!hasFinanceView && !hasEventsView && !hasOnboardingView) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view, events.inbox.view of onboarding.inbox.view)' });
  }

  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });

  try {
    // Conversation bestaat-check + ACL-context (phone_number_id + customer_id
    // voor de onboarding-scope-hook, spiegel mark-read).
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, unread_count, phone_number_id, customer_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    const acl = await checkOnboardingConvAccess(req, {
      phoneNumberId: conv.phone_number_id,
      customerId:    conv.customer_id,
    });
    if (!acl.ok) return res.status(acl.status).json({ error: acl.error });

    // Zet unread_count op max(1, huidige). Als 'ie al > 0 was, laat 'em staan
    // (voorkomt overschrijven bij dubbele klik).
    const cur = Number(conv.unread_count || 0);
    const next = Math.max(1, cur);
    if (next !== cur) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ unread_count: next })
        .eq('id', convId);
      if (updErr) throw new Error('unread set: ' + updErr.message);
    }

    return res.status(200).json({ success: true, conversation_id: convId, unread_count: next });
  } catch (e) {
    console.error('[inbox-mark-unread]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
