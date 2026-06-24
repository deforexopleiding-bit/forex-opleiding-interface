// api/inbox-conversation-by-customer.js
//
// GET /api/inbox-conversation-by-customer?customer_id=<uuid>
//
// Resolve customer_id -> most-recent finance-WABA whatsapp_conversation.
// Gebruikt door Finance > Klanten kebab actie 'Open inbox-conversation'
// om vanuit de klantenlijst direct naar de juiste conversation te springen.
//
// Permission: finance.inbox.view (zelfde als de inbox-list endpoint).
//
// Response 200:
//   - found=true:   { found: true, conversation_id: '<uuid>' }
//   - found=false:  { found: false }
//
// Module-scope: we filteren expliciet op de actieve finance-WABA phone_number_id
// (whatsapp_module_config WHERE module='finance' AND is_active=true). Dat
// voorkomt dat we per ongeluk een conversation uit een andere module openen
// (leads/info/partners) — Finance heeft zijn eigen WABA-lijn.
//
// Sorteer-strategie: meest recent (last_message_at DESC). In het zeldzame
// geval dat een klant meerdere conversation-rijen heeft (telefoon-nummer
// gewisseld, etc.) pakken we de actiefste.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  // B1 — additieve OR-chain (finance/events/onboarding).
  const hasFinanceView    = await requirePermission(req, 'finance.inbox.view');
  const hasEventsView     = hasFinanceView ? true : await requirePermission(req, 'events.inbox.view');
  const hasOnboardingView = (hasFinanceView || hasEventsView)
    ? true : await requirePermission(req, 'onboarding.inbox.view');
  if (!hasFinanceView && !hasEventsView && !hasOnboardingView) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view, events.inbox.view of onboarding.inbox.view)' });
  }

  const customerId = String((req.query && req.query.customer_id) || '').trim();
  if (!customerId) {
    return res.status(400).json({ error: 'customer_id verplicht' });
  }
  // Basale UUID-vorm-check; we vertrouwen daarna PostgREST om strict te zijn.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
    return res.status(400).json({ error: 'customer_id moet UUID zijn' });
  }

  try {
    // Module-config: welke phone_number_id hoort bij finance?
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'finance')
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) {
      console.error('[inbox-conversation-by-customer] module-config lookup:', modErr.message);
    }
    const financePnId = modCfg?.phone_number_id || null;
    if (!financePnId) {
      // Geen actieve finance-config — behandel als not-found (UI toont disabled).
      return res.status(200).json({ found: false, reason: 'no_finance_config' });
    }

    const { data, error } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, last_message_at')
      .eq('customer_id', customerId)
      .eq('phone_number_id', financePnId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[inbox-conversation-by-customer] query error:', error.message);
      return res.status(500).json({ error: 'Database fout' });
    }
    if (!data || !data.id) {
      return res.status(200).json({ found: false });
    }
    return res.status(200).json({ found: true, conversation_id: data.id });
  } catch (e) {
    console.error('[inbox-conversation-by-customer] unexpected:', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
