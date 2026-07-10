// api/wanbetalers-whatsapp-templates-list.js
// GET → goedgekeurde WhatsApp-templates voor de dunning bulk-modal.
//
// Permission: finance.dunning.execute (zelfde als bulk-preview/approve).
//
// Filterstrategie (gespiegeld van events-whatsapp-templates-list.js):
//   1. WABA-resolutie via whatsapp_module_config waar module='finance' (of
//      'dunning') is_active=true → business_account_id.
//   2. Geen finance-WABA → fallback op META_WHATSAPP_BUSINESS_ACCOUNT_ID.
//   3. Geen van beide → alle approved templates.
//
// Status hoofdletter-tolerant ('approved' | 'APPROVED').
//
// Response: { items: [{ name, language, category, body_text,
//                       meta_param_mapping, status, header_type }] }.
// body_text mee voor UI-preview in de dropdown (hint onder de naam).

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
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  try {
    // 1) Finance-WABA business_account_id.
    let businessAccountId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('business_account_id')
        .in('module', ['finance', 'dunning'])
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      if (modErr) {
        console.error('[wanbetalers-whatsapp-templates-list module-config]', modErr.message);
      } else if (modCfg?.business_account_id) {
        businessAccountId = modCfg.business_account_id;
      }
    } catch (e) {
      console.error('[wanbetalers-whatsapp-templates-list module-config-fetch]', e?.message || e);
    }
    if (!businessAccountId) {
      const envBaId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null;
      if (envBaId) businessAccountId = envBaId;
    }

    // 2) Templates ophalen.
    let qb = supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('name, language, category, body_text, meta_param_mapping, status, header_type, business_account_id')
      .order('name', { ascending: true });
    if (businessAccountId) qb = qb.eq('business_account_id', businessAccountId);

    const { data: rows, error } = await qb;
    if (error) throw new Error('templates-list: ' + error.message);

    const items = (rows || [])
      .filter((r) => String(r.status || '').toLowerCase() === 'approved')
      .map((r) => ({
        name              : r.name,
        language          : r.language || null,
        category          : r.category || null,
        body_text         : r.body_text || null,
        meta_param_mapping: r.meta_param_mapping || null,
        status            : r.status,
        header_type       : r.header_type || null,
      }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[wanbetalers-whatsapp-templates-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
