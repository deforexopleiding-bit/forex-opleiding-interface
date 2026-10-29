// api/inbox-mark-unread.js
// POST → zet een gesprek terug op ongelezen zodat de gebruiker het later
// opnieuw als 'te lezen' terugkrijgt (indicator in de gesprekkenlijst +
// 'Ongelezen'-filter). Het laatste inkomende bericht gaat terug op ongelezen:
// een mail (email_messages.is_read=false) als die het laatst binnenkwam, anders
// WA (unread_count ≥ 1). Badge daarna minstens 1. Zie _lib/gesprek-leesstand.js.
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
//   module           'finance'|'onboarding'|'events' optional — zonder module
//                    de mailboxen van de modules op het nummer van het gesprek.
//
// Response: 200 { success: true, conversation_id, unread_count,
//                 kanaal: 'email'|'wa', email_id }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { checkOnboardingConvAccess } from './_lib/onboardingScope.js';
import { mailboxLabel } from './_lib/module-mailbox.js';
import { markeerGesprekOngelezen, mailboxenVoorGesprek } from './_lib/gesprek-leesstand.js';

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
  const moduleRaw = String(body.module || '').trim().toLowerCase();
  if (moduleRaw && !mailboxLabel(moduleRaw)) return res.status(400).json({ error: 'onbekende module: ' + moduleRaw });

  try {
    // Conversation bestaat-check + ACL-context (phone_number_id + customer_id
    // voor de onboarding-scope-hook, spiegel mark-read).
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, unread_count, phone_number_id, customer_id, last_inbound_at')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    const acl = await checkOnboardingConvAccess(req, {
      phoneNumberId: conv.phone_number_id,
      customerId:    conv.customer_id,
    });
    if (!acl.ok) return res.status(acl.status).json({ error: acl.error });

    // Laatste inkomende bericht (WA of mail) terug op ongelezen. Bij WA:
    // unread_count = max(1, huidige) — dubbele klik overschrijft niets.
    const r = await markeerGesprekOngelezen(supabaseAdmin, {
      conv, mailboxLabel: await mailboxenVoorGesprek(supabaseAdmin, { conv, module: moduleRaw }),
    });

    return res.status(200).json({
      success: true, conversation_id: convId,
      unread_count: r.unread_count, kanaal: r.kanaal, email_id: r.email_id,
    });
  } catch (e) {
    console.error('[inbox-mark-unread]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
