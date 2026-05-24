// api/kb-tags.js
// Tag-beheer voor kennisbank_items (CRUD op kb_tags — migratie 004).
//   GET  ?action=list        → alle tags (alfabetisch)
//   POST                     → nieuwe tag {name, color?, description?}
//   PATCH ?id=<uuid>         → tag bijwerken {name?, color?, description?}
//   DELETE ?id=<uuid>        → tag verwijderen (cascade → kb_item_tags)
//
// Auth: verifyAdmin (hard). Schrijven achter requirePermissionFailOpen (soft) +
// supabaseAdmin (service role, RLS op kb_tags = super_admin only).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // GET ?action=list — alle tags
    if (req.method === 'GET' && req.query.action === 'list') {
      const { data, error } = await supabaseAdmin.from('kb_tags').select('*').order('name');
      if (error) throw error;
      return res.status(200).json({ tags: data || [] });
    }

    // POST — nieuwe tag
    if (req.method === 'POST') {
      if (!(await requirePermissionFailOpen(req, 'kennisbank.item.edit'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { name, color, description } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

      const { data, error } = await supabaseAdmin.from('kb_tags')
        .insert({
          name: name.trim(),
          color: color || '#6B7280',
          description: description || null,
          created_by: auth.user.id,
        })
        .select().single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Tag bestaat al' });
        throw error;
      }
      return res.status(200).json({ tag: data });
    }

    // PATCH ?id — tag bijwerken
    if (req.method === 'PATCH' && req.query.id) {
      if (!(await requirePermissionFailOpen(req, 'kennisbank.item.edit'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { name, color, description } = req.body || {};
      const updates = {};
      if (name !== undefined) updates.name = name.trim();
      if (color !== undefined) updates.color = color;
      if (description !== undefined) updates.description = description;
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Geen velden om bij te werken' });

      const { data, error } = await supabaseAdmin.from('kb_tags')
        .update(updates).eq('id', req.query.id).select().single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Tag bestaat al' });
        throw error;
      }
      return res.status(200).json({ tag: data });
    }

    // DELETE ?id — tag verwijderen (cascade verwijdert kb_item_tags)
    if (req.method === 'DELETE' && req.query.id) {
      if (!(await requirePermissionFailOpen(req, 'kennisbank.item.delete'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { error } = await supabaseAdmin.from('kb_tags').delete().eq('id', req.query.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid request' });
  } catch (err) {
    console.error('kb-tags error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
