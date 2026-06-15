// api/events-whatsapp-templates-list.js
// GET -> goedgekeurde WhatsApp-templates voor de events-automations-editor.
//
// Permission: events.event.view.
//
// Filterstrategie:
//   1. WABA-resolutie via whatsapp_module_config (module='events', is_active=true) →
//      business_account_id (zelfde pad als api/_lib/events-send.js). Indien gevonden:
//      filter op die business_account_id zodat de editor alleen templates ziet die
//      ook daadwerkelijk verzonden kunnen worden vanuit de events-WABA.
//   2. Geen events-WABA gekoppeld → fallback op env-var
//      META_WHATSAPP_BUSINESS_ACCOUNT_ID.
//   3. Geen van beide → alle approved templates teruggeven (om de editor niet
//      stuk te laten gaan in een nieuwe omgeving zonder config).
//
// Status: hoofdletter-tolerant (templates kunnen 'approved' of 'APPROVED' zijn —
// zelfde tolerantie als events-send.js regel 111).
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
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  try {
    // 1) Resolve events-WABA business_account_id.
    let businessAccountId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('business_account_id')
        .eq('module', 'events')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[events-whatsapp-templates-list module-config]', modErr.message);
      } else if (modCfg?.business_account_id) {
        businessAccountId = modCfg.business_account_id;
      }
    } catch (e) {
      console.error('[events-whatsapp-templates-list module-config-fetch]', e?.message || e);
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

    // Status case-insensitive filter (Meta retourneert APPROVED uppercase,
    // legacy rows kunnen lowercase 'approved' zijn).
    const items = (rows || [])
      .filter((r) => {
        const st = String(r.status || '').toLowerCase();
        return st === 'approved';
      })
      .map((r) => ({
        name        : r.name,
        language    : r.language || null,
        header_type : r.header_type || null,
      }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[events-whatsapp-templates-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
