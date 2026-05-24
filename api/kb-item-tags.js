// api/kb-item-tags.js
// N:M koppeling tussen kennisbank_items en kb_tags (migratie 004).
//   GET ?item_id=<uuid>          → tags van één item
//   GET ?action=all_with_tags    → alle koppelingen (bulk, voor frontend-map; geen N+1)
//   POST                         → koppel tag {item_id, tag_id}
//   DELETE                       → ontkoppel tag {item_id, tag_id}
//
// Auth: verifyAdmin (hard) + requirePermissionFailOpen('kennisbank.item.edit') voor schrijven.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // GET ?item_id — tags voor één item
    if (req.method === 'GET' && req.query.item_id) {
      const { data, error } = await supabaseAdmin.from('kb_item_tags')
        .select('tag_id, kb_tags(id, name, color)').eq('item_id', req.query.item_id);
      if (error) throw error;
      return res.status(200).json({ tags: (data || []).map((r) => r.kb_tags).filter(Boolean) });
    }

    // GET ?action=all_with_tags — alle koppelingen (bulk)
    if (req.method === 'GET' && req.query.action === 'all_with_tags') {
      const { data, error } = await supabaseAdmin.from('kb_item_tags').select('item_id, tag_id');
      if (error) throw error;
      return res.status(200).json({ links: data || [] });
    }

    // POST — koppel tag aan item
    if (req.method === 'POST') {
      if (!(await requirePermissionFailOpen(req, 'kennisbank.item.edit'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { item_id, tag_id } = req.body || {};
      if (!item_id || !tag_id) return res.status(400).json({ error: 'item_id + tag_id required' });

      const { error } = await supabaseAdmin.from('kb_item_tags')
        .upsert({ item_id, tag_id, added_by: auth.user.id }, { onConflict: 'item_id,tag_id' });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    // DELETE — ontkoppel tag van item
    if (req.method === 'DELETE') {
      if (!(await requirePermissionFailOpen(req, 'kennisbank.item.edit'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { item_id, tag_id } = req.body || {};
      if (!item_id || !tag_id) return res.status(400).json({ error: 'item_id + tag_id required' });
      const { error } = await supabaseAdmin.from('kb_item_tags')
        .delete().eq('item_id', item_id).eq('tag_id', tag_id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid request' });
  } catch (err) {
    console.error('kb-item-tags error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
