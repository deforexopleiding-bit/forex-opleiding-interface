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
    // 1) Finance-WABA business_account_id resolven (config → env-var).
    let businessAccountId = null;
    let baSource = 'none';
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
        baSource = 'config';
      }
    } catch (e) {
      console.error('[wanbetalers-whatsapp-templates-list module-config-fetch]', e?.message || e);
    }
    if (!businessAccountId) {
      const envBaId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null;
      if (envBaId) { businessAccountId = envBaId; baSource = 'env'; }
    }

    // Helpers: fetch + approved-filter. rows is altijd een array.
    const SELECT_COLS = 'name, language, category, body_text, meta_param_mapping, status, header_type, business_account_id';
    async function fetchTemplates(filterBaId) {
      let qb = supabaseAdmin
        .from('whatsapp_meta_templates')
        .select(SELECT_COLS)
        .order('name', { ascending: true });
      if (filterBaId) qb = qb.eq('business_account_id', filterBaId);
      const { data, error } = await qb;
      if (error) throw new Error('templates-list: ' + error.message);
      return Array.isArray(data) ? data : [];
    }
    const filterApproved = (rows) =>
      rows.filter((r) => String(r.status || '').toLowerCase() === 'approved');

    // 2) Templates ophalen — eerst mét de resolved WABA-filter (als aanwezig).
    let rawRows = await fetchTemplates(businessAccountId);
    let approvedRows = filterApproved(rawRows);
    const primaryCount    = rawRows.length;
    const primaryApproved = approvedRows.length;

    // 3) Fallback: als de WABA-filter 0 approved templates opleverde MAAR er
    //    was wel een filter actief, probeer opnieuw ZONDER filter. Beschermt
    //    tegen single-WABA-setups waar de config-/env-WABA een andere id heeft
    //    dan wat Meta actief gebruikt (config-rij verwijst naar verkeerde
    //    WABA, env-var wijst naar oude WABA, config leeg maar env legacy).
    //    Multi-WABA-setups waarin de filter WEL matches gaf blijven scoped
    //    (fallback vuurt niet als approved > 0).
    let fallbackTriggered = false;
    let fallbackCount     = 0;
    let fallbackApproved  = 0;
    if (businessAccountId && approvedRows.length === 0) {
      const fallbackRows          = await fetchTemplates(null);
      const fallbackApprovedRows  = filterApproved(fallbackRows);
      fallbackTriggered = true;
      fallbackCount     = fallbackRows.length;
      fallbackApproved  = fallbackApprovedRows.length;
      approvedRows      = fallbackApprovedRows;
    }

    // Diagnose-logging: alles wat je nodig hebt om te zien waarom een
    // dropdown leeg of gevuld is (WABA-source, counts, fallback-status).
    console.log('[wanbetalers-whatsapp-templates-list]', JSON.stringify({
      business_account_id     : businessAccountId,
      business_account_source : baSource,
      primary_rows            : primaryCount,
      primary_approved        : primaryApproved,
      fallback_triggered      : fallbackTriggered,
      fallback_rows           : fallbackCount,
      fallback_approved       : fallbackApproved,
      final_approved          : approvedRows.length,
    }));

    const items = approvedRows.map((r) => ({
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
