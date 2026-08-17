// api/leadsonderhoud-gesprek-templates.js
// GET → lijst APPROVED whatsapp_meta_templates voor de leadsonderhoud-lijn.
//
// v=6 FIX 5 DEEL C — de template-picker in de Gesprekken-tab moet echte
// Meta-approved templates kunnen kiezen om te versturen (WA buiten 24u-venster
// of ook binnen venster als alternatief voor vrije tekst).
//
// Recon-uitkomst: whatsapp_meta_templates heeft GEEN module_scope kolom.
// Filter loopt via business_account_id uit whatsapp_module_config waar
// module='leadsonderhoud'. Zelfde patroon als inbox-template-list.js met
// finance-fallback naar all-approved bij lege primary-set (single-WABA
// setups).
//
// Alleen lezen. Gate: leads.view.
//
// Response 200:
//   { items: [{ id, name, language, category, body_text, body_examples,
//               header_type, header_content, footer_text, buttons, status,
//               meta_param_mapping }],
//     configured (bool), business_account_id (string|null) }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn } from './_lib/leadsonderhoud-gesprekken.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const lijn = await haalLijn();
    // haalLijn levert de leadsonderhoud-WA-lijn (module in whatsapp_module_config).
    // Business-account-id via een aparte lookup op module_config.
    let businessAccountId = null;
    if (lijn && lijn.module) {
      const { data: cfg } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('business_account_id')
        .eq('module', lijn.module)
        .eq('is_active', true)
        .maybeSingle();
      businessAccountId = cfg?.business_account_id || null;
    }

    const SELECT_COLS = 'id, name, language, category, body_text, body_examples, header_type, header_content, footer_text, buttons, status, meta_param_mapping';
    async function fetchApproved(baId) {
      let q = supabaseAdmin
        .from('whatsapp_meta_templates')
        .select(SELECT_COLS)
        .eq('status', 'APPROVED')
        .order('name', { ascending: true });
      if (baId) q = q.eq('business_account_id', baId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    }

    let items = await fetchApproved(businessAccountId);
    if (businessAccountId && items.length === 0) {
      // Single-WABA fallback (spiegel inbox-template-list.js): bij lege primary
      // set → all-approved, zodat een verkeerd geconfigureerde business_account_id
      // de picker niet blokkeert.
      items = await fetchApproved(null);
    }

    return res.status(200).json({
      items,
      configured: !!businessAccountId,
      business_account_id: businessAccountId,
    });
  } catch (e) {
    console.error('[ls-gesprek-templates] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Templates laden mislukt' });
  }
}
