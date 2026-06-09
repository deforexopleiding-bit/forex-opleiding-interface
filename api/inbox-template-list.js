// api/inbox-template-list.js
// GET → lijst APPROVED whatsapp_meta_templates voor de afzendlijn van een
// conversation (finance-scoped inbox template-picker — C3).
//
// Permission: finance.inbox.send (zelfde als inbox-send.js — wie een template
// mag versturen, mag ook de picker-lijst zien).
//
// Query:
//   conversation_id  uuid  required — gebruikt voor lookup van afzendlijn
//                                     (conv.phone_number_id → module-config
//                                      → business_account_id)
//
// Response:
//   200 { items: [{ id, meta_template_id, name, language, category,
//                   header_type, header_content, body_text, body_examples,
//                   footer_text, buttons, status, approved_at, updated_at,
//                   meta_param_mapping }] }
//
// C4: meta_param_mapping wordt meegegeven zodat de picker in modules/finance.html
//     kan detecteren of een template named-style variabelen heeft en de auto-
//     resolve-flow kan activeren i.p.v. de handmatige invul-form.
//   400 { error } — ontbrekende/ongeldige conversation_id
//   401 { error: 'Niet geauthenticeerd' }
//   403 { error: 'Geen rechten (finance.inbox.send)' }
//   404 { error: 'Conversation niet gevonden' }
//   503 { error: '...' } — geen module-config / geen WABA-koppeling
//
// NB: alleen status=APPROVED — LOCAL/SUBMITTED/REJECTED/PAUSED/DISABLED
// worden uitgefilterd zodat een sender alleen geldige templates kan kiezen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.send'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send)' });
  }

  // Query-param parsing
  const convId = String(req.query?.conversation_id || '').trim();
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist (query ?conversation_id=<uuid>)' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });

  try {
    // 1) Conversation-lookup voor afzendlijn (phone_number_id) als hint.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) {
      console.error('[inbox-template-list] conv lookup:', convErr.message);
      return res.status(500).json({ error: convErr.message });
    }
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // 2) Bepaal business_account_id.
    //    Prefer: module-config-rij die hoort bij conv.phone_number_id (exacte afzendlijn).
    //    Fallback: actieve finance-module-config (legacy / conv zonder phone_number_id).
    let businessAccountId = null;

    if (conv.phone_number_id) {
      const { data: lineCfg, error: lineErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('business_account_id')
        .eq('phone_number_id', conv.phone_number_id)
        .eq('is_active', true)
        .maybeSingle();
      if (lineErr) {
        console.error('[inbox-template-list] line module-config lookup:', lineErr.message);
      } else if (lineCfg?.business_account_id) {
        businessAccountId = lineCfg.business_account_id;
      }
    }

    if (!businessAccountId) {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('business_account_id')
        .eq('module', 'finance')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[inbox-template-list] finance module-config lookup:', modErr.message);
      } else if (modCfg?.business_account_id) {
        businessAccountId = modCfg.business_account_id;
      }
    }

    if (!businessAccountId) {
      return res.status(503).json({
        error: 'Geen WABA gekoppeld aan deze conversation of finance-module',
      });
    }

    // 3) APPROVED templates ophalen.
    const { data, error } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, approved_at, updated_at, meta_param_mapping')
      .eq('business_account_id', businessAccountId)
      .eq('status', 'APPROVED')
      .order('name', { ascending: true });

    if (error) {
      console.error('[inbox-template-list] select:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[inbox-template-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
