// api/wa-snippets-upsert.js
// POST (nieuw) / PATCH (bestaand) — een wa_snippet aanmaken of bewerken.
// Gate: requirePermission('snippets.manage').
//
// Body:
//   { id?: uuid (PATCH), titel: string 1..120, body_text: string 1..2000,
//     owner_user_id?: 'shared' | 'me' (default 'shared'), sort_order?: int }
//
// Regels:
//   - owner_user_id='shared' → NULL (gedeelde team-snippet, iedereen ziet 'em).
//   - owner_user_id='me'     → user.id (persoonlijk, alleen jij ziet 'em).
//   - Bij PATCH: alleen eigenaar (of gedeelde snippet + snippets.manage) mag
//     bewerken. Server-side check: user.id == owner_user_id OF owner IS NULL.
//   - created_by / updated_by → user.id (audit).
//
// Response: { item: { id, titel, body_text, owner_user_id, sort_order,
//                     updated_at } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'POST of PATCH only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'snippets.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (snippets.manage)' });
  }

  const body = req.body || {};
  const titel     = String(body.titel     || '').trim();
  const bodyText  = String(body.body_text || '').trim();
  const ownerFlag = String(body.owner_user_id || 'shared').toLowerCase();
  const sortRaw   = Number(body.sort_order);
  const sortOrder = Number.isFinite(sortRaw) ? Math.max(0, Math.min(9999, Math.round(sortRaw))) : 100;

  if (!titel || titel.length > 120)             return res.status(400).json({ error: 'titel vereist (1..120 chars)' });
  if (!bodyText || bodyText.length > 2000)      return res.status(400).json({ error: 'body_text vereist (1..2000 chars)' });
  if (!['shared', 'me'].includes(ownerFlag))    return res.status(400).json({ error: "owner_user_id moet 'shared' of 'me' zijn" });
  const ownerUserId = ownerFlag === 'me' ? user.id : null;

  try {
    if (req.method === 'POST') {
      // INSERT
      const { data, error } = await supabaseAdmin
        .from('wa_snippets')
        .insert({
          titel,
          body_text:     bodyText,
          owner_user_id: ownerUserId,
          sort_order:    sortOrder,
          created_by:    user.id,
          updated_by:    user.id,
        })
        .select('id, titel, body_text, owner_user_id, sort_order, updated_at')
        .maybeSingle();
      if (error) throw error;
      return res.status(200).json({ item: data });
    }

    // PATCH
    const id = String(body.id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist bij PATCH' });

    // Ownership-check: alleen eigenaar OF gedeelde snippet mag bewerken.
    const { data: cur, error: curErr } = await supabaseAdmin
      .from('wa_snippets')
      .select('id, owner_user_id')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!cur) return res.status(404).json({ error: 'Snippet niet gevonden' });
    if (cur.owner_user_id !== null && cur.owner_user_id !== user.id) {
      return res.status(403).json({ error: 'Alleen de eigenaar (of admin) mag deze persoonlijke snippet bewerken' });
    }

    const { data, error } = await supabaseAdmin
      .from('wa_snippets')
      .update({
        titel,
        body_text:     bodyText,
        owner_user_id: ownerUserId,
        sort_order:    sortOrder,
        updated_by:    user.id,
      })
      .eq('id', id)
      .select('id, titel, body_text, owner_user_id, sort_order, updated_at')
      .maybeSingle();
    if (error) throw error;
    return res.status(200).json({ item: data });
  } catch (e) {
    console.error('[wa-snippets-upsert]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
