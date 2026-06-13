// api/inbox-conversations-list.js
// GET → lijst whatsapp_conversations met klant-koppeling en 24h-window flag.
//
// Module-scoping (Fase 1 events-inbox): parameter ?module=finance|events.
//   - Default 'finance' (backward-compat: bestaande callers blijven exact
//     hetzelfde gedrag krijgen — query, pnId-lookup en permissie ongewijzigd).
//   - module='events': zelfde query maar gefilterd op de events-phone_number_id
//     uit whatsapp_module_config WHERE module='events' AND is_active=true.
//
// Permission per module (parallelle takken):
//   module='finance' -> finance.inbox.view (zoals voor)
//   module='events'  -> events.inbox.view  (Fase 1 nieuw)
//
// Andere modules worden geweigerd (400) zodat we niet per ongeluk een
// nieuwe agent introduceren zonder permission-key te registreren.
//
// Query params:
//   module  text   'finance' | 'events' (default 'finance')
//   limit   integer (default 50, clamp 1..100)
//   offset  integer (default 0)
//   search  text — filtert phone_number / display_name (ILIKE)
//
// Response: { items: [{ id, phone_number, display_name, customer_id, customer_name,
//                       status, last_message_at, last_message_preview, unread_count,
//                       last_inbound_at, can_send_text }], total, configured, module }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const MODULE_PERMISSIONS = {
  finance: 'finance.inbox.view',
  events : 'events.inbox.view',
};

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

  const q = req.query || {};
  // Module-resolve: default 'finance' voor backward-compat met bestaande
  // finance-callers die geen ?module meegeven.
  const moduleRaw = typeof q.module === 'string' && q.module.trim()
    ? q.module.trim().toLowerCase()
    : 'finance';
  const permKey = MODULE_PERMISSIONS[moduleRaw];
  if (!permKey) {
    return res.status(400).json({
      error: `module='${moduleRaw}' niet ondersteund; verwacht ${Object.keys(MODULE_PERMISSIONS).join('|')}`,
    });
  }
  if (!(await requirePermission(req, permKey))) {
    return res.status(403).json({ error: `Geen rechten (${permKey})` });
  }

  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const search = String(q.search || '').trim();

  try {
    // Module-config: welk phone_number_id hoort bij de gevraagde module?
    // Identiek pattern aan de oude finance-only lookup, alleen .eq('module', ...)
    // is nu parameter ipv hardcoded.
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', moduleRaw)
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) {
      console.error('[inbox-conversations-list] module-config lookup:', modErr.message);
      // Fail-soft: behandel als niet-geconfigureerd i.p.v. 500.
    }
    const modulePnId = modCfg?.phone_number_id || null;
    if (!modulePnId) {
      // Geen actieve config voor deze module — return leeg, UI toont config-banner.
      return res.status(200).json({
        items: [],
        total: 0,
        configured: false,
        module: moduleRaw,
        warning: `Geen actieve ${moduleRaw}-config in whatsapp_module_config — vraag een admin om in te stellen.`,
      });
    }

    let query = supabaseAdmin
      .from('whatsapp_conversations')
      .select(
        'id, phone_number, display_name, customer_id, status, last_message_at, ' +
        'last_message_preview, unread_count, last_inbound_at, ' +
        'customer:customers(id, first_name, last_name, company_name)',
        { count: 'exact' }
      )
      .eq('phone_number_id', modulePnId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (search) {
      const like = '%' + search.replace(/[%_]/g, m => '\\' + m) + '%';
      // PostgREST OR-filter: phone_number / display_name (customer-naam doen we client-side).
      query = query.or(`phone_number.ilike.${like},display_name.ilike.${like}`);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    const now = Date.now();
    const items = (data || []).map(row => {
      const cust = row.customer || null;
      let customerName = null;
      if (cust) {
        const parts = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim();
        customerName = parts || cust.company_name || null;
      }
      let canSendText = false;
      if (row.last_inbound_at) {
        const t = new Date(row.last_inbound_at).getTime();
        if (Number.isFinite(t) && (now - t) <= TWENTY_FOUR_HOURS_MS) canSendText = true;
      }
      return {
        id: row.id,
        phone_number: row.phone_number,
        display_name: row.display_name,
        customer_id: row.customer_id,
        customer_name: customerName,
        status: row.status,
        last_message_at: row.last_message_at,
        last_message_preview: row.last_message_preview,
        unread_count: row.unread_count || 0,
        last_inbound_at: row.last_inbound_at,
        can_send_text: canSendText,
      };
    });

    return res.status(200).json({
      items,
      total: count || items.length,
      configured: true,
      module: moduleRaw,
    });
  } catch (e) {
    console.error('[inbox-conversations-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
