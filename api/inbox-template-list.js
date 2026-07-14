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
import { checkOnboardingConvAccess } from './_lib/onboardingScope.js';

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
  // B1 — additieve OR-chain (finance/events/onboarding-send). Template-list
  // wordt gebruikt door alle 3 inbox-UIs voor de "stuur template"-knop.
  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  // Query-param parsing
  const convId = String(req.query?.conversation_id || '').trim();
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist (query ?conversation_id=<uuid>)' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });

  try {
    // 1) Conversation-lookup voor afzendlijn (phone_number_id) als hint.
    // Fase 2b: customer_id meeselecteren voor de onboarding-ACL-hook.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number_id, customer_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) {
      console.error('[inbox-template-list] conv lookup:', convErr.message);
      return res.status(500).json({ error: convErr.message });
    }
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // Fase 2b: mentor-scoping op onboarding-tak. Hook skipt voor seesAll
    // en voor finance/events-convs.
    const acl = await checkOnboardingConvAccess(req, {
      phoneNumberId: conv.phone_number_id,
      customerId:    conv.customer_id,
    });
    if (!acl.ok) return res.status(acl.status).json({ error: acl.error });

    // 2) Bepaal business_account_id.
    //    Prefer: module-config-rij die hoort bij conv.phone_number_id (exacte afzendlijn).
    //    Fallback: actieve finance-module-config (legacy / conv zonder phone_number_id).
    let businessAccountId = null;
    let baSource = 'none';

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
        baSource = 'line';
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
        baSource = 'finance-module';
      }
    }

    if (!businessAccountId) {
      return res.status(503).json({
        error: 'Geen WABA gekoppeld aan deze conversation of finance-module',
      });
    }

    // 3) APPROVED templates ophalen — try-met-filter; als 0 rijen én er wás
    //    een filter, val terug op ALL-approved. Spiegel van #732-fix in
    //    api/wanbetalers-whatsapp-templates-list.js: single-WABA-setups
    //    werken altijd; multi-WABA blijft gescoped zolang de filter matches
    //    geeft. Beschermt tegen config-rij die naar een oude/verkeerde
    //    WABA-id verwijst terwijl de approved templates onder een andere
    //    WABA staan.
    // KOLOMMEN: het echte schema (migratie 2026-06-18-whatsapp-template-
    // folders.sql) heeft `folder_id uuid` op whatsapp_meta_templates dat FK'd
    // naar whatsapp_template_folders(id, name, sort_order). Vroegere versie
    // selecteerde `folder` — die kolom bestaat NIET → productie-fout in de
    // template-picker. Frontend groepeert echter op `folder` (string), dus
    // we mappen folder_id → folder-naam in-memory (één extra query, geen N+1)
    // en geven zowel `folder` (naam-string) als `folder_id` terug.
    const SELECT_COLS = 'id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, approved_at, updated_at, meta_param_mapping, folder_id';
    async function fetchApproved(filterBaId) {
      let q = supabaseAdmin
        .from('whatsapp_meta_templates')
        .select(SELECT_COLS)
        .eq('status', 'APPROVED')
        .order('name', { ascending: true });
      if (filterBaId) q = q.eq('business_account_id', filterBaId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    }

    let items = await fetchApproved(businessAccountId);
    const primaryCount = items.length;
    let fallbackTriggered = false;
    let fallbackCount     = 0;
    if (businessAccountId && items.length === 0) {
      const fallback   = await fetchApproved(null);
      fallbackTriggered = true;
      fallbackCount     = fallback.length;
      items             = fallback;
    }

    // Resolve folder_id → folder-naam. Één extra query (folders-lijst) + in-
    // memory map — geen N+1. Fail-soft: bij fout gaan we door met folder=null
    // voor alles (frontend groepeert die onder "Overig"). Een ontbrekende
    // mapnaam mag NOOIT de template-picker blokkeren.
    const folderIds = [...new Set(items.map((t) => t.folder_id).filter(Boolean))];
    let folderMap = new Map();
    if (folderIds.length) {
      try {
        const { data: folders, error: folderErr } = await supabaseAdmin
          .from('whatsapp_template_folders')
          .select('id, name, sort_order')
          .in('id', folderIds);
        if (folderErr) {
          console.warn('[inbox-template-list] folders-lookup fail-soft:', folderErr.message);
        } else if (Array.isArray(folders)) {
          folderMap = new Map(folders.map((f) => [f.id, f]));
        }
      } catch (e) {
        console.warn('[inbox-template-list] folders-lookup exception fail-soft:', e?.message || e);
      }
    }
    // Verrijk elk template met een `folder` (naam-string of null). Zo hoeft
    // de frontend niet te wijzigen — die groepeert al op tpl.folder.
    items = items.map((t) => {
      const f = t.folder_id ? folderMap.get(t.folder_id) : null;
      return { ...t, folder: f?.name || null };
    });

    console.log('[inbox-template-list]', JSON.stringify({
      conversation_id         : convId,
      business_account_id     : businessAccountId,
      business_account_source : baSource,
      primary_approved        : primaryCount,
      fallback_triggered      : fallbackTriggered,
      fallback_approved       : fallbackCount,
      final_approved          : items.length,
      folders_resolved        : folderMap.size,
    }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[inbox-template-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
