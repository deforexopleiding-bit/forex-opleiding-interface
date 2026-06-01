// api/traject-variants.js
// Varianten van een traject + hun producten.
//   GET    ?variant_id=uuid → variant + products[]
//   POST   { traject_id, name, ..., products:[{product_id,quantity}] }
//   PUT    ?id=uuid { ..., products?:[...] }  (products vervangt volledig)
//   DELETE ?id=uuid → cascade
// Read: sales.product.view · Write: sales.product.manage

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

async function replaceProducts(variantId, products) {
  await supabaseAdmin.from('traject_variant_products').delete().eq('variant_id', variantId);
  const rows = (products || []).map((p, i) => ({
    variant_id: variantId, product_id: p.product_id, quantity: Number(p.quantity) || 1, sort_order: i,
  })).filter(r => r.product_id);
  if (rows.length) {
    const { error } = await supabaseAdmin.from('traject_variant_products').insert(rows);
    if (error) throw error;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const id = req.query?.id;

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'sales.product.view'))) return res.status(403).json({ error: 'Geen rechten' });
      const vid = req.query?.variant_id;
      if (!vid) return res.status(400).json({ error: 'variant_id vereist' });
      const { data: variant } = await supabaseAdmin.from('traject_variants').select('*').eq('id', vid).maybeSingle();
      const { data: products } = await supabaseAdmin.from('traject_variant_products')
        .select('id, product_id, quantity, sort_order').eq('variant_id', vid).order('sort_order', { ascending: true });
      return res.status(200).json({ variant, products: products || [] });
    }

    if (!(await requirePermission(req, 'sales.product.manage'))) return res.status(403).json({ error: 'Geen rechten (sales.product.manage)' });

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.traject_id || !b.name) return res.status(400).json({ error: 'traject_id en name vereist' });
      const { data: variant, error } = await supabaseAdmin.from('traject_variants').insert({
        traject_id: b.traject_id, name: String(b.name).trim(), description: b.description || null,
        default_duration_months: b.default_duration_months || null,
        display_order: b.display_order ?? 100, is_default: !!b.is_default, is_active: b.is_active !== false,
      }).select('*').single();
      if (error) throw error;
      await replaceProducts(variant.id, b.products);
      return res.status(200).json({ variant });
    }

    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'id vereist' });
      const b = req.body || {};
      const patch = {};
      if (b.name !== undefined) patch.name = String(b.name).trim();
      if (b.description !== undefined) patch.description = b.description || null;
      if (b.default_duration_months !== undefined) patch.default_duration_months = b.default_duration_months || null;
      if (b.display_order !== undefined) patch.display_order = b.display_order;
      if (b.is_default !== undefined) patch.is_default = !!b.is_default;
      if (b.is_active !== undefined) patch.is_active = !!b.is_active;
      if (Object.keys(patch).length) {
        const { error } = await supabaseAdmin.from('traject_variants').update(patch).eq('id', id);
        if (error) throw error;
      }
      if (Array.isArray(b.products)) await replaceProducts(id, b.products);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id vereist' });
      const { error } = await supabaseAdmin.from('traject_variants').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'GET, POST, PUT of DELETE' });
  } catch (e) {
    console.error('[traject-variants]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
