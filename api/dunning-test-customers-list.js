// GET /api/dunning-test-customers-list
//
// Read-only lijst van alle is_test-customers voor de cockpit-picker (fix 2)
// en de "+ Nieuwe test-klant" telling. Super_admin-only. Retourneert
// minimale metadata + invoice_count per klant zodat de picker meteen
// zinvolle info kan tonen.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const { data: customers, error } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, phone, email, created_at')
    .eq('is_test', true)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });

  const ids = (customers || []).map(c => c.id);
  const invoiceCountById = new Map();
  if (ids.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from('invoices').select('id, customer_id')
      .eq('is_test', true).in('customer_id', ids);
    for (const r of rows || []) {
      invoiceCountById.set(r.customer_id, (invoiceCountById.get(r.customer_id) || 0) + 1);
    }
  }

  const list = (customers || []).map(c => ({
    id:             c.id,
    name:           ((c.first_name || '').replace(/^🧪 TEST — /, '') + ' ' + (c.last_name || '')).trim() || '(naamloos)',
    phone:          c.phone || null,
    email:          c.email || null,
    invoice_count:  invoiceCountById.get(c.id) || 0,
    created_at:     c.created_at,
  }));

  return res.status(200).json({ ok: true, total: list.length, customers: list });
}
