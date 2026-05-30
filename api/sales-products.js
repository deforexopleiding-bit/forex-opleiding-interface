// api/sales-products.js
// GET   /api/sales-products[?active=true]  → lijst (sales.product.view)
// POST  /api/sales-products                 → create (sales.product.manage)
// PUT   /api/sales-products?id=<uuid>       → update (sales.product.manage)
// DELETE /api/sales-products?id=<uuid>      → archive soft delete (sales.product.manage)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const VALID_VAT = [0, 9, 21];

function clean(input = {}) {
  const out = {};
  if (input.name !== undefined)             out.name = String(input.name).trim().slice(0, 200);
  if (input.description !== undefined)      out.description = input.description ? String(input.description) : null;
  if (input.vat_percentage !== undefined)   out.vat_percentage = Number(input.vat_percentage);
  if (input.default_price !== undefined)    out.default_price = input.default_price === null ? null : Number(input.default_price);
  if (input.default_duration_months !== undefined) out.default_duration_months = input.default_duration_months === null ? null : Number(input.default_duration_months);
  if (input.category !== undefined)         out.category = input.category ? String(input.category).trim() : null;
  if (input.tl_product_id !== undefined)    out.tl_product_id = input.tl_product_id ? String(input.tl_product_id).trim() : null;
  if (input.is_active !== undefined)        out.is_active = Boolean(input.is_active);
  return out;
}

function validate(p, partial = false) {
  if (!partial || p.name !== undefined) {
    if (!p.name || p.name.length === 0) return 'Naam is verplicht';
  }
  if (!partial || p.vat_percentage !== undefined) {
    if (!VALID_VAT.includes(p.vat_percentage)) return 'BTW% moet 0, 9 of 21 zijn';
  }
  if (p.default_price !== undefined && p.default_price !== null && p.default_price <= 0) return 'Prijs moet > 0 zijn';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const id = req.query?.id;

  if (req.method === 'GET') {
    if (!(await requirePermission(req, 'sales.product.view'))) {
      return res.status(403).json({ error: 'Geen rechten (sales.product.view)' });
    }
    let q = supabaseAdmin.from('products').select('*').order('updated_at', { ascending: false });
    if (req.query?.active === 'true') q = q.eq('is_active', true).is('archived_at', null);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ products: data || [] });
  }

  if (req.method === 'POST') {
    if (!(await requirePermission(req, 'sales.product.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (sales.product.manage)' });
    }
    const payload = clean(req.body);
    const err = validate(payload, false);
    if (err) return res.status(400).json({ error: err });
    const { data, error } = await supabaseAdmin.from('products').insert(payload).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ product: data });
  }

  if (req.method === 'PUT') {
    if (!id) return res.status(400).json({ error: 'Query-param id vereist' });
    if (!(await requirePermission(req, 'sales.product.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (sales.product.manage)' });
    }
    const payload = clean(req.body);
    const err = validate(payload, true);
    if (err) return res.status(400).json({ error: err });
    payload.updated_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('products').update(payload).eq('id', id).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ product: data });
  }

  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'Query-param id vereist' });
    if (!(await requirePermission(req, 'sales.product.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (sales.product.manage)' });
    }
    // Soft delete: archived_at + is_active=false. Behoud rij voor historische deals.
    const { error } = await supabaseAdmin.from('products')
      .update({ archived_at: new Date().toISOString(), is_active: false })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader('Allow', 'GET, POST, PUT, DELETE');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
