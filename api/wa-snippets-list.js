// api/wa-snippets-list.js
// GET → alle wa_snippets die de user mag zien (gedeeld + eigen).
// Gate: requirePermission('snippets.view').
//
// Response: { items: [{ id, titel, body_text, owner_user_id, sort_order,
//                       updated_at, is_mine, is_shared }] }
//
// Sortering: gedeeld eerst (owner_user_id NULL), dan eigen. Binnen elk
// blok op sort_order ASC, titel ASC.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'snippets.view'))) {
    return res.status(403).json({ error: 'Geen rechten (snippets.view)' });
  }

  try {
    // Query: (owner_user_id IS NULL) OR (owner_user_id = user.id).
    // BP3 (2026-09-02) — category meesturen. Bestaande rijen: category=NULL.
    const { data, error } = await supabaseAdmin
      .from('wa_snippets')
      .select('id, titel, body_text, category, owner_user_id, sort_order, updated_at')
      .or(`owner_user_id.is.null,owner_user_id.eq.${user.id}`)
      .order('owner_user_id', { ascending: true, nullsFirst: true })
      .order('sort_order', { ascending: true })
      .order('titel', { ascending: true });
    if (error) throw error;

    const items = (data || []).map((r) => ({
      ...r,
      is_mine:   r.owner_user_id === user.id,
      is_shared: r.owner_user_id === null,
    }));
    // Distinct categorieën voor picker- en form-suggesties. NULL wordt geskipt.
    const categories = [...new Set(
      (data || []).map((r) => r.category).filter((c) => typeof c === 'string' && c.trim())
    )].sort((a, b) => a.localeCompare(b, 'nl'));
    return res.status(200).json({ items, categories });
  } catch (e) {
    console.error('[wa-snippets-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
