// api/onboarding-whatsapp-templates-list.js
//
// GET -> goedgekeurde WhatsApp-templates voor de onboarding-automations-editor.
// Port van events-whatsapp-templates-list.js: zelfde filterstrategie maar
// resolve op whatsapp_module_config WHERE module='onboarding'.
//
// Permission: onboarding.automation.view.
//
// Filterstrategie:
//   1. WABA-resolutie via whatsapp_module_config (module='onboarding', is_active=true)
//      → business_account_id. Indien gevonden: filter op die business_account_id.
//   2. Geen onboarding-WABA gekoppeld → fallback op env-var
//      META_WHATSAPP_BUSINESS_ACCOUNT_ID.
//   3. Geen van beide → alle approved templates teruggeven (editor blijft werken
//      in nieuwe omgeving zonder config).
//
// Status: hoofdletter-tolerant (approved / APPROVED).
//
// Response: { items: [{ name, language, header_type }] }, gesorteerd op name asc.

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
  if (!(await requirePermission(req, 'onboarding.automation.view'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.automation.view)' });
  }

  try {
    // 1) Resolve onboarding-WABA business_account_id.
    let businessAccountId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('business_account_id')
        .eq('module', 'onboarding')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[onboarding-whatsapp-templates-list module-config]', modErr.message);
      } else if (modCfg?.business_account_id) {
        businessAccountId = modCfg.business_account_id;
      }
    } catch (e) {
      console.error('[onboarding-whatsapp-templates-list module-config-fetch]', e?.message || e);
    }
    if (!businessAccountId) {
      const envBaId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null;
      if (envBaId) businessAccountId = envBaId;
    }

    // 2) Templates ophalen.
    let qb = supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('name, language, header_type, status, business_account_id')
      .order('name', { ascending: true });

    if (businessAccountId) {
      qb = qb.eq('business_account_id', businessAccountId);
    }

    const { data: rows, error } = await qb;
    if (error) throw new Error('templates-list: ' + error.message);

    const items = (rows || [])
      .filter((r) => String(r.status || '').toLowerCase() === 'approved')
      .map((r) => ({
        name:        r.name,
        language:    r.language || null,
        header_type: r.header_type || null,
      }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[onboarding-whatsapp-templates-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
