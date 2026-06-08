// api/inbox-conversations-list.js
// GET → lijst whatsapp_conversations met klant-koppeling en 24h-window flag.
// Permission: finance.inbox.view
//
// Query params:
//   limit   integer (default 50, clamp 1..100)
//   offset  integer (default 0)
//   search  text — filtert phone_number / display_name / customer-naam (ILIKE)
//
// Response: { items: [{ id, phone_number, display_name, customer_id, customer_name,
//                       status, last_message_at, last_message_preview, unread_count,
//                       last_inbound_at, can_send_text }], total }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

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
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  const q = req.query || {};
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const search = String(q.search || '').trim();

  try {
    let query = supabaseAdmin
      .from('whatsapp_conversations')
      .select(
        'id, phone_number, display_name, customer_id, status, last_message_at, ' +
        'last_message_preview, unread_count, last_inbound_at, ' +
        'customer:customers(id, first_name, last_name, company_name)',
        { count: 'exact' }
      )
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

    return res.status(200).json({ items, total: count || items.length });
  } catch (e) {
    console.error('[inbox-conversations-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
