// api/wa-snippets-delete.js
// DELETE ?id=<uuid> — snippet verwijderen.
// Gate: requirePermission('snippets.manage').
//
// Ownership-check identiek aan wa-snippets-upsert PATCH:
// eigenaar OF gedeelde snippet mag verwijderd worden.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'DELETE only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'snippets.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (snippets.manage)' });
  }

  const id = String(req.query?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: cur } = await supabaseAdmin
      .from('wa_snippets')
      .select('id, owner_user_id')
      .eq('id', id)
      .maybeSingle();
    if (!cur) return res.status(404).json({ error: 'Snippet niet gevonden' });
    if (cur.owner_user_id !== null && cur.owner_user_id !== user.id) {
      return res.status(403).json({ error: 'Alleen de eigenaar mag deze persoonlijke snippet verwijderen' });
    }

    const { error } = await supabaseAdmin.from('wa_snippets').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true, deleted_id: id });
  } catch (e) {
    console.error('[wa-snippets-delete]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
