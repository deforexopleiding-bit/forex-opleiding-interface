// api/trajecten.js
// CRUD voor trajects (bundels). Variants via api/traject-variants.js.
//   GET            → list trajects + nested variants (+ product-count per variant)
//   POST           → nieuw traject
//   PUT  ?id=uuid  → update traject
//   DELETE ?id=uuid→ archiveren (soft)
// Read: sales.product.view · Write: sales.product.manage

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
      const { data: trajects } = await supabaseAdmin.from('trajects')
        .select('*').is('archived_at', null).order('display_order', { ascending: true });
      const tIds = (trajects || []).map(t => t.id);
      let variantsByTraject = {};
      let countByVariant = {};
      if (tIds.length) {
        const { data: variants } = await supabaseAdmin.from('traject_variants')
          .select('*').in('traject_id', tIds).order('display_order', { ascending: true });
        const vIds = (variants || []).map(v => v.id);
        if (vIds.length) {
          const { data: vps } = await supabaseAdmin.from('traject_variant_products').select('variant_id').in('variant_id', vIds);
          for (const vp of vps || []) countByVariant[vp.variant_id] = (countByVariant[vp.variant_id] || 0) + 1;
        }
        for (const v of variants || []) {
          (variantsByTraject[v.traject_id] ||= []).push({ ...v, product_count: countByVariant[v.id] || 0 });
        }
      }
      const out = (trajects || []).map(t => ({
        ...t,
        variants: variantsByTraject[t.id] || [],
        variant_count: (variantsByTraject[t.id] || []).length,
        active_variant_count: (variantsByTraject[t.id] || []).filter(v => v.is_active).length,
      }));
      return res.status(200).json({ trajects: out });
    }

    if (!(await requirePermission(req, 'sales.product.manage'))) return res.status(403).json({ error: 'Geen rechten (sales.product.manage)' });

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ error: 'Naam vereist' });
      const { data, error } = await supabaseAdmin.from('trajects').insert({
        name: String(b.name).trim(), description: b.description || null,
        display_order: b.display_order ?? 100, is_active: b.is_active !== false,
      }).select('*').single();
      if (error) throw error;
      return res.status(200).json({ traject: data });
    }

    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'id vereist' });
      const b = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (b.name !== undefined) patch.name = String(b.name).trim();
      if (b.description !== undefined) patch.description = b.description || null;
      if (b.display_order !== undefined) patch.display_order = b.display_order;
      if (b.is_active !== undefined) patch.is_active = !!b.is_active;
      const { data, error } = await supabaseAdmin.from('trajects').update(patch).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ traject: data });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id vereist' });
      const { error } = await supabaseAdmin.from('trajects')
        .update({ archived_at: new Date().toISOString(), is_active: false }).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'GET, POST, PUT of DELETE' });
  } catch (e) {
    console.error('[trajecten]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
