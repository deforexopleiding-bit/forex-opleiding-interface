// api/sales-customer-duplicate-check.js
// POST { email?, phone? } → { matches: [...], count }
// Doorzoekt customers tabel op email (case-insensitive) + phone.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.customer.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.customer.create)' });
  }

  const { email, phone } = req.body || {};
  if (!email && !phone) return res.status(400).json({ error: 'Email of telefoon vereist' });

  const filters = [];
  if (email) filters.push(`email.ilike.${String(email).trim()}`);
  if (phone) filters.push(`phone.eq.${String(phone).trim()}`);

  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email, phone, created_at, archived_at')
      .or(filters.join(','))
      .is('archived_at', null)
      .limit(20);
    if (error) throw error;

    // Per match: count deals + laatste deal-info.
    const ids = (data || []).map(c => c.id);
    let dealsByCustomer = {};
    if (ids.length) {
      const { data: deals } = await supabaseAdmin
        .from('deals').select('customer_id, status, created_at')
        .in('customer_id', ids)
        .order('created_at', { ascending: false });
      for (const d of deals || []) {
        (dealsByCustomer[d.customer_id] ||= []).push(d);
      }
    }

    const matches = (data || []).map(c => {
      const deals = dealsByCustomer[c.id] || [];
      return {
        id: c.id,
        name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email: c.email,
        phone: c.phone,
        deals_count: deals.length,
        last_deal_at: deals[0]?.created_at || null,
        last_deal_status: deals[0]?.status || null,
      };
    });

    return res.status(200).json({ matches, count: matches.length });
  } catch (err) {
    console.error('[duplicate-check]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
