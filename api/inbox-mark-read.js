// api/inbox-mark-read.js
// POST → reset unread_count op een conversation en (optioneel) seint blauwe
// vinkjes naar de klant via Meta's markAsRead voor het laatste inbound bericht.
// Permission: finance.inbox.view  (lezen-rechten volstaan; geen outbound send)
//
// Body:
//   conversation_id  uuid required
//
// Response: 200 { success: true, conversation_id, meta_read_sent: boolean,
//                 meta_warning?: string }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { markAsRead, getConfigStatus, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

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
  // B1 — additieve OR-chain (parallel met inbox-messages-list/context).
  // Finance-callers short-circuiten op de eerste check (byte-identieke
  // performance); events- en onboarding-inbox krijgen óók read-toegang.
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
    // Conversation bestaat-check
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, unread_count')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // Lokale reset (altijd doen, ook als Meta niet beschikbaar)
    if ((conv.unread_count || 0) > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ unread_count: 0 })
        .eq('id', convId);
      if (updErr) throw new Error('unread reset: ' + updErr.message);
    }

    // Probeer Meta markAsRead op het laatste inbound bericht (UX-nicety, optioneel)
    let metaReadSent = false;
    let metaWarning = null;

    const cfg = getConfigStatus();
    if (!cfg.configured) {
      metaWarning = 'Meta WhatsApp niet geconfigureerd — alleen lokale reset (missing: ' + cfg.missing.join(', ') + ')';
      console.warn('[inbox-mark-read]', metaWarning);
    } else {
      // Zoek meest recente inbound msg met meta_wamid
      const { data: lastIn, error: lastErr } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('id, meta_wamid')
        .eq('conversation_id', convId)
        .eq('direction', 'in')
        .not('meta_wamid', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastErr) {
        metaWarning = 'Kon laatste inbound bericht niet ophalen: ' + lastErr.message;
        console.warn('[inbox-mark-read]', metaWarning);
      } else if (lastIn && lastIn.meta_wamid) {
        try {
          await markAsRead({ wamid: lastIn.meta_wamid });
          metaReadSent = true;
        } catch (metaErr) {
          if (metaErr instanceof MetaNotConfiguredError) {
            metaWarning = 'Meta WhatsApp niet geconfigureerd (missing: ' + metaErr.missing.join(', ') + ')';
          } else {
            metaWarning = 'Meta markAsRead fout: ' + metaErr.message;
          }
          console.warn('[inbox-mark-read]', metaWarning);
        }
      }
    }

    const response = { success: true, conversation_id: convId, meta_read_sent: metaReadSent };
    if (metaWarning) response.meta_warning = metaWarning;
    return res.status(200).json(response);
  } catch (e) {
    console.error('[inbox-mark-read]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
